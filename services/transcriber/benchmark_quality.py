from __future__ import annotations

import argparse
from pathlib import Path

from dotty_transcriber.config import Settings
from dotty_transcriber.engine import WhisperEngine


def main() -> None:
    parser = argparse.ArgumentParser(description="Prueba local de calidad de Dotty")
    parser.add_argument("audio", type=Path)
    parser.add_argument("--prompt", default="Transcripción fiel en español de una sesión de rol.")
    parser.add_argument("--hotwords", default="Dotty, Discord, campaña, sesión, personajes, bitácora")
    args = parser.parse_args()

    result = WhisperEngine(Settings.from_environment()).transcribe(
        args.audio.resolve(), "es", args.prompt, args.hotwords
    )
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


if __name__ == "__main__":
    main()
