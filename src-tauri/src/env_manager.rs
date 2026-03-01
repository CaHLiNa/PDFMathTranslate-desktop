use std::path::{Path, PathBuf};
use tokio::process::Command;
use std::process::Stdio;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", content = "data")]
pub enum EnvStatus {
    NotInitialized,
    PythonMissing,
    VenvCreating,
    InstallingDependencies,
    Ready,
    Error(String),
}

pub struct EnvManager {
    app_handle: AppHandle,
}

impl EnvManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }

    fn get_venv_path(&self) -> PathBuf {
        self.app_handle
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join(".venv")
    }

    pub fn get_python_executable(&self) -> PathBuf {
        let venv_path = self.get_venv_path();
        #[cfg(target_os = "windows")]
        {
            venv_path.join("Scripts").join("python.exe")
        }
        #[cfg(not(target_os = "windows"))]
        {
            venv_path.join("bin").join("python")
        }
    }

    pub async fn get_ready_python(&self) -> Option<PathBuf> {
        // 1. 检查私有 venv
        let venv_python = self.get_python_executable();
        if venv_python.exists() && self.check_python_module(&venv_python).await {
            return Some(venv_python);
        }

        // 2. 检查系统 python
        let sys_python = if cfg!(target_os = "windows") {
            PathBuf::from("python")
        } else {
            PathBuf::from("python3")
        };

        if self.check_python_module(&sys_python).await {
            return Some(sys_python);
        }

        None
    }

    async fn check_python_module(&self, python_path: &Path) -> bool {
        let output = Command::new(python_path)
            .arg("-c")
            .arg("import pdf2zh_next; print('ok')")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        match output {
            Ok(child) => {
                let res = child.wait_with_output().await;
                if let Ok(out) = res {
                    out.status.success()
                } else {
                    false
                }
            }
            Err(_) => false,
        }
    }

    pub async fn check_status(&self) -> EnvStatus {
        if self.get_ready_python().await.is_some() {
            EnvStatus::Ready
        } else {
            EnvStatus::NotInitialized
        }
    }


    pub async fn setup(&self) -> Result<(), String> {
        let venv_path = self.get_venv_path();
        let config_dir = venv_path.parent().unwrap();
        std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;

        // 1. 检查系统 Python
        self.emit_progress("正在检查系统 Python...", 10);
        let py_cmd = if cfg!(target_os = "windows") { "python" } else { "python3" };
        let check_py = Command::new(py_cmd).arg("--version").output().await;
        if check_py.is_err() {
            return Err("未在系统中找到 Python3，请先安装 Python。".to_string());
        }

        // 2. 创建虚拟环境
        self.emit_progress("正在创建虚拟环境 (venv)...", 30);
        let status = Command::new(py_cmd)
            .arg("-m")
            .arg("venv")
            .arg(&venv_path)
            .status()
            .await
            .map_err(|e| format!("创建 venv 失败: {e}"))?;

        if !status.success() {
            return Err("创建 venv 失败，请检查 Python 是否支持 venv 模块。".to_string());
        }

        // 3. 安装依赖
        self.emit_progress("正在安装 pdf2zh-next 及其依赖 (这可能需要几分钟)...", 60);
        let pip_path = if cfg!(target_os = "windows") {
            venv_path.join("Scripts").join("pip.exe")
        } else {
            venv_path.join("bin").join("pip")
        };

        let mut child = Command::new(pip_path)
            .arg("install")
            .arg("pdf2zh-next")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动 pip 失败: {e}"))?;

        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout).lines();

        while let Ok(Some(line)) = reader.next_line().await {
            // 将 pip 输出发送到前端供调试
            self.emit_log(&line);
        }

        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("安装依赖失败，请检查网络连接。".to_string());
        }

        self.emit_progress("环境配置完成！", 100);
        Ok(())
    }

    fn emit_progress(&self, message: &str, progress: i32) {
        let _ = self.app_handle.emit("env-setup-progress", serde_json::json!({
            "message": message,
            "progress": progress
        }));
    }

    fn emit_log(&self, line: &str) {
        let _ = self.app_handle.emit("env-setup-log", line);
    }
}

#[tauri::command]
pub async fn check_env_status(app: AppHandle) -> EnvStatus {
    EnvManager::new(app).check_status().await
}

#[tauri::command]
pub async fn setup_env(app: AppHandle) -> Result<(), String> {
    EnvManager::new(app).setup().await
}
