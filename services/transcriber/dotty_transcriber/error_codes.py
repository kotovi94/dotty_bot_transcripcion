from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


@lru_cache(maxsize=1)
def _catalog() -> dict[str, Any]:
    project_root = Path(__file__).resolve().parents[3]
    path = project_root / "packages" / "shared" / "error-codes.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("issues"), dict):
        raise RuntimeError("Invalid Dotty error code catalog")
    return value


def get_issue(name: str) -> dict[str, Any]:
    raw = _catalog()["issues"].get(name)
    if not isinstance(raw, dict):
        raise KeyError(f"Unknown Dotty diagnostic issue: {name}")
    return {"name": name, **raw}


def classify_transcription_error(error: BaseException) -> str:
    message = str(error).lower()
    if any(token in message for token in ("cuda", "cublas", "cudnn", "out of memory", "ctranslate2")):
        return "WHISPER_CUDA_FAILURE"
    if isinstance(error, RuntimeError):
        return "WHISPER_RUNTIME_FAILURE"
    return "UNKNOWN_TRANSCRIPTION_FAILURE"
