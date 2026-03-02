import asyncio
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts import translate_stream


class TranslateStreamLogTests(unittest.TestCase):
    def test_sanitize_cli_args_masks_api_key_flag_value(self) -> None:
        args = [
            "translate_stream.py",
            "--engine",
            "OpenAI",
            "--api-key",
            "sk-secret-value",
            "--model",
            "gpt-4o-mini",
        ]
        sanitized = translate_stream.sanitize_cli_args(args)
        self.assertEqual(
            sanitized,
            [
                "translate_stream.py",
                "--engine",
                "OpenAI",
                "--api-key",
                "***",
                "--model",
                "gpt-4o-mini",
            ],
        )

    def test_sanitize_cli_args_masks_inline_api_key(self) -> None:
        args = ["translate_stream.py", "--api-key=sk-inline-secret", "--engine", "OpenAI"]
        sanitized = translate_stream.sanitize_cli_args(args)
        self.assertEqual(
            sanitized,
            ["translate_stream.py", "--api-key=***", "--engine", "OpenAI"],
        )

    def test_build_heartbeat_event_before_first_progress(self) -> None:
        event = translate_stream.build_heartbeat_event(idle_seconds=16.0, has_received_event=False)
        self.assertEqual(event["type"], "progress_update")
        self.assertIn("初始化翻译引擎", event["stage"])
        self.assertGreater(event["overall_progress"], 1.0)
        self.assertTrue(event["heartbeat"])

    def test_build_timeout_error_for_startup_phase(self) -> None:
        event = translate_stream.build_timeout_error_event(
            idle_seconds=121.0,
            has_received_event=False,
        )
        self.assertEqual(event["type"], "error")
        self.assertIn("超时", event["error"])
        self.assertEqual(event["error_type"], "TranslationTimeoutError")

    def test_guess_output_paths_finds_nested_pdf2zh_files(self) -> None:
        with TemporaryDirectory() as tmp:
            base = Path(tmp)
            input_pdf = base / "paper.pdf"
            input_pdf.write_bytes(b"pdf")
            out_dir = base / "out"
            out_dir.mkdir(parents=True, exist_ok=True)
            nested = out_dir / "pdf2zh_files"
            nested.mkdir(parents=True, exist_ok=True)
            mono = nested / "paper.zh.mono.pdf"
            dual = nested / "paper.zh.dual.pdf"
            mono.write_bytes(b"mono")
            dual.write_bytes(b"dual")

            mono_out, dual_out = translate_stream.guess_output_paths(
                input_path=input_pdf,
                output_dir=out_dir,
                lang_out="zh",
                mode="both",
            )
            self.assertTrue(os.path.samefile(mono_out, mono))
            self.assertTrue(os.path.samefile(dual_out, dual))

    def test_guess_output_paths_ignores_input_pdf_itself(self) -> None:
        with TemporaryDirectory() as tmp:
            base = Path(tmp)
            input_pdf = base / "doc.pdf"
            input_pdf.write_bytes(b"pdf")
            out_dir = base

            mono_out, dual_out = translate_stream.guess_output_paths(
                input_path=input_pdf,
                output_dir=out_dir,
                lang_out="zh",
                mode="both",
            )
            self.assertIsNone(mono_out)
            self.assertIsNone(dual_out)

    def test_process_event_stream_keeps_slow_stream_alive(self) -> None:
        async def slow_events():
            await asyncio.sleep(0.03)
            yield {"type": "progress_update", "stage": "step1", "overall_progress": 10.0}
            await asyncio.sleep(0.03)
            yield {"type": "finish", "translate_result": {}}

        with TemporaryDirectory() as tmp:
            base = Path(tmp)
            input_pdf = base / "demo.pdf"
            input_pdf.write_bytes(b"pdf")
            out_dir = base / "out"
            out_dir.mkdir(parents=True, exist_ok=True)
            emitted: list[dict] = []

            result = asyncio.run(
                translate_stream.process_event_stream(
                    slow_events(),
                    input_path=input_pdf,
                    output_dir=out_dir,
                    lang_out="zh",
                    mode="both",
                    emit_func=emitted.append,
                    heartbeat_interval_seconds=0.01,
                    startup_idle_timeout_seconds=1.0,
                    running_idle_timeout_seconds=1.0,
                )
            )
            self.assertEqual(result, 0)
            self.assertTrue(any(item.get("heartbeat") for item in emitted))
            self.assertTrue(any(item.get("type") == "finish" for item in emitted))


if __name__ == "__main__":
    unittest.main()
