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
use tauri::{AppHandle, Emitter, Manager, State};
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
    qps: Option<u32>,
    primary_font_family: Option<String>,
    use_alternating_pages_dual: Option<bool>,
    ocr_workaround: Option<bool>,
    auto_enable_ocr_workaround: Option<bool>,
    no_watermark_mode: Option<bool>,
    save_auto_extracted_glossary: Option<bool>,
    no_auto_extract_glossary: Option<bool>,
    enhance_compatibility: Option<bool>,
    translate_table_text: Option<bool>,
    only_include_translated_page: Option<bool>,
    mode: String,
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

fn emit_task(
    app: &AppHandle,
    task_id: &str,
    task: TranslationTask,
    event: Option<Value>,
    line: Option<String>,
) {
    let payload = TranslationProgressPayload {
        task_id: task_id.to_string(),
        task,
        raw_event: event,
        raw_line: line,
    };
    let _ = app.emit("translation-progress", payload);
}

fn resource_script_candidates(resource_dir: &Path) -> [PathBuf; 3] {
    [
        resource_dir.join("scripts").join("translate_stream.py"),
        resource_dir
            .join("_up_")
            .join("scripts")
            .join("translate_stream.py"),
        resource_dir.join("translate_stream.py"),
    ]
}

fn resolve_script_path(app: &AppHandle) -> Option<PathBuf> {
    // 1. 尝试从 Tauri 资源目录获取 (用于打包后的环境)
    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in resource_script_candidates(&resource_dir) {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 2. 尝试从当前工作目录获取 (用于开发环境)
    let cwd = std::env::current_dir().ok()?;
    let candidates = [
        cwd.join("scripts/translate_stream.py"),
        cwd.join("../scripts/translate_stream.py"),
        cwd.join("../../scripts/translate_stream.py"),
    ];

    candidates.into_iter().find(|path| path.exists())
}

fn runtime_env_dirs(app: &AppHandle) -> (PathBuf, PathBuf, PathBuf) {
    let base_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let runtime_home = base_dir.join("runtime_home");
    let xdg_cache_home = runtime_home.join(".cache");
    let tiktoken_cache_dir = xdg_cache_home.join("tiktoken");
    let babeldoc_cache_dir = xdg_cache_home.join("babeldoc");

    let _ = fs::create_dir_all(&runtime_home);
    let _ = fs::create_dir_all(&xdg_cache_home);
    let _ = fs::create_dir_all(&tiktoken_cache_dir);
    let _ = fs::create_dir_all(&babeldoc_cache_dir);

    (runtime_home, xdg_cache_home, tiktoken_cache_dir)
}

fn apply_runtime_env(cmd: &mut Command, app: &AppHandle) {
    let (runtime_home, xdg_cache_home, tiktoken_cache_dir) = runtime_env_dirs(app);
    let original_home =
        std::env::var("HOME").unwrap_or_else(|_| runtime_home.to_string_lossy().to_string());
    cmd.env("HOME", &runtime_home)
        .env("XDG_CACHE_HOME", &xdg_cache_home)
        .env("TIKTOKEN_CACHE_DIR", &tiktoken_cache_dir)
        .env("USERPROFILE", &runtime_home)
        .env("PDFMT_ORIGINAL_HOME", original_home);
}

fn fallback_output_paths(
    input_path: &str,
    output_dir: &str,
    lang_out: &str,
) -> (Option<String>, Option<String>) {
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

    if source.parent().map(|p| p == out_dir).unwrap_or(false) {
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
    if let Some(overall) = event.get("overall_progress").and_then(|v| v.as_f64()) {
        return Some(overall.clamp(0.0, 100.0) as f32);
    }

    event
        .get("stage_progress")
        .and_then(|v| v.as_f64())
        .map(|stage| {
            // Fallback for old/new event payloads without overall_progress.
            // Map stage progress into a conservative 5~95 range to avoid regressing UI progress.
            let normalized = stage.clamp(0.0, 100.0) as f32;
            5.0 + normalized * 0.9
        })
}

fn to_message(event: &Value) -> String {
    event
        .get("stage")
        .and_then(|v| v.as_str())
        .or_else(|| event.get("error").and_then(|v| v.as_str()))
        .unwrap_or("处理中")
        .to_string()
}

fn resolve_task_outputs(task: &mut TranslationTask, request: &TranslationRequest) {
    if task.mono_output.is_none() && task.dual_output.is_none() {
        let (mono, dual) =
            fallback_output_paths(&request.input_path, &request.output_dir, &request.lang_out);
        task.mono_output = mono;
        task.dual_output = dual;
    }

    task.mono_output = keep_output_inside_dir(task.mono_output.clone(), &request.output_dir);
    task.dual_output = keep_output_inside_dir(task.dual_output.clone(), &request.output_dir);
}

fn has_translation_outputs(task: &TranslationTask) -> bool {
    task.mono_output.is_some() || task.dual_output.is_some()
}

async fn run_translation_task(
    app: AppHandle,
    state: AppState,
    task_id: String,
    request: TranslationRequest,
) {
    let Some(task) = update_task(&state, &task_id, |task| {
        task.status = "running".to_string();
        task.message = "启动翻译进程".to_string();
        task.progress = 1.0;
    }) else {
        return;
    };
    emit_task(&app, &task_id, task, None, None);

    let Some(script_path) = resolve_script_path(&app) else {
        if let Some(task) = update_task(&state, &task_id, |task| {
            task.status = "failed".to_string();
            task.message = "未找到 translate_stream.py（已检查资源目录与开发目录）".to_string();
        }) {
            emit_task(&app, &task_id, task, None, None);
        }
        return;
    };

    let _ = fs::create_dir_all(&request.output_dir);

    let env_manager = env_manager::EnvManager::new(app.clone());
    let python = if let Some(py) = env_manager.get_ready_python().await {
        py.to_string_lossy().to_string()
    } else {
        if let Some(task) = update_task(&state, &task_id, |task| {
            task.status = "failed".to_string();
            task.message =
                "Python 环境未就绪（缺少 pdf2zh-next 或 idna）。请在界面中先执行环境自动配置。"
                    .to_string();
        }) {
            emit_task(&app, &task_id, task, None, None);
        }
        return;
    };
    let mut cmd = Command::new(&python);
    apply_runtime_env(&mut cmd, &app);
    cmd.arg(&script_path)
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
        cmd.arg("--api-key").arg(api_key.trim());
    }
    if let Some(model) = request.model.as_ref().filter(|v| !v.trim().is_empty()) {
        cmd.arg("--model").arg(model.trim());
    }
    if let Some(base_url) = request.base_url.as_ref().filter(|v| !v.trim().is_empty()) {
        cmd.arg("--base-url").arg(base_url.trim());
    }
    if let Some(qps) = request.qps.filter(|v| *v > 0) {
        cmd.arg("--qps").arg(qps.to_string());
    }
    if let Some(primary_font_family) = request
        .primary_font_family
        .as_ref()
        .filter(|v| !v.trim().is_empty())
    {
        cmd.arg("--primary-font-family")
            .arg(primary_font_family.trim());
    }
    if let Some(use_alternating_pages_dual) = request.use_alternating_pages_dual {
        cmd.arg("--use-alternating-pages-dual")
            .arg(use_alternating_pages_dual.to_string());
    }
    if let Some(ocr_workaround) = request.ocr_workaround {
        cmd.arg("--ocr-workaround").arg(ocr_workaround.to_string());
    }
    if let Some(auto_enable_ocr_workaround) = request.auto_enable_ocr_workaround {
        cmd.arg("--auto-enable-ocr-workaround")
            .arg(auto_enable_ocr_workaround.to_string());
    }
    if let Some(no_watermark_mode) = request.no_watermark_mode {
        cmd.arg("--no-watermark-mode")
            .arg(no_watermark_mode.to_string());
    }
    if let Some(save_auto_extracted_glossary) = request.save_auto_extracted_glossary {
        cmd.arg("--save-auto-extracted-glossary")
            .arg(save_auto_extracted_glossary.to_string());
    }
    if let Some(no_auto_extract_glossary) = request.no_auto_extract_glossary {
        cmd.arg("--no-auto-extract-glossary")
            .arg(no_auto_extract_glossary.to_string());
    }
    if let Some(enhance_compatibility) = request.enhance_compatibility {
        cmd.arg("--enhance-compatibility")
            .arg(enhance_compatibility.to_string());
    }
    if let Some(translate_table_text) = request.translate_table_text {
        cmd.arg("--translate-table-text")
            .arg(translate_table_text.to_string());
    }
    if let Some(only_include_translated_page) = request.only_include_translated_page {
        cmd.arg("--only-include-translated-page")
            .arg(only_include_translated_page.to_string());
    }

    println!("DEBUG: Executing translation command:");
    println!("  Python: {}", python);
    println!("  Script: {}", script_path.display());
    println!(
        "  Engine: {} | Mode: {} | Lang: {} -> {}",
        request.engine, request.mode, request.lang_in, request.lang_out
    );
    println!("  Output: {}", request.output_dir);

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

                if let Some(task) = update_task(&state, &task_id, |task| match event_type {
                    "progress_start" | "progress_update" | "progress_end" => {
                        if let Some(progress) = to_progress(&event) {
                            task.progress = task.progress.max(progress);
                        }
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

                        resolve_task_outputs(task, &request);
                    }
                    _ => {}
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
                        resolve_task_outputs(task, &request);
                        if has_translation_outputs(task) {
                            task.status = "completed".to_string();
                            task.progress = 100.0;
                            task.message = "翻译完成".to_string();
                        } else {
                            task.status = "failed".to_string();
                            task.progress = task.progress.max(1.0);
                            task.message =
                                "翻译进程已结束，但未收到完成事件且未检测到输出文件。请检查 API 配置、网络或任务日志。"
                                    .to_string();
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

#[cfg(test)]
mod tests {
    use super::{
        has_translation_outputs, now_iso, resolve_task_outputs, resource_script_candidates,
        to_progress, TranslationRequest, TranslationTask,
    };
    use serde_json::json;
    use std::path::{Path, PathBuf};
    use tempfile::tempdir;

    fn build_request(input_path: &Path, output_dir: &Path) -> TranslationRequest {
        TranslationRequest {
            input_path: input_path.to_string_lossy().to_string(),
            output_dir: output_dir.to_string_lossy().to_string(),
            lang_in: "en".to_string(),
            lang_out: "zh".to_string(),
            engine: "OpenAI".to_string(),
            api_key: None,
            model: None,
            base_url: None,
            qps: None,
            primary_font_family: None,
            use_alternating_pages_dual: None,
            ocr_workaround: None,
            auto_enable_ocr_workaround: None,
            no_watermark_mode: None,
            save_auto_extracted_glossary: None,
            no_auto_extract_glossary: None,
            enhance_compatibility: None,
            translate_table_text: None,
            only_include_translated_page: None,
            mode: "both".to_string(),
        }
    }

    fn build_task(mono_output: Option<PathBuf>, dual_output: Option<PathBuf>) -> TranslationTask {
        let now = now_iso();
        TranslationTask {
            id: "task-test".to_string(),
            input_path: "/tmp/input.pdf".to_string(),
            status: "running".to_string(),
            progress: 1.0,
            message: "running".to_string(),
            mono_output: mono_output.map(|v| v.to_string_lossy().to_string()),
            dual_output: dual_output.map(|v| v.to_string_lossy().to_string()),
            started_at: now.clone(),
            updated_at: now,
        }
    }

    #[test]
    fn resource_script_candidates_cover_packaged_layouts() {
        let resource_dir = Path::new("/tmp/resources");
        let candidates = resource_script_candidates(resource_dir);

        assert_eq!(
            candidates[0],
            resource_dir.join("scripts").join("translate_stream.py")
        );
        assert_eq!(
            candidates[1],
            resource_dir
                .join("_up_")
                .join("scripts")
                .join("translate_stream.py")
        );
        assert_eq!(candidates[2], resource_dir.join("translate_stream.py"));
    }

    #[test]
    fn to_progress_reads_overall_progress() {
        let event = json!({ "overall_progress": 27.5 });
        assert_eq!(to_progress(&event), Some(27.5));
    }

    #[test]
    fn to_progress_falls_back_to_stage_progress() {
        let event = json!({ "stage_progress": 50.0 });
        assert_eq!(to_progress(&event), Some(50.0));
    }

    #[test]
    fn resolve_task_outputs_removes_missing_paths() {
        let temp = tempdir().expect("create tempdir");
        let input = temp.path().join("doc.pdf");
        std::fs::write(&input, b"pdf").expect("write input");
        let missing = temp.path().join("missing.mono.pdf");
        let request = build_request(&input, temp.path());
        let mut task = build_task(Some(missing), None);

        resolve_task_outputs(&mut task, &request);
        assert!(!has_translation_outputs(&task));
    }

    #[test]
    fn resolve_task_outputs_uses_existing_fallback_output() {
        let temp = tempdir().expect("create tempdir");
        let input = temp.path().join("doc.pdf");
        std::fs::write(&input, b"pdf").expect("write input");
        let mono = temp.path().join("doc.zh.mono.pdf");
        std::fs::write(&mono, b"translated").expect("write mono output");

        let request = build_request(&input, temp.path());
        let mut task = build_task(None, None);
        resolve_task_outputs(&mut task, &request);

        assert!(has_translation_outputs(&task));
        assert_eq!(
            task.mono_output.as_deref(),
            Some(mono.to_string_lossy().as_ref())
        );
    }
}
