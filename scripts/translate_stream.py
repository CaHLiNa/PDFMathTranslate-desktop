#!/usr/bin/env python3
"""Run pdf2zh_next translation and stream JSON events to stdout."""

from __future__ import annotations

import argparse
import asyncio
import json
import traceback
from pathlib import Path
from typing import Any


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


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
    parser.add_argument("--qps", type=int, default=4)
    return parser.parse_args()


def build_engine_settings(args: argparse.Namespace) -> Any:
    from pdf2zh_next import (
        BingSettings,
        DeepSeekSettings,
        GoogleSettings,
        OllamaSettings,
        OpenAISettings,
    )

    engine = args.engine.strip().lower()

    if engine == "openai":
        return OpenAISettings(
            openai_api_key=args.api_key,
            openai_model=args.model or "gpt-4o-mini",
            openai_base_url=args.base_url,
        )

    if engine == "google":
        return GoogleSettings()

    if engine == "bing":
        return BingSettings()

    if engine == "deepseek":
        return DeepSeekSettings(
            deepseek_api_key=args.api_key,
            deepseek_model=args.model or "deepseek-chat",
        )

    if engine == "ollama":
        return OllamaSettings(
            ollama_host=args.base_url or "http://127.0.0.1:11434",
            ollama_model=args.model or "gemma2",
        )

    raise ValueError(f"Unsupported engine: {args.engine}")


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


async def run() -> int:
    from pdf2zh_next import (
        BasicSettings,
        PDFSettings,
        SettingsModel,
        TranslationSettings,
        do_translate_async_stream,
    )

    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_dir = Path(args.output).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        emit({
            "type": "error",
            "error": f"Input file not found: {input_path}",
            "error_type": "FileNotFoundError",
        })
        return 1

    engine_settings = build_engine_settings(args)

    settings = SettingsModel(
        basic=BasicSettings(input_files={str(input_path)}),
        translation=TranslationSettings(
            lang_in=args.lang_in,
            lang_out=args.lang_out,
            output=str(output_dir),
            qps=max(args.qps, 1),
        ),
        pdf=PDFSettings(
            no_dual=args.mode == "mono",
            no_mono=args.mode == "dual",
        ),
        translate_engine_settings=engine_settings,
    )

    async for event in do_translate_async_stream(settings, input_path):
        emit(serialize_event(event))

    return 0


async def main() -> int:
    try:
        return await run()
    except Exception as exc:  # noqa: BLE001
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
    raise SystemExit(asyncio.run(main()))
