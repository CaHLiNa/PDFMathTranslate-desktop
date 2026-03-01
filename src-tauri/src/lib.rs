mod env_manager;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<FileNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationTask {
    id: String,
    input_path: String,
    status: String,
    progress: f32,
    message: String,
    mono_output: Option<String>,
    dual_output: Option<String>,
    started_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationRequest {
    input_path: String,
    output_dir: String,
    lang_in: String,
    lang_out: String,
    engine: String,
    api_key: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    mode: String,
    python_cmd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslationProgressPayload {
    task_id: String,
    task: TranslationTask,
    raw_event: Option<Value>,
    raw_line: Option<String>,
}

#[derive(Clone, Default)]
struct AppState {
    tasks: Arc<Mutex<HashMap<String, TranslationTask>>>,
    child_pids: Arc<Mutex<HashMap<String, u32>>>,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .map(|v| v.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

fn collect_tree(path: &Path) -> Result<Option<FileNode>, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("读取路径失败: {e}"))?;

    if metadata.is_file() {
        if !is_pdf(path) {
            return Ok(None);
        }
        return Ok(Some(FileNode {
            name: path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or_default()
                .to_string(),
            path: path.to_string_lossy().to_string(),
            is_dir: false,
            children: Vec::new(),
        }));
    }

    let mut children = Vec::new();
    let entries = fs::read_dir(path).map_err(|e| format!("读取目录失败: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let child_path = entry.path();
        if let Some(node) = collect_tree(&child_path)? {
            children.push(node);
        }
    }

    if children.is_empty() {
        return Ok(None);
    }

    children.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return b.is_dir.cmp(&a.is_dir);
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    let dir_name = path
        .file_name()
        .and_then(|v| v.to_str())
        .map(|v| v.to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    Ok(Some(FileNode {
        name: dir_name,
        path: path.to_string_lossy().to_string(),
        is_dir: true,
        children,
    }))
}

fn update_task<F>(state: &AppState, task_id: &str, mutator: F) -> Option<TranslationTask>
where
    F: FnOnce(&mut TranslationTask),
{
    let mut guard = state.tasks.lock().ok()?;
    let task = guard.get_mut(task_id)?;
    mutator(task);
    task.updated_at = now_iso();
    Some(task.clone())
}

fn emit_task(app: &AppHandle, task_id: &str, task: TranslationTask, event: Option<Value>, line: Option<String>) {
    let payload = TranslationProgressPayload {
        task_id: task_id.to_string(),
        task,
        raw_event: event,
        raw_line: line,
    };
    let _ = app.emit("translation-progress", payload);
}

fn resolve_script_path() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let candidates = [
        cwd.join("scripts/translate_stream.py"),
        cwd.join("../scripts/translate_stream.py"),
        cwd.join("../../scripts/translate_stream.py"),
    ];

    candidates.into_iter().find(|path| path.exists())
}

fn fallback_output_paths(input_path: &str, output_dir: &str, lang_out: &str) -> (Option<String>, Option<String>) {
    let stem = Path::new(input_path)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("translated")
        .to_string();

    let mono_guess = Path::new(output_dir).join(format!("{stem}.{lang_out}.mono.pdf"));
    let dual_guess = Path::new(output_dir).join(format!("{stem}.{lang_out}.dual.pdf"));

    let mono = if mono_guess.exists() {
        Some(mono_guess.to_string_lossy().to_string())
    } else {
        None
    };
    let dual = if dual_guess.exists() {
        Some(dual_guess.to_string_lossy().to_string())
    } else {
        None
    };

    (mono, dual)
}

fn keep_output_inside_dir(path: Option<String>, output_dir: &str) -> Option<String> {
    let source = PathBuf::from(path?);
    if !source.exists() {
        return None;
    }

    let out_dir = Path::new(output_dir);
    if fs::create_dir_all(out_dir).is_err() {
        return Some(source.to_string_lossy().to_string());
    }

    if source
        .parent()
        .map(|p| p == out_dir)
        .unwrap_or(false)
    {
        return Some(source.to_string_lossy().to_string());
    }

    let filename = source.file_name()?.to_string_lossy().to_string();
    let target = out_dir.join(filename);

    if target != source && fs::copy(&source, &target).is_err() {
        return Some(source.to_string_lossy().to_string());
    }

    Some(target.to_string_lossy().to_string())
}

fn to_progress(event: &Value) -> Option<f32> {
    event
        .get("overall_progress")
        .and_then(|v| v.as_f64())
        .map(|v| v.clamp(0.0, 100.0) as f32)
}

fn to_message(event: &Value) -> String {
    event
        .get("stage")
        .and_then(|v| v.as_str())
        .or_else(|| event.get("error").and_then(|v| v.as_str()))
        .unwrap_or("处理中")
        .to_string()
}

async fn run_translation_task(app: AppHandle, state: AppState, task_id: String, request: TranslationRequest) {
    let Some(task) = update_task(&state, &task_id, |task| {
        task.status = "running".to_string();
        task.message = "启动翻译进程".to_string();
        task.progress = 1.0;
    }) else {
        return;
    };
    emit_task(&app, &task_id, task, None, None);

    let Some(script_path) = resolve_script_path() else {
        if let Some(task) = update_task(&state, &task_id, |task| {
            task.status = "failed".to_string();
            task.message = "未找到 scripts/translate_stream.py".to_string();
        }) {
            emit_task(&app, &task_id, task, None, None);
        }
        return;
    };

    let _ = fs::create_dir_all(&request.output_dir);

    let python = if let Some(cmd) = request.python_cmd.as_ref().filter(|v| !v.trim().is_empty()) {
        cmd.clone()
    } else {
        let env_manager = env_manager::EnvManager::new(app.clone());
        if let Some(py) = env_manager.get_ready_python().await {
            py.to_string_lossy().to_string()
        } else {
            if cfg!(target_os = "windows") {
                "python".to_string()
            } else {
                "python3".to_string()
            }
        }
    };



    let mut cmd = Command::new(python);
    cmd.arg(script_path)
        .arg("--input")
        .arg(&request.input_path)
        .arg("--output")
        .arg(&request.output_dir)
        .arg("--lang-in")
        .arg(&request.lang_in)
        .arg("--lang-out")
        .arg(&request.lang_out)
        .arg("--engine")
        .arg(&request.engine)
        .arg("--mode")
        .arg(&request.mode)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(api_key) = request.api_key.as_ref().filter(|v| !v.trim().is_empty()) {
        cmd.arg("--api-key").arg(api_key);
    }
    if let Some(model) = request.model.as_ref().filter(|v| !v.trim().is_empty()) {
        cmd.arg("--model").arg(model);
    }
    if let Some(base_url) = request.base_url.as_ref().filter(|v| !v.trim().is_empty()) {
        cmd.arg("--base-url").arg(base_url);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            if let Some(task) = update_task(&state, &task_id, |task| {
                task.status = "failed".to_string();
                task.message = format!("启动失败: {err}");
            }) {
                emit_task(&app, &task_id, task, None, None);
            }
            return;
        }
    };

    if let Some(pid) = child.id() {
        if let Ok(mut guard) = state.child_pids.lock() {
            guard.insert(task_id.clone(), pid);
        }
    }

    let stderr_task_id = task_id.clone();
    let stderr_state = state.clone();
    let stderr_app = app.clone();

    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if let Some(task) = update_task(&stderr_state, &stderr_task_id, |task| {
                    if task.status == "running" {
                        task.message = line.clone();
                    }
                }) {
                    emit_task(&stderr_app, &stderr_task_id, task, None, Some(line));
                }
            }
        });
    }

    let mut completed = false;

    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                let event_type = event
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");

                if let Some(task) = update_task(&state, &task_id, |task| {
                    match event_type {
                        "progress_start" | "progress_update" | "progress_end" => {
                            task.progress = to_progress(&event).unwrap_or(task.progress);
                            task.message = to_message(&event);
                            task.status = "running".to_string();
                        }
                        "error" => {
                            task.status = "failed".to_string();
                            task.progress = task.progress.max(1.0);
                            task.message = to_message(&event);
                        }
                        "finish" => {
                            task.status = "completed".to_string();
                            task.progress = 100.0;
                            task.message = "翻译完成".to_string();

                            if let Some(result) = event.get("translate_result") {
                                task.mono_output = result
                                    .get("mono_pdf_path")
                                    .and_then(|v| v.as_str())
                                    .map(|v| v.to_string())
                                    .or_else(|| {
                                        result
                                            .get("no_watermark_mono_pdf_path")
                                            .and_then(|v| v.as_str())
                                            .map(|v| v.to_string())
                                    });

                                task.dual_output = result
                                    .get("dual_pdf_path")
                                    .and_then(|v| v.as_str())
                                    .map(|v| v.to_string())
                                    .or_else(|| {
                                        result
                                            .get("no_watermark_dual_pdf_path")
                                            .and_then(|v| v.as_str())
                                            .map(|v| v.to_string())
                                    });
                            }

                            if task.mono_output.is_none() && task.dual_output.is_none() {
                                let (mono, dual) = fallback_output_paths(
                                    &request.input_path,
                                    &request.output_dir,
                                    &request.lang_out,
                                );
                                task.mono_output = mono;
                                task.dual_output = dual;
                            }

                            let normalized_mono =
                                keep_output_inside_dir(task.mono_output.clone(), &request.output_dir);
                            let normalized_dual =
                                keep_output_inside_dir(task.dual_output.clone(), &request.output_dir);

                            if normalized_mono.is_some() {
                                task.mono_output = normalized_mono;
                            }
                            if normalized_dual.is_some() {
                                task.dual_output = normalized_dual;
                            }
                        }
                        _ => {}
                    }
                }) {
                    if event_type == "finish" {
                        completed = true;
                    }
                    emit_task(&app, &task_id, task, Some(event), Some(line));
                }
            } else if let Some(task) = update_task(&state, &task_id, |task| {
                if task.status == "running" {
                    task.message = line.clone();
                }
            }) {
                emit_task(&app, &task_id, task, None, Some(line));
            }
        }
    }

    let wait_result = child.wait().await;

    if let Ok(mut guard) = state.child_pids.lock() {
        guard.remove(&task_id);
    }

    if !completed {
        match wait_result {
            Ok(status) if status.success() => {
                if let Some(task) = update_task(&state, &task_id, |task| {
                    if task.status == "running" {
                        task.status = "completed".to_string();
                        task.progress = 100.0;
                        task.message = "翻译完成".to_string();

                        let (mono, dual) = fallback_output_paths(
                            &request.input_path,
                            &request.output_dir,
                            &request.lang_out,
                        );
                        task.mono_output = task.mono_output.clone().or(mono);
                        task.dual_output = task.dual_output.clone().or(dual);

                        let normalized_mono =
                            keep_output_inside_dir(task.mono_output.clone(), &request.output_dir);
                        let normalized_dual =
                            keep_output_inside_dir(task.dual_output.clone(), &request.output_dir);
                        if normalized_mono.is_some() {
                            task.mono_output = normalized_mono;
                        }
                        if normalized_dual.is_some() {
                            task.dual_output = normalized_dual;
                        }
                    }
                }) {
                    emit_task(&app, &task_id, task, None, None);
                }
            }
            Ok(status) => {
                if let Some(task) = update_task(&state, &task_id, |task| {
                    if task.status == "running" {
                        task.status = "failed".to_string();
                        task.message = format!("进程退出码: {}", status);
                    }
                }) {
                    emit_task(&app, &task_id, task, None, None);
                }
            }
            Err(err) => {
                if let Some(task) = update_task(&state, &task_id, |task| {
                    if task.status == "running" {
                        task.status = "failed".to_string();
                        task.message = format!("等待子进程失败: {err}");
                    }
                }) {
                    emit_task(&app, &task_id, task, None, None);
                }
            }
        }
    }
}

#[tauri::command]
fn list_pdf_tree(root: String) -> Result<Vec<FileNode>, String> {
    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Err("目录不存在".to_string());
    }

    let mut out = Vec::new();
    let entries = fs::read_dir(root_path).map_err(|e| format!("读取目录失败: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let path = entry.path();
        if let Some(node) = collect_tree(&path)? {
            out.push(node);
        }
    }

    out.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return b.is_dir.cmp(&a.is_dir);
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    Ok(out)
}

#[tauri::command]
fn read_pdf_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取 PDF 失败: {e}"))?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
fn list_tasks(state: State<'_, AppState>) -> Result<Vec<TranslationTask>, String> {
    let guard = state
        .tasks
        .lock()
        .map_err(|_| "任务状态被锁定，无法读取".to_string())?;

    let mut tasks: Vec<TranslationTask> = guard.values().cloned().collect();
    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(tasks)
}

#[tauri::command]
fn start_translation(
    app: AppHandle,
    state: State<'_, AppState>,
    request: TranslationRequest,
) -> Result<TranslationTask, String> {
    let task_id = Uuid::new_v4().to_string();
    let now = now_iso();

    let task = TranslationTask {
        id: task_id.clone(),
        input_path: request.input_path.clone(),
        status: "queued".to_string(),
        progress: 0.0,
        message: "任务已创建".to_string(),
        mono_output: None,
        dual_output: None,
        started_at: now.clone(),
        updated_at: now,
    };

    {
        let mut guard = state
            .tasks
            .lock()
            .map_err(|_| "任务状态被锁定，无法创建任务".to_string())?;
        guard.insert(task_id.clone(), task.clone());
    }

    let local_state = state.inner().clone();
    let local_app = app.clone();
    let local_task_id = task_id;

    tauri::async_runtime::spawn(async move {
        run_translation_task(local_app, local_state, local_task_id, request).await;
    });

    Ok(task)
}

#[tauri::command]
async fn cancel_translation(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<bool, String> {
    let pid = {
        let mut guard = state
            .child_pids
            .lock()
            .map_err(|_| "任务 PID 状态被锁定".to_string())?;
        guard.remove(&task_id)
    };

    let Some(pid) = pid else {
        return Ok(false);
    };

    #[cfg(target_os = "windows")]
    let status = Command::new("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/F")
        .arg("/T")
        .status()
        .await
        .map_err(|e| format!("取消任务失败: {e}"))?;

    #[cfg(not(target_os = "windows"))]
    let status = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
        .await
        .map_err(|e| format!("取消任务失败: {e}"))?;

    if let Some(task) = update_task(state.inner(), &task_id, |task| {
        task.status = "canceled".to_string();
        task.message = "用户取消任务".to_string();
    }) {
        emit_task(&app, &task_id, task, None, None);
    }

    Ok(status.success())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_pdf_tree,
            read_pdf_base64,
            list_tasks,
            start_translation,
            cancel_translation,
            env_manager::check_env_status,
            env_manager::setup_env
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
