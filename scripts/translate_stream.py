#!/usr/bin/env python3
"""Run pdf2zh_next translation and stream JSON events to stdout."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import importlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any


ENGINE_ALIASES: dict[str, str] = {
    "openai": "openai",
    "gpt": "openai",
    "gemini": "gemini",
    "google": "gemini",
    "deepseek": "deepseek",
    "kimi": "kimi",
    "moonshot": "kimi",
    "zhipu": "zhipu",
    "智普": "zhipu",
    "glm": "zhipu",
}

SUPPORTED_ENGINES = ("openai", "gemini", "deepseek", "kimi", "zhipu")
MIN_QPS = 1
MAX_QPS = 32
SENSITIVE_ARG_KEYS = {"--api-key"}
HEARTBEAT_INTERVAL_SECONDS = 5.0
STARTUP_IDLE_TIMEOUT_SECONDS = 60.0
RUNNING_IDLE_TIMEOUT_SECONDS = 300.0


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def sanitize_cli_args(args: list[str]) -> list[str]:
    sanitized: list[str] = []
    mask_next = False
    for item in args:
        if mask_next:
            sanitized.append("***")
            mask_next = False
            continue

        if item in SENSITIVE_ARG_KEYS:
            sanitized.append(item)
            mask_next = True
            continue

        if item.startswith("--api-key="):
            sanitized.append("--api-key=***")
            continue

        sanitized.append(item)

    return sanitized


def parse_bool(value: str | bool | None) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"Invalid boolean value: {value}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stream pdf2zh_next translation events")
    parser.add_argument("--input", required=True, help="input pdf path")
    parser.add_argument("--output", required=True, help="output directory")
    parser.add_argument("--lang-in", default="en")
    parser.add_argument("--lang-out", default="zh")
    parser.add_argument("--engine", default="OpenAI")
    parser.add_argument("--mode", default="both", choices=["mono", "dual", "both"])
    parser.add_argument("--api-key")
    parser.add_argument("--model")
    parser.add_argument("--base-url")
    parser.add_argument("--qps", type=int, default=8)
    parser.add_argument("--primary-font-family")
    parser.add_argument("--use-alternating-pages-dual", type=parse_bool)
    parser.add_argument("--ocr-workaround", type=parse_bool)
    parser.add_argument("--auto-enable-ocr-workaround", type=parse_bool)
    parser.add_argument("--no-watermark-mode", type=parse_bool)
    parser.add_argument("--save-auto-extracted-glossary", type=parse_bool)
    parser.add_argument("--no-auto-extract-glossary", type=parse_bool)
    parser.add_argument("--enhance-compatibility", type=parse_bool)
    parser.add_argument("--translate-table-text", type=parse_bool)
    parser.add_argument("--only-include-translated-page", type=parse_bool)
    print(f"DEBUG: Script received args: {sanitize_cli_args(sys.argv)}", file=sys.stderr)
    return parser.parse_args()


def clean(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped if stripped else None


def normalize_engine_name(engine: str | None) -> str:
    raw = (engine or "").strip()
    if not raw:
        return "openai"
    return ENGINE_ALIASES.get(raw, ENGINE_ALIASES.get(raw.lower(), raw.lower()))


def _can_use_as_home(home_dir: Path) -> bool:
    try:
        cache_dir = home_dir / ".cache" / "babeldoc"
        cache_dir.mkdir(parents=True, exist_ok=True)
        probe = cache_dir / ".write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def _guess_user_site_from_home(home_dir: Path) -> Path:
    major, minor = sys.version_info[:2]
    system = platform.system().lower()
    if system == "darwin":
        return (
            home_dir
            / "Library"
            / "Python"
            / f"{major}.{minor}"
            / "lib"
            / "python"
            / "site-packages"
        )
    if system == "windows":
        return (
            home_dir
            / "AppData"
            / "Roaming"
            / "Python"
            / f"Python{major}{minor}"
            / "site-packages"
        )
    return home_dir / ".local" / "lib" / f"python{major}.{minor}" / "site-packages"


def _add_user_site_path(path: Path) -> None:
    if not path.exists() or not path.is_dir():
        return
    path_str = str(path)
    if path_str not in sys.path:
        sys.path.append(path_str)
    current_pythonpath = os.environ.get("PYTHONPATH", "")
    pythonpath_items = [item for item in current_pythonpath.split(os.pathsep) if item]
    if path_str not in pythonpath_items:
        pythonpath_items.append(path_str)
        os.environ["PYTHONPATH"] = os.pathsep.join(pythonpath_items)


def prepare_runtime_environment() -> Path:
    current_home_raw = os.environ.get("HOME")
    current_home = Path(current_home_raw).expanduser() if current_home_raw else Path.home()
    original_home_raw = os.environ.get("PDFMT_ORIGINAL_HOME") or current_home_raw
    original_home = Path(original_home_raw).expanduser() if original_home_raw else current_home
    original_user_site = _guess_user_site_from_home(original_home)

    if _can_use_as_home(current_home):
        _add_user_site_path(original_user_site)
        return current_home

    runtime_home = Path(tempfile.gettempdir()) / "pdfmathtranslate-home"
    runtime_home.mkdir(parents=True, exist_ok=True)
    (runtime_home / ".cache").mkdir(parents=True, exist_ok=True)
    (runtime_home / ".cache" / "tiktoken").mkdir(parents=True, exist_ok=True)

    os.environ["HOME"] = str(runtime_home)
    os.environ["XDG_CACHE_HOME"] = str(runtime_home / ".cache")
    os.environ["TIKTOKEN_CACHE_DIR"] = str(runtime_home / ".cache" / "tiktoken")
    os.environ["USERPROFILE"] = str(runtime_home)
    os.environ.setdefault("PDFMT_ORIGINAL_HOME", str(original_home))
    _add_user_site_path(original_user_site)

    print(f"DEBUG: Runtime HOME redirected to: {runtime_home}", file=sys.stderr)
    print(f"DEBUG: Preserved user site-packages: {original_user_site}", file=sys.stderr)
    return runtime_home


def ensure_required_modules() -> None:
    required = ("idna",)
    missing: list[str] = []
    for name in required:
        try:
            importlib.import_module(name)
        except ModuleNotFoundError:
            missing.append(name)

    if not missing:
        return

    joined = " ".join(missing)
    print(
        f"DEBUG: Missing modules detected: {missing}, trying auto-install via pip",
        file=sys.stderr,
    )
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", *missing])
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ModuleNotFoundError(
            f"缺少 Python 依赖: {', '.join(missing)}。自动安装失败：{exc}。请运行 `{sys.executable} -m pip install {joined}`"
        ) from exc

    # Re-check after install.
    still_missing: list[str] = []
    for name in missing:
        try:
            importlib.import_module(name)
        except ModuleNotFoundError:
            still_missing.append(name)
    if still_missing:
        raise ModuleNotFoundError(
            f"缺少 Python 依赖: {', '.join(still_missing)}。请运行 `{sys.executable} -m pip install {' '.join(still_missing)}`"
        )


def build_engine_settings(args: argparse.Namespace) -> Any:
    from pdf2zh_next import (
        DeepSeekSettings,
        GeminiSettings,
        OpenAISettings,
        ZhipuSettings,
    )
    engine_raw = args.engine
    engine = normalize_engine_name(engine_raw)
    api_key = clean(args.api_key)
    model = clean(args.model)
    base_url = clean(args.base_url)

    # 调试日志：打印关键配置（脱敏）
    print(f"DEBUG: Engine selected(raw): {engine_raw}", file=sys.stderr)
    print(f"DEBUG: Engine selected(normalized): {engine}", file=sys.stderr)
    print(f"DEBUG: Model: {model}", file=sys.stderr)
    print(f"DEBUG: Base URL: {base_url}", file=sys.stderr)
    if api_key:
        if len(api_key) >= 8:
            masked_key = f"{api_key[:4]}****{api_key[-4:]}"
        else:
            masked_key = f"{api_key[:2]}****"
        print(f"DEBUG: API Key length: {len(api_key)}", file=sys.stderr)
        print(f"DEBUG: API Key: {masked_key}", file=sys.stderr)

    if engine == "openai":
        if not api_key:
            raise ValueError("OpenAI 引擎需要配置 API Key")
        return OpenAISettings(
            openai_api_key=api_key,
            openai_model=model or "gpt-4o-mini",
            openai_base_url=base_url,
        )

    if engine == "deepseek":
        if not api_key:
            raise ValueError("DeepSeek 引擎需要配置 API Key")

        if base_url:
            print("DEBUG: Using OpenAI path for DeepSeek with custom Base URL", file=sys.stderr)
            return OpenAISettings(
                openai_api_key=api_key,
                openai_model=model or "deepseek-chat",
                openai_base_url=base_url,
            )

        return DeepSeekSettings(
            deepseek_api_key=api_key,
            deepseek_model=model or "deepseek-chat",
        )

    if engine == "gemini":
        if not api_key:
            raise ValueError("Gemini 引擎需要配置 API Key")

        if base_url:
            print("DEBUG: Using OpenAI path for Gemini with custom Base URL", file=sys.stderr)
            return OpenAISettings(
                openai_api_key=api_key,
                openai_model=model or "gemini-1.5-flash",
                openai_base_url=base_url,
            )

        return GeminiSettings(
            gemini_api_key=api_key,
            gemini_model=model or "gemini-1.5-flash",
        )

    if engine == "zhipu":
        if not api_key:
            raise ValueError("智普引擎需要配置 API Key")

        if base_url:
            print("DEBUG: Using OpenAI path for Zhipu with custom Base URL", file=sys.stderr)
            return OpenAISettings(
                openai_api_key=api_key,
                openai_model=model or "glm-4-flash",
                openai_base_url=base_url,
            )

        return ZhipuSettings(
            zhipu_api_key=api_key,
            zhipu_model=model or "glm-4-flash",
        )

    if engine == "kimi":
        if not api_key:
            raise ValueError("Kimi 引擎需要配置 API Key")
        return OpenAISettings(
            openai_api_key=api_key,
            openai_model=model or "moonshot-v1-8k",
            openai_base_url=base_url or "https://api.moonshot.cn/v1",
        )

    supported = ", ".join(SUPPORTED_ENGINES)
    raise ValueError(
        f"不支持的引擎: {engine_raw!r} (normalized={engine!r})。支持: {supported}"
    )


def serialize_translate_result(result: Any) -> dict[str, Any]:
    return {
        "original_pdf_path": str(getattr(result, "original_pdf_path", "")) if getattr(result, "original_pdf_path", None) else None,
        "mono_pdf_path": str(getattr(result, "mono_pdf_path", "")) if getattr(result, "mono_pdf_path", None) else None,
        "dual_pdf_path": str(getattr(result, "dual_pdf_path", "")) if getattr(result, "dual_pdf_path", None) else None,
        "no_watermark_mono_pdf_path": str(getattr(result, "no_watermark_mono_pdf_path", "")) if getattr(result, "no_watermark_mono_pdf_path", None) else None,
        "no_watermark_dual_pdf_path": str(getattr(result, "no_watermark_dual_pdf_path", "")) if getattr(result, "no_watermark_dual_pdf_path", None) else None,
        "auto_extracted_glossary_path": str(getattr(result, "auto_extracted_glossary_path", "")) if getattr(result, "auto_extracted_glossary_path", None) else None,
        "total_seconds": getattr(result, "total_seconds", None),
        "peak_memory_usage": getattr(result, "peak_memory_usage", None),
    }


def serialize_event(event: dict[str, Any]) -> dict[str, Any]:
    event_type = event.get("type")
    if event_type == "finish" and "translate_result" in event:
        event = dict(event)
        event["translate_result"] = serialize_translate_result(event["translate_result"])
    return event


def build_heartbeat_event(idle_seconds: float, has_received_event: bool) -> dict[str, Any]:
    stage = "正在初始化翻译引擎，请稍候…" if not has_received_event else "翻译处理中，请稍候…"
    progress_cap = 12.0 if not has_received_event else 95.0
    progress = min(progress_cap, 1.0 + idle_seconds / HEARTBEAT_INTERVAL_SECONDS)
    return {
        "type": "progress_update",
        "stage": stage,
        "overall_progress": round(progress, 2),
        "heartbeat": True,
        "idle_seconds": round(idle_seconds, 1),
    }


def build_timeout_error_event(idle_seconds: float, has_received_event: bool) -> dict[str, Any]:
    if not has_received_event:
        reason = (
            f"连接翻译引擎超时（{idle_seconds:.1f}s 无事件）。"
            "请检查 API Key、Base URL、模型名称或网络连接。"
        )
    else:
        reason = (
            f"翻译进程长时间无响应（{idle_seconds:.1f}s 无事件）。"
            "请检查网络稳定性，或降低并发/QPS后重试。"
        )
    return {
        "type": "error",
        "error": reason,
        "error_type": "TranslationTimeoutError",
        "idle_seconds": round(idle_seconds, 1),
    }


def _unique_paths(paths: list[Path]) -> list[Path]:
    out: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        key = str(path.resolve()) if path.exists() else str(path)
        if key in seen:
            continue
        seen.add(key)
        out.append(path)
    return out


def guess_output_paths(
    input_path: Path,
    output_dir: Path,
    lang_out: str,
    mode: str,
) -> tuple[str | None, str | None]:
    stem = input_path.stem
    lang_variants = list(
        {
            lang_out,
            lang_out.lower(),
            lang_out.upper(),
            lang_out.split("-")[0],
            lang_out.split("_")[0],
        }
    )

    candidates: list[Path] = []
    for lang in lang_variants:
        for name in (
            f"{stem}.{lang}.mono.pdf",
            f"{stem}.{lang}.dual.pdf",
            f"{stem}-{lang}.mono.pdf",
            f"{stem}-{lang}.dual.pdf",
        ):
            candidates.append(output_dir / name)
            candidates.append(output_dir / "pdf2zh_files" / name)
    for name in (f"{stem}-mono.pdf", f"{stem}-dual.pdf", f"{stem}.mono.pdf", f"{stem}.dual.pdf"):
        candidates.append(output_dir / name)
        candidates.append(output_dir / "pdf2zh_files" / name)

    # Fallback globbing for version-specific naming variants.
    for pattern in (f"{stem}*.pdf", f"pdf2zh_files/{stem}*.pdf"):
        candidates.extend(output_dir.glob(pattern))

    mono: Path | None = None
    dual: Path | None = None
    filtered: list[Path] = []
    input_resolved = input_path.resolve()
    for path in _unique_paths(candidates):
        if not path.exists() or not path.is_file():
            continue
        if path.resolve() == input_resolved:
            continue
        filtered.append(path)

    filtered.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for path in filtered:
        lowered = path.name.lower()
        if mono is None and "mono" in lowered:
            mono = path
            continue
        if dual is None and "dual" in lowered:
            dual = path
            continue

    # If only one output is found but mode is explicit, map it to requested slot.
    if mono is None and dual is None and filtered:
        if mode == "mono":
            mono = filtered[0]
        elif mode == "dual":
            dual = filtered[0]

    return (
        str(mono) if mono else None,
        str(dual) if dual else None,
    )


async def process_event_stream(
    event_stream: Any,
    *,
    input_path: Path,
    output_dir: Path,
    lang_out: str,
    mode: str,
    emit_func: Any = emit,
    heartbeat_interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
    startup_idle_timeout_seconds: float = STARTUP_IDLE_TIMEOUT_SECONDS,
    running_idle_timeout_seconds: float = RUNNING_IDLE_TIMEOUT_SECONDS,
) -> int:
    loop = asyncio.get_running_loop()
    last_event_time = loop.time()
    has_received_event = False
    has_finish_event = False
    pending_next = asyncio.create_task(anext(event_stream))

    try:
        while True:
            done, _ = await asyncio.wait(
                {pending_next},
                timeout=heartbeat_interval_seconds,
            )
            if not done:
                idle_seconds = loop.time() - last_event_time
                idle_timeout = (
                    running_idle_timeout_seconds
                    if has_received_event
                    else startup_idle_timeout_seconds
                )
                if idle_seconds >= idle_timeout:
                    emit_func(build_timeout_error_event(idle_seconds, has_received_event))
                    return 1
                emit_func(build_heartbeat_event(idle_seconds, has_received_event))
                continue

            try:
                event = pending_next.result()
            except StopAsyncIteration:
                break

            has_received_event = True
            last_event_time = loop.time()
            serialized = serialize_event(event)
            if serialized.get("type") == "finish":
                has_finish_event = True
            emit_func(serialized)
            pending_next = asyncio.create_task(anext(event_stream))
    finally:
        if pending_next and not pending_next.done():
            pending_next.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pending_next
        await event_stream.aclose()

    if not has_finish_event:
        mono_path, dual_path = guess_output_paths(
            input_path=input_path,
            output_dir=output_dir,
            lang_out=lang_out,
            mode=mode,
        )
        if mono_path or dual_path:
            emit_func(
                {
                    "type": "finish",
                    "synthetic_finish": True,
                    "translate_result": {
                        "original_pdf_path": str(input_path),
                        "mono_pdf_path": mono_path,
                        "dual_pdf_path": dual_path,
                        "no_watermark_mono_pdf_path": None,
                        "no_watermark_dual_pdf_path": None,
                        "auto_extracted_glossary_path": None,
                        "total_seconds": None,
                        "peak_memory_usage": None,
                    },
                }
            )
            return 0

        emit_func(
            {
                "type": "error",
                "error": "翻译流程异常结束：未收到 finish 事件且未检测到输出文件。",
                "error_type": "TranslationIncompleteError",
            }
        )
        return 1

    return 0


async def run() -> int:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_dir = Path(args.output).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    prepare_runtime_environment()
    ensure_required_modules()

    from pdf2zh_next import (
        BasicSettings,
        PDFSettings,
        SettingsModel,
        TranslationSettings,
        do_translate_async_stream,
    )

    if not input_path.exists():
        emit({
            "type": "error",
            "error": f"Input file not found: {input_path}",
            "error_type": "FileNotFoundError",
        })
        return 1

    engine_settings = build_engine_settings(args)

    translation_kwargs: dict[str, Any] = {
        "lang_in": args.lang_in,
        "lang_out": args.lang_out,
        "output": str(output_dir),
        "qps": max(MIN_QPS, min(args.qps, MAX_QPS)),
    }
    if args.primary_font_family:
        font_family = args.primary_font_family.strip().lower()
        if font_family and font_family != "auto":
            translation_kwargs["primary_font_family"] = font_family
    if args.save_auto_extracted_glossary is not None:
        translation_kwargs["save_auto_extracted_glossary"] = args.save_auto_extracted_glossary
    if args.no_auto_extract_glossary is not None:
        translation_kwargs["no_auto_extract_glossary"] = args.no_auto_extract_glossary

    final_no_dual = args.mode == "mono"
    final_no_mono = args.mode == "dual"

    pdf_kwargs: dict[str, Any] = {
        "no_dual": final_no_dual,
        "no_mono": final_no_mono,
    }
    if args.use_alternating_pages_dual is not None:
        pdf_kwargs["use_alternating_pages_dual"] = args.use_alternating_pages_dual
    if args.enhance_compatibility is not None:
        pdf_kwargs["enhance_compatibility"] = args.enhance_compatibility
    if args.translate_table_text is not None:
        pdf_kwargs["translate_table_text"] = args.translate_table_text
    if args.ocr_workaround is not None:
        pdf_kwargs["ocr_workaround"] = args.ocr_workaround
    if args.auto_enable_ocr_workaround is not None:
        pdf_kwargs["auto_enable_ocr_workaround"] = args.auto_enable_ocr_workaround
    if args.only_include_translated_page is not None:
        pdf_kwargs["only_include_translated_page"] = args.only_include_translated_page
    if args.no_watermark_mode is not None:
        pdf_kwargs["watermark_output_mode"] = "no_watermark" if args.no_watermark_mode else "watermarked"

    settings = SettingsModel(
        basic=BasicSettings(input_files={str(input_path)}),
        translation=TranslationSettings(**translation_kwargs),
        pdf=PDFSettings(**pdf_kwargs),
        translate_engine_settings=engine_settings,
    )

    return await process_event_stream(
        do_translate_async_stream(settings, input_path),
        input_path=input_path,
        output_dir=output_dir,
        lang_out=args.lang_out,
        mode=args.mode,
    )


async def main() -> int:
    try:
        return await run()
    except Exception as exc:  # noqa: BLE001
        import sys
        print(f"Python Error: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        emit(
            {
                "type": "error",
                "error": str(exc),
                "error_type": exc.__class__.__name__,
                "details": traceback.format_exc(),
            }
        )
        return 1


if __name__ == "__main__":
    import asyncio
    raise SystemExit(asyncio.run(main()))
