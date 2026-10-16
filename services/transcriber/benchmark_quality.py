from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from dotty_transcriber.config import Settings
from dotty_transcriber.engine import WhisperEngine


def main() -> None:
    parser = argparse.ArgumentParser(description="Prueba local de calidad de Dotty")
    parser.add_argument("audio", type=Path)
    parser.add_argument("--prompt", default="Transcripción fiel en español de una sesión de rol.")
    parser.add_argument("--hotwords", default="Dotty, Discord, campaña, sesión, personajes, bitácora")
    parser.add_argument("--reference", type=Path, help="Transcripción humana UTF-8 para medir errores de palabras")
    parser.add_argument("--json", action="store_true", help="Mostrar métricas reproducibles como JSON")
    args = parser.parse_args()

    started = time.perf_counter()
    # A measurement must never trigger a multi-GB model download implicitly.
    engine = WhisperEngine(Settings.from_environment(), local_files_only=True)
    result = engine.transcribe(
        args.audio.resolve(), "es", args.prompt, args.hotwords
    )
    elapsed = time.perf_counter() - started
    duration = float(result.get("duration_seconds") or 0)
    recognized = " ".join(segment["text"] for segment in result["segments"])
    metrics = {
        **engine.runtime_status,
        "wall_seconds": elapsed,
        "audio_seconds": duration,
        "real_time_factor": elapsed / duration if duration > 0 else None,
        "word_error_rate": word_error_rate(args.reference.read_text(encoding="utf-8"), recognized) if args.reference else None,
    }
    if args.json:
        print(json.dumps(metrics, ensure_ascii=False))
        return
    print(json.dumps(metrics, ensure_ascii=False))
    print(
        f"DEVICE={result['device']} DURATION={result['duration_seconds']} "
        f"AFTER_VAD={result['duration_after_vad_seconds']}"
    )
    for segment in result["segments"]:
        words = segment["words"]
        confidence = sum(word["probability"] for word in words) / max(1, len(words))
        print(
            f"{segment['start_ms']:05d}-{segment['end_ms']:05d} "
            f"confidence={confidence:.3f} {segment['text']}"
        )


def word_error_rate(reference: str, recognized: str) -> float:
    import re
    expected = re.findall(r"\w+", reference.casefold())
    actual = re.findall(r"\w+", recognized.casefold())
    if not expected:
        raise ValueError("Reference transcript must contain words")
    previous = list(range(len(actual) + 1))
    for i, word in enumerate(expected, 1):
        current = [i]
        for j, candidate in enumerate(actual, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (word != candidate)))
        previous = current
    return previous[-1] / len(expected)


if __name__ == "__main__":
    main()
