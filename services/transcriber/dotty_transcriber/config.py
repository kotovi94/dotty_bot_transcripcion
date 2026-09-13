from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    recordings_dir: Path
    database_path: Path
    secret: str
    model: str
    device: str
    compute_type: str
    language: str
    initial_prompt: str
    beam_size: int
    patience: float
    repetition_penalty: float
    no_repeat_ngram_size: int
    vad_threshold: float
    vad_min_silence_ms: int
    vad_speech_pad_ms: int
    gpu_workers: int = 1
    adaptive_voice_processing: bool = True
    vad_enabled: bool = True
    voice_profiles_enabled: bool = True
    hallucination_detection_enabled: bool = True
    diagnostics_enabled: bool = True
    prebuffer_min_ms: int = 300
    prebuffer_max_ms: int = 600
    hangover_min_ms: int = 400
    hangover_max_ms: int = 1_200
    vad_threshold_min: float = 0.30
    vad_threshold_max: float = 0.70

    @classmethod
    def from_environment(cls) -> "Settings":
        project_root = Path(__file__).resolve().parents[3]
        load_dotenv(project_root / ".env")
        data_dir = (project_root / os.getenv("DOTTY_DATA_DIR", "./data")).resolve()
        data_dir.mkdir(parents=True, exist_ok=True)
        return cls(
            data_dir=data_dir,
            recordings_dir=(data_dir / "recordings").resolve(),
            database_path=data_dir / "transcriber.db",
            secret=_resolve_secret(data_dir),
            model=os.getenv("WHISPER_MODEL", "large-v3"),
            device=os.getenv("WHISPER_DEVICE", "cuda"),
            compute_type=os.getenv("WHISPER_COMPUTE_TYPE", "float16"),
            language=os.getenv("WHISPER_LANGUAGE", "es"),
            initial_prompt=os.getenv(
                "WHISPER_INITIAL_PROMPT",
                "Juego de rol.",
            ),
            beam_size=int(os.getenv("WHISPER_BEAM_SIZE", "5")),
            patience=float(os.getenv("WHISPER_PATIENCE", "1.0")),
            repetition_penalty=float(os.getenv("WHISPER_REPETITION_PENALTY", "1.05")),
            # Whisper usa tokens de bytes; bloquear n-gramas puede cortar una ñ o tilde
            # por la mitad y producir el carácter de reemplazo Unicode.
            no_repeat_ngram_size=int(os.getenv("WHISPER_NO_REPEAT_NGRAM_SIZE", "0")),
            vad_threshold=float(os.getenv("WHISPER_VAD_THRESHOLD", "0.45")),
            vad_min_silence_ms=int(os.getenv("WHISPER_VAD_MIN_SILENCE_MS", "400")),
            vad_speech_pad_ms=int(os.getenv("WHISPER_VAD_SPEECH_PAD_MS", "250")),
            gpu_workers=max(1, int(os.getenv("WHISPER_GPU_WORKERS", "1"))),
            adaptive_voice_processing=_env_bool("ADAPTIVE_VOICE_PROCESSING", True),
            vad_enabled=_env_bool("VOICE_VAD_ENABLED", True),
            voice_profiles_enabled=_env_bool("VOICE_PROFILES_ENABLED", True),
            hallucination_detection_enabled=_env_bool("HALLUCINATION_DETECTION_ENABLED", True),
            diagnostics_enabled=_env_bool("DOTTY_DIAGNOSTICS_ENABLED", True),
            prebuffer_min_ms=int(os.getenv("VOICE_PREBUFFER_MIN_MS", "300")),
            prebuffer_max_ms=int(os.getenv("VOICE_PREBUFFER_MAX_MS", "600")),
            hangover_min_ms=int(os.getenv("VOICE_HANGOVER_MIN_MS", "400")),
            hangover_max_ms=int(os.getenv("VOICE_HANGOVER_MAX_MS", "1200")),
            vad_threshold_min=float(os.getenv("VOICE_VAD_THRESHOLD_MIN", "0.30")),
            vad_threshold_max=float(os.getenv("VOICE_VAD_THRESHOLD_MAX", "0.70")),
        )


def _resolve_secret(data_dir: Path) -> str:
    configured = os.getenv("TRANSCRIBER_SHARED_SECRET", "").strip()
    if configured and configured != "replace-with-a-long-random-local-secret":
        return configured
    secret_path = data_dir / "transcriber.secret"
    if secret_path.exists():
        return secret_path.read_text(encoding="utf-8").strip()
    value = secrets.token_urlsafe(48)
    secret_path.write_text(value, encoding="utf-8")
    return value


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}
