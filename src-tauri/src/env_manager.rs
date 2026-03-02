use futures_util::StreamExt;
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", content = "data")]
pub enum EnvStatus {
    NotInitialized,
    PythonMissing,
    DownloadingPython(f32),
    ExtractingPython,
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

    fn get_base_dir(&self) -> PathBuf {
        self.app_handle
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
    }

    fn get_venv_path(&self) -> PathBuf {
        self.get_base_dir().join(".venv")
    }

    fn get_internal_python_dir(&self) -> PathBuf {
        self.get_base_dir().join("python_runtime")
    }

    fn get_runtime_home_dir(&self) -> PathBuf {
        self.get_base_dir().join("runtime_home")
    }

    fn prepare_runtime_env(&self) -> (PathBuf, PathBuf, PathBuf) {
        let runtime_home = self.get_runtime_home_dir();
        let xdg_cache_home = runtime_home.join(".cache");
        let tiktoken_cache_dir = xdg_cache_home.join("tiktoken");
        let babeldoc_cache_dir = xdg_cache_home.join("babeldoc");

        let _ = fs::create_dir_all(&runtime_home);
        let _ = fs::create_dir_all(&xdg_cache_home);
        let _ = fs::create_dir_all(&tiktoken_cache_dir);
        let _ = fs::create_dir_all(&babeldoc_cache_dir);

        (runtime_home, xdg_cache_home, tiktoken_cache_dir)
    }

    pub fn get_python_executable(&self) -> PathBuf {
        let venv_path = self.get_venv_path();

        // 优先检查 venv
        let venv_exe = if cfg!(target_os = "windows") {
            venv_path.join("Scripts").join("python.exe")
        } else {
            venv_path.join("bin").join("python")
        };

        if venv_exe.exists() {
            return venv_exe;
        }

        // 其次检查内部运行时
        if let Some(internal_exe) = self.find_internal_python() {
            return internal_exe;
        }

        let internal_dir = self.get_internal_python_dir();
        if cfg!(target_os = "windows") {
            internal_dir.join("python").join("python.exe")
        } else {
            internal_dir.join("python").join("bin").join("python3")
        }
    }

    fn find_internal_python(&self) -> Option<PathBuf> {
        let internal_dir = self.get_internal_python_dir();
        let exe_name = if cfg!(target_os = "windows") {
            "python.exe"
        } else {
            "python3"
        };

        if !internal_dir.exists() {
            return None;
        }

        for entry in walkdir::WalkDir::new(&internal_dir)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if (entry.file_type().is_file() || entry.file_type().is_symlink())
                && entry.file_name() == exe_name
            {
                let path = entry.path();
                if let Some(parent) = path.parent() {
                    let parent_name = parent.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if parent_name == "bin"
                        || parent_name == "Scripts"
                        || parent_name == "install"
                        || parent_name == "python"
                    {
                        return Some(path.to_path_buf());
                    }
                }
            }
        }
        None
    }

    pub async fn get_ready_python(&self) -> Option<PathBuf> {
        let python_path = self.get_python_executable();
        if python_path.exists()
            && self.check_python_version(&python_path).await
            && self.check_python_module(&python_path).await
        {
            return Some(python_path);
        }

        // 检查系统 python
        let sys_python = if cfg!(target_os = "windows") {
            PathBuf::from("python")
        } else {
            PathBuf::from("python3")
        };

        if self.check_python_version(&sys_python).await
            && self.check_python_module(&sys_python).await
        {
            return Some(sys_python);
        }

        None
    }

    async fn check_python_version(&self, python_path: &Path) -> bool {
        let output = Command::new(python_path).arg("--version").output().await;

        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            Self::python_version_supported(&stdout, &stderr)
        } else {
            false
        }
    }

    fn python_version_supported(stdout: &str, stderr: &str) -> bool {
        let merged = format!("{stdout}\n{stderr}");
        // 匹配 Python 3.10, 3.11, 3.12, 3.13 等
        let re = Regex::new(r"Python 3\.(1[0-9]|[2-9][0-9])").unwrap();
        re.is_match(&merged)
    }

    async fn check_python_module(&self, python_path: &Path) -> bool {
        let (runtime_home, xdg_cache_home, tiktoken_cache_dir) = self.prepare_runtime_env();
        let original_home =
            std::env::var("HOME").unwrap_or_else(|_| runtime_home.to_string_lossy().to_string());
        let import_probe = r#"
import importlib
import os
import platform
import sys
from pathlib import Path

def guess_user_site(home_dir: str) -> Path:
    major, minor = sys.version_info[:2]
    system = platform.system().lower()
    if system == "darwin":
        return (
            Path(home_dir)
            / "Library"
            / "Python"
            / f"{major}.{minor}"
            / "lib"
            / "python"
            / "site-packages"
        )
    if system == "windows":
        return (
            Path(home_dir)
            / "AppData"
            / "Roaming"
            / "Python"
            / f"Python{major}{minor}"
            / "site-packages"
        )
    return Path(home_dir) / ".local" / "lib" / f"python{major}.{minor}" / "site-packages"

original_home = os.environ.get("PDFMT_ORIGINAL_HOME")
if original_home:
    site_path = guess_user_site(original_home)
    if site_path.is_dir():
        site_path_str = str(site_path)
        if site_path_str not in sys.path:
            sys.path.append(site_path_str)

importlib.import_module("pdf2zh_next")
importlib.import_module("idna")
print("ok")
"#;
        let output = Command::new(python_path)
            .env("HOME", &runtime_home)
            .env("XDG_CACHE_HOME", &xdg_cache_home)
            .env("TIKTOKEN_CACHE_DIR", &tiktoken_cache_dir)
            .env("USERPROFILE", &runtime_home)
            .env("PDFMT_ORIGINAL_HOME", &original_home)
            .arg("-c")
            .arg(import_probe)
            .status()
            .await;

        matches!(output, Ok(status) if status.success())
    }

    pub async fn check_status(&self) -> EnvStatus {
        if self.get_ready_python().await.is_some() {
            EnvStatus::Ready
        } else {
            EnvStatus::NotInitialized
        }
    }

    async fn download_python_runtime(&self) -> Result<PathBuf, String> {
        let internal_dir = self.get_internal_python_dir();
        if internal_dir.exists() {
            let _ = fs::remove_dir_all(&internal_dir);
        }
        fs::create_dir_all(&internal_dir).map_err(|e| e.to_string())?;

        let urls: &[&str] = if cfg!(target_os = "windows") {
            &[
                "https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-x86_64-pc-windows-msvc-shared-install_only.tar.gz",
                "https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-x86_64-pc-windows-msvc-shared-install_runtime.tar.gz",
                "https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-x86_64-pc-windows-msvc-shared-install_runtime.tar.gz",
            ]
        } else if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                &[
                    "https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-aarch64-apple-darwin-install_only.tar.gz",
                    "https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-aarch64-apple-darwin-install_runtime.tar.gz",
                    "https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-aarch64-apple-darwin-install_runtime.tar.gz",
                ]
            } else {
                &[
                    "https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-x86_64-apple-darwin-install_only.tar.gz",
                    "https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-x86_64-apple-darwin-install_runtime.tar.gz",
                    "https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-x86_64-apple-darwin-install_runtime.tar.gz",
                ]
            }
        } else {
            return Err("不支持的操作系统".to_string());
        };
        let filename = "python.tar.gz";

        self.emit_progress("正在下载 Python 运行时...", 15);

        let client = reqwest::Client::new();
        let temp_file_path = internal_dir.join(filename);
        self.download_runtime_archive(&client, urls, &temp_file_path)
            .await?;

        self.emit_progress("正在解压 Python...", 55);
        self.extract_tar_gz(&temp_file_path, &internal_dir)?;
        let _ = fs::remove_file(temp_file_path);

        // 寻找真正的可执行文件路径
        // 动态查找以适应不同的压缩包结构
        let real_exe = match self.find_internal_python() {
            Some(path) => path,
            None => {
                return Err("解压后未能找到 Python 可执行文件".to_string());
            }
        };

        Ok(real_exe)
    }

    async fn download_runtime_archive(
        &self,
        client: &reqwest::Client,
        urls: &[&str],
        target_path: &Path,
    ) -> Result<(), String> {
        let mut errors: Vec<String> = Vec::new();

        for (idx, url) in urls.iter().enumerate() {
            self.emit_log(&format!(
                "尝试下载 Python 运行时 ({}/{})：{}",
                idx + 1,
                urls.len(),
                url
            ));

            let response = match client.get(*url).send().await {
                Ok(resp) => resp,
                Err(e) => {
                    errors.push(format!("{url} -> 网络错误: {e}"));
                    continue;
                }
            };

            if !response.status().is_success() {
                errors.push(format!("{url} -> HTTP {}", response.status()));
                continue;
            }

            let total_size = response.content_length().unwrap_or(0);
            let mut downloaded: u64 = 0;
            let mut stream = response.bytes_stream();
            let mut file = tokio::fs::File::create(target_path)
                .await
                .map_err(|e| format!("写入下载文件失败: {e}"))?;

            let mut stream_failed = false;
            while let Some(item) = stream.next().await {
                let chunk = match item {
                    Ok(c) => c,
                    Err(e) => {
                        errors.push(format!("{url} -> 下载流错误: {e}"));
                        stream_failed = true;
                        break;
                    }
                };

                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("写入下载文件失败: {e}"))?;
                downloaded += chunk.len() as u64;

                if total_size > 0 {
                    let progress = (downloaded as f32 / total_size as f32) * 100.0;
                    self.emit_progress(
                        &format!("正在下载 Python 运行时 ({:.1}%)...", progress),
                        (15.0 + progress * 0.35) as i32,
                    );
                }
            }

            file.flush()
                .await
                .map_err(|e| format!("刷新下载文件失败: {e}"))?;

            if stream_failed {
                let _ = fs::remove_file(target_path);
                continue;
            }

            match Self::validate_downloaded_archive(target_path) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    errors.push(format!("{url} -> {e}"));
                    let _ = fs::remove_file(target_path);
                }
            }
        }

        Err(format!(
            "下载 Python 运行时失败，所有镜像均不可用：{}",
            errors.join(" | ")
        ))
    }

    fn validate_downloaded_archive(path: &Path) -> Result<(), String> {
        let data = fs::read(path).map_err(|e| format!("读取下载文件失败: {e}"))?;

        if data.len() < 1024 {
            let preview = String::from_utf8_lossy(&data).replace(['\n', '\r'], " ");
            return Err(format!(
                "下载文件过小({} bytes)，可能是错误页面。内容预览: {}",
                data.len(),
                preview
            ));
        }

        if !Self::is_gzip_header(&data) {
            let preview =
                String::from_utf8_lossy(&data[..data.len().min(64)]).replace(['\n', '\r'], " ");
            return Err(format!(
                "下载文件不是 gzip 压缩包，可能是下载链接失效。文件头预览: {}",
                preview
            ));
        }

        Ok(())
    }

    fn is_gzip_header(data: &[u8]) -> bool {
        data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b
    }

    fn extract_tar_gz(&self, archive_path: &Path, target_dir: &Path) -> Result<(), String> {
        let tar_gz = fs::File::open(archive_path).map_err(|e| e.to_string())?;
        let tar = flate2::read::GzDecoder::new(tar_gz);

        let mut archive = tar::Archive::new(tar);
        archive
            .unpack(target_dir)
            .map_err(|e| format!("解压失败: {e}"))?;
        Ok(())
    }

    pub async fn setup(&self) -> Result<(), String> {
        let venv_path = self.get_venv_path();
        let _ = fs::create_dir_all(venv_path.parent().unwrap());

        // 1. 寻找或下载 Python
        self.emit_progress("正在检查 Python 环境...", 5);
        let python_base = if let Some(sys_py) = self.get_ready_system_python().await {
            sys_py
        } else {
            self.download_python_runtime().await?
        };

        // 2. 创建虚拟环境
        self.emit_progress("正在准备独立运行环境 (venv)...", 65);
        let mut venv_cmd = Command::new(&python_base);
        venv_cmd.arg("-m").arg("venv").arg(&venv_path);
        if cfg!(target_os = "windows") {
            venv_cmd.arg("--copies");
        }

        let status = venv_cmd
            .status()
            .await
            .map_err(|e| format!("创建 venv 失败: {e}"))?;
        if !status.success() {
            return Err("创建 venv 失败，请确保 Python 环境完整。".to_string());
        }

        let python_executable = self.get_python_executable();
        let (runtime_home, xdg_cache_home, tiktoken_cache_dir) = self.prepare_runtime_env();
        let original_home =
            std::env::var("HOME").unwrap_or_else(|_| runtime_home.to_string_lossy().to_string());

        // 3. 安装依赖
        self.emit_progress("正在安装核心依赖 (pdf2zh-next)...", 80);
        self.install_dependencies_with_fallback(
            &python_executable,
            &runtime_home,
            &xdg_cache_home,
            &tiktoken_cache_dir,
            &original_home,
        )
        .await?;

        self.emit_progress("环境配置完成！", 100);
        Ok(())
    }

    async fn install_dependencies_with_fallback(
        &self,
        python_executable: &Path,
        runtime_home: &Path,
        xdg_cache_home: &Path,
        tiktoken_cache_dir: &Path,
        original_home: &str,
    ) -> Result<(), String> {
        let install_attempts: Vec<(&str, Vec<&str>)> = vec![
            (
                "官方 PyPI",
                vec!["-m", "pip", "install", "pdf2zh-next", "idna"],
            ),
            (
                "清华镜像",
                vec![
                    "-m",
                    "pip",
                    "install",
                    "pdf2zh-next",
                    "idna",
                    "-i",
                    "https://pypi.tuna.tsinghua.edu.cn/simple",
                    "--trusted-host",
                    "pypi.tuna.tsinghua.edu.cn",
                ],
            ),
        ];

        let mut errors: Vec<String> = Vec::new();
        for (label, args) in install_attempts {
            self.emit_log(&format!("尝试安装依赖源: {label}"));
            match self
                .run_pip_install_command(
                    python_executable,
                    runtime_home,
                    xdg_cache_home,
                    tiktoken_cache_dir,
                    original_home,
                    &args,
                )
                .await
            {
                Ok(()) => return Ok(()),
                Err(err) => {
                    errors.push(format!("{label}: {err}"));
                    self.emit_log(&format!("依赖安装失败({label}): {err}"));
                }
            }
        }

        Err(format!(
            "依赖安装失败，已尝试所有源：{}",
            errors.join(" | ")
        ))
    }

    async fn run_pip_install_command(
        &self,
        python_executable: &Path,
        runtime_home: &Path,
        xdg_cache_home: &Path,
        tiktoken_cache_dir: &Path,
        original_home: &str,
        args: &[&str],
    ) -> Result<(), String> {
        let mut cmd = Command::new(python_executable);
        cmd.env("HOME", runtime_home)
            .env("XDG_CACHE_HOME", xdg_cache_home)
            .env("TIKTOKEN_CACHE_DIR", tiktoken_cache_dir)
            .env("USERPROFILE", runtime_home)
            .env("PDFMT_ORIGINAL_HOME", original_home)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("启动 pip 失败: {e}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取 pip stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法读取 pip stderr".to_string())?;

        let mut stdout_reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();
        let mut stdout_open = true;
        let mut stderr_open = true;

        while stdout_open || stderr_open {
            tokio::select! {
                line = stdout_reader.next_line(), if stdout_open => {
                    match line {
                        Ok(Some(line)) => self.emit_log(&line),
                        Ok(None) => stdout_open = false,
                        Err(err) => {
                            stdout_open = false;
                            self.emit_log(&format!("读取 pip stdout 失败: {err}"));
                        }
                    }
                }
                line = stderr_reader.next_line(), if stderr_open => {
                    match line {
                        Ok(Some(line)) => self.emit_log(&line),
                        Ok(None) => stderr_open = false,
                        Err(err) => {
                            stderr_open = false;
                            self.emit_log(&format!("读取 pip stderr 失败: {err}"));
                        }
                    }
                }
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("等待 pip 进程失败: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("pip 退出状态: {status}"))
        }
    }

    async fn get_ready_system_python(&self) -> Option<PathBuf> {
        let candidates = if cfg!(target_os = "windows") {
            vec!["python", "python3"]
        } else {
            vec!["python3", "python"]
        };

        for cmd in candidates {
            let sys_python = PathBuf::from(cmd);
            if self.check_python_version(&sys_python).await {
                return Some(sys_python);
            }
        }
        None
    }

    fn emit_progress(&self, message: &str, progress: i32) {
        let _ = self.app_handle.emit(
            "env-setup-progress",
            serde_json::json!({
                "message": message,
                "progress": progress
            }),
        );
    }

    fn emit_log(&self, line: &str) {
        let _ = self.app_handle.emit("env-setup-log", line);
    }
}

#[cfg(test)]
mod tests {
    use super::EnvManager;

    #[test]
    fn detect_gzip_header() {
        assert!(EnvManager::is_gzip_header(&[0x1f, 0x8b, 0x08]));
        assert!(!EnvManager::is_gzip_header(b"Not Found"));
    }

    #[test]
    fn python_version_can_be_detected_from_stderr() {
        assert!(EnvManager::python_version_supported("", "Python 3.12.1"));
    }

    #[test]
    fn python_version_rejects_unsupported_major_minor() {
        assert!(!EnvManager::python_version_supported("Python 3.9.18", ""));
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
