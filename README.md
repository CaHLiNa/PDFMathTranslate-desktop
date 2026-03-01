# PDFMathTranslate Desktop

基于 `Tauri v2 + React + pdf2zh_next` 的桌面应用，目标是提供类似 VSCode 的 PDF 翻译工作台：

- 打开本地文件夹并显示 PDF 文件树
- 左右分栏对照（原文 / 译文）
- 调用 `pdf2zh_next` 异步翻译并实时显示任务进度

## 1. 环境要求

- Node.js 18+
- Rust 工具链（含 cargo）
- Python 3.10+
- 已安装 `pdf2zh_next` 及其依赖

## 2. 安装依赖

```bash
npm install
```

## 3. 启动开发模式

```bash
npm run tauri dev
```

## 4. 使用说明

1. 点击「打开文件夹」选择 PDF 目录。
2. 在左侧文件树选择一个 PDF。
3. 配置翻译引擎参数（例如 OpenAI 的 API Key / Model）。
4. 点击「翻译当前 PDF」。
5. 在下方任务列表观察进度，完成后点击「打开结果」在右侧预览。

## 5. 关键实现

- Rust 命令：
  - `list_pdf_tree`：递归扫描目录并生成文件树
  - `read_pdf_base64`：读取 PDF 供前端渲染
  - `start_translation`：启动 Python 翻译子进程
  - `cancel_translation`：取消运行中的任务
- Python 桥接脚本：`scripts/translate_stream.py`
  - 直接调用 `pdf2zh_next.do_translate_async_stream`
  - 将事件流转换为 JSON 行输出
- 前端事件监听：
  - `translation-progress`
  - 同步任务状态与输出 PDF 映射

## 6. 常见问题

- 找不到 `pdf2zh_next`：请在系统 Python 环境执行 `pip install pdf2zh-next`。
- API 鉴权失败：检查 API Key 和 Base URL 是否正确。
- 输出为空：先看任务日志，再检查 `output` 目录是否有 `*.mono.pdf` / `*.dual.pdf`。

## 7. 内部测试分发（无 Apple 开发者签名）

当前 CI 的 macOS 发布策略为**内部测试模式**：

- 产物使用 `--bundles app --no-sign` 打包（不生成公证 DMG）。
- 无需配置 Apple Developer 相关 secrets。

下载并解压 macOS 产物后，首次运行前执行：

```bash
xattr -dr com.apple.quarantine "/Applications/PDFMathTranslate Desktop.app"
```

然后右键应用选择 `Open`（首次），后续可直接双击启动。

如果未来要面向普通用户公开分发，需要改回 `Developer ID` 签名 + Apple notarization。
