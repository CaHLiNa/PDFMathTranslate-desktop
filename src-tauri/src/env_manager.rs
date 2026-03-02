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
        let internal_dir = self.get_internal_python_dir();
        if cfg!(target_os = "windows") {
            internal_dir.join("python.exe")
        } else {
            internal_dir.join("bin").join("python3")
        }
    }

    pub async fn get_ready_python(&self) -> Option<PathBuf> {
        let python_path = self.get_python_executable();
        if python_path.exists() && self.check_python_version(&python_path).await && self.check_python_module(&python_path).await {
            return Some(python_path);
        }

        // 检查系统 python
        let sys_python = if cfg!(target_os = "windows") {
            PathBuf::from("python")
        } else {
            PathBuf::from("python3")
        };

        if self.check_python_version(&sys_python).await && self.check_python_module(&sys_python).await {
            return Some(sys_python);
        }

        None
    }

    async fn check_python_version(&self, python_path: &Path) -> bool {
        let output = Command::new(python_path)
            .arg("--version")
            .output()
            .await;

        if let Ok(out) = output {
            let version_str = String::from_utf8_lossy(&out.stdout);
            // 匹配 Python 3.10, 3.11, 3.12, 3.13 等
            let re = Regex::new(r"Python 3\.(1[0-9]|[2-9][0-9])").unwrap();
            re.is_match(&version_str)
        } else {
            false
        }
    }

    async fn check_python_module(&self, python_path: &Path) -> bool {
        let (runtime_home, xdg_cache_home, tiktoken_cache_dir) = self.prepare_runtime_env();
        let original_home = std::env::var("HOME").unwrap_or_else(|_| runtime_home.to_string_lossy().to_string());
        let output = Command::new(python_path)
            .env("HOME", &runtime_home)
            .env("XDG_CACHE_HOME", &xdg_cache_home)
            .env("TIKTOKEN_CACHE_DIR", &tiktoken_cache_dir)
            .env("USERPROFILE", &runtime_home)
            .env("PDFMT_ORIGINAL_HOME", &original_home)
            .arg("-c")
            .arg("import importlib; importlib.import_module('pdf2zh_next'); print('ok')")
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
                "https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7%2B20240107-x86_64-pc-windows-msvc-shared-install_only.tar.gz",
                "https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7%2B20240107-x86_64-pc-windows-msvc-shared-install_runtime.tar.gz",
                "https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-x86_64-pc-windows-msvc-shared-install_runtime.tar.gz",
            ]
        } else if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                &[
                    "https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7%2B20240107-aarch64-apple-darwin-install_only.tar.gz",
                    "https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7%2B20240107-aarch64-apple-darwin-install_runtime.tar.gz",
                    "https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-aarch64-apple-darwin-install_runtime.tar.gz",
                ]
            } else {
                &[
                    "https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7%2B20240107-x86_64-apple-darwin-install_only.tar.gz",
                    "https://github.com/astral-sh/python-build-standalone/releases/download/20240107/cpython-3.11.7%2B20240107-x86_64-apple-darwin-install_runtime.tar.gz",
                    "https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-x86_64-apple-darwin-install_runtime.tar.gz",
                ]
            }
        } else {
            return Err("不支持的操作系统".to_string());
        };
        let filename = "python.tar.gz";

        self.emit_progress(&format!("正在下载 Python 运行时..."), 15);

        let client = reqwest::Client::new();
        let temp_file_path = internal_dir.join(filename);
        self.download_runtime_archive(&client, urls, &temp_file_path)
            .await?;

        self.emit_progress("正在解压 Python...", 55);
        self.extract_tar_gz(&temp_file_path, &internal_dir)?;
        let _ = fs::remove_file(temp_file_path);

        // 寻找真正的可执行文件路径
        // standalone 解压后通常在 python/install 目录下
        let real_exe = if cfg!(target_os = "windows") {
            internal_dir.join("python").join("install").join("python.exe")
        } else {
            internal_dir.join("python").join("install").join("bin").join("python3")
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
            let preview = String::from_utf8_lossy(&data)
                .replace('\n', " ")
                .replace('\r', " ");
            return Err(format!(
                "下载文件过小({} bytes)，可能是错误页面。内容预览: {}",
                data.len(),
                preview
            ));
        }

        if !Self::is_gzip_header(&data) {
            let preview = String::from_utf8_lossy(&data[..data.len().min(64)])
                .replace('\n', " ")
                .replace('\r', " ");
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
        archive.unpack(target_dir).map_err(|e| format!("解压失败: {e}"))?;
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
        if cfg!(target_os = "windows") { venv_cmd.arg("--copies"); }

        let status = venv_cmd.status().await.map_err(|e| format!("创建 venv 失败: {e}"))?;
        if !status.success() {
            return Err("创建 venv 失败，请确保 Python 环境完整。".to_string());
        }

        let python_executable = self.get_python_executable();
        let (runtime_home, xdg_cache_home, tiktoken_cache_dir) = self.prepare_runtime_env();
        let original_home = std::env::var("HOME").unwrap_or_else(|_| runtime_home.to_string_lossy().to_string());

        // 3. 安装依赖
        self.emit_progress("正在安装核心依赖 (pdf2zh-next)...", 80);
        let mut child = Command::new(&python_executable)
            .env("HOME", &runtime_home)
            .env("XDG_CACHE_HOME", &xdg_cache_home)
            .env("TIKTOKEN_CACHE_DIR", &tiktoken_cache_dir)
            .env("USERPROFILE", &runtime_home)
            .env("PDFMT_ORIGINAL_HOME", &original_home)
            .arg("-m")
            .arg("pip")
            .arg("install")
            .arg("pdf2zh-next")
            .arg("idna")
            .arg("-i")
            .arg("https://pypi.tuna.tsinghua.edu.cn/simple")
            .arg("--trusted-host")
            .arg("pypi.tuna.tsinghua.edu.cn")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("安装失败: {e}"))?;

        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            self.emit_log(&line);
        }

        if !child.wait().await.map_err(|e| e.to_string())?.success() {
            return Err("依赖安装失败，请检查网络连接。".to_string());
        }

        self.emit_progress("环境配置完成！", 100);
        Ok(())
    }

    async fn get_ready_system_python(&self) -> Option<PathBuf> {
        let sys_python = if cfg!(target_os = "windows") { PathBuf::from("python") } else { PathBuf::from("python3") };
        if self.check_python_version(&sys_python).await {
            Some(sys_python)
        } else {
            None
        }
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

#[cfg(test)]
mod tests {
    use super::EnvManager;

    #[test]
    fn detect_gzip_header() {
        assert!(EnvManager::is_gzip_header(&[0x1f, 0x8b, 0x08]));
        assert!(!EnvManager::is_gzip_header(b"Not Found"));
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
