from __future__ import annotations

import logging
import math
import os
import re
import subprocess
import sys
import threading
import gc
from pathlib import Path
from typing import Any, Callable

from .config import Settings

logger = logging.getLogger("dotty.transcriber.engine")

_cuda_dll_handles: list[Any] = []


def _configure_cuda_dll_search_path() -> None:
    """Expose NVIDIA's venv-local CUDA libraries to CTranslate2 on Windows."""
    if os.name != "nt" or _cuda_dll_handles:
        return

    nvidia_packages = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    dll_directories = [
        nvidia_packages / "cublas" / "bin",
        nvidia_packages / "cudnn" / "bin",
        nvidia_packages / "cuda_nvrtc" / "bin",
    ]
    available = [path for path in dll_directories if path.is_dir()]
    if not available:
        return

    os.environ["PATH"] = os.pathsep.join(
        [*(str(path) for path in available), os.environ.get("PATH", "")]
    )
    if hasattr(os, "add_dll_directory"):
        _cuda_dll_handles.extend(os.add_dll_directory(str(path)) for path in available)


class WhisperEngine:
    def __init__(self, settings: Settings) -> None:
        _configure_cuda_dll_search_path()
        self.settings = settings
        self._model: Any = None
        self._lock = threading.Lock()
        self._active_device = settings.device
        self._known_hallucination_phrases = [
            "gracias por ver el video",
            "gracias por ver este video",
            "suscribete al canal",
            "subtitulos realizados por",
            "sous titrage societe radio canada",
            "thank you for watching",
            "thanks for watching",
            "this is the episode",
        ]
        self._suspicious_phrases = [
            "gracias por escuchar",
            "hasta la próxima",
            "hasta pronto",
            "muchas gracias",
        ]

    @property
    def active_device(self) -> str:
        return self._active_device

    def unload(self) -> bool:
        """Release the lazy Whisper model so another local CUDA workload can run."""
        with self._lock:
            if self._model is None:
                return False
            self._model = None
            gc.collect()
            logger.info("[CUDA] Whisper model unloaded for narrative generation")
            return True

    def transcribe(
        self,
        audio_path: Path,
        language: str,
        initial_prompt: str = "",
        hotwords: str = "",
        progress_callback: Callable[[float, float, float], None] | None = None,
        vad_parameters: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        try:
            return self._transcribe_with_model(
                self._get_model(), audio_path, language, initial_prompt, hotwords, progress_callback,
                vad_parameters,
            )
        except (IndexError, ValueError) as error:
            message = str(error).lower()
            if "boolean index did not match indexed array" not in message:
                raise
            logger.info("Audio without speech after VAD: %s", audio_path)
            return {
                "device": self._active_device,
                "language": language or self.settings.language,
                "language_probability": 0.0,
                "duration_seconds": 0.0,
                "duration_after_vad_seconds": 0.0,
                "segments": [],
                "status": "unintelligible",
            }
        except RuntimeError as error:
            message = str(error).lower()
            if self.settings.device == "cuda" and any(
                name in message for name in ("out of memory", "cublas", "cudnn", "cuda")
            ):
                logger.error(
                    "[CUDA] Transcription failed on GPU; no automatic CPU fallback is enabled: %s",
                    error,
                )
            raise

    def _transcribe_with_model(
        self,
        model: Any,
        audio_path: Path,
        language: str,
        initial_prompt: str,
        hotwords: str,
        progress_callback: Callable[[float, float, float], None] | None = None,
        vad_parameters: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        # Disable initial_prompt entirely to avoid Whisper's position encoding limit (448 tokens max)
        # The position limit is tight - we need headroom for the actual transcribed audio
        # Use only hotwords instead, which are more selective
        trimmed_prompt = ""
        # Keep the full Dotty command vocabulary while staying well below
        # Whisper's prompt token limit.
        trimmed_hotwords = self._truncate_prompt(hotwords, max_chars=500)
        logger.info(
            "Transcription request: model=%s language=%s prompt_chars=%d hotwords_chars=%d",
            self.settings.model,
            language or self.settings.language,
            len(trimmed_prompt),
            len(trimmed_hotwords),
        )
        effective_vad = vad_parameters or {
            "threshold": self.settings.vad_threshold,
            "min_silence_duration_ms": self.settings.vad_min_silence_ms,
            "speech_pad_ms": self.settings.vad_speech_pad_ms,
        }
        segments, info = model.transcribe(
            str(audio_path),
            language=language or self.settings.language,
            beam_size=self.settings.beam_size,
            patience=self.settings.patience,
            repetition_penalty=self.settings.repetition_penalty,
            no_repeat_ngram_size=self.settings.no_repeat_ngram_size,
            temperature=0.0,
            vad_filter=True,
            vad_parameters=effective_vad,
            word_timestamps=True,
            condition_on_previous_text=False,
            hallucination_silence_threshold=0.5,
            initial_prompt=trimmed_prompt,
            hotwords=trimmed_hotwords or None,
        )
        items = []
        duration = max(float(info.duration_after_vad or info.duration or 0), 0.001)
        if progress_callback is not None:
            progress_callback(0.01, 0.0, duration)
        for segment in segments:
            item = {
                "start_ms": round(segment.start * 1000),
                "end_ms": round(segment.end * 1000),
                "text": segment.text.strip(),
                "avg_logprob": segment.avg_logprob,
                "no_speech_prob": segment.no_speech_prob,
                "compression_ratio": segment.compression_ratio,
                "words": [
                    {
                        "start_ms": round(word.start * 1000),
                        "end_ms": round(word.end * 1000),
                        "text": word.word,
                        "probability": word.probability,
                    }
                    for word in (segment.words or [])
                ],
            }
            filtered = self._classify_segment(item)
            if filtered is None:
                logger.debug(
                    "[TRANSCRIPTION_FILTER] Segmento descartado: %s",
                    item,
                )
                continue
            items.append(filtered)
            if progress_callback is not None:
                processed = min(float(segment.end), duration)
                progress_callback(min(0.99, processed / duration), processed, duration)
        status = "transcribed" if items else "unintelligible"
        return {
            "device": self._active_device,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration_seconds": info.duration,
            "duration_after_vad_seconds": info.duration_after_vad,
            "segments": items,
            "status": status,
        }

    def _classify_segment(self, segment: dict[str, Any]) -> dict[str, Any] | None:
        text = str(segment.get("text", "") or "").strip()
        if not text:
            return None

        duration_ms = max(int(segment.get("end_ms", 0) or 0) - int(segment.get("start_ms", 0) or 0), 0)
        words = [word for word in (segment.get("words") or []) if str(word.get("text", "") or "").strip()]
        effective_word_count = max(len(words), len(text.split()))
        voice_ratio = min(1.0, max(0.0, effective_word_count / max(1, math.ceil(duration_ms / 600)))) if duration_ms > 0 else (1.0 if effective_word_count > 0 else 0.0)
        avg_logprob = segment.get("avg_logprob")
        no_speech_prob = segment.get("no_speech_prob")
        word_probabilities = [
            float(word["probability"])
            for word in words
            if isinstance(word.get("probability"), (int, float))
        ]
        word_confidence = (
            sum(word_probabilities) / len(word_probabilities)
            if word_probabilities
            else None
        )
        known_hallucination_match = self._match_known_hallucination_phrase(text)
        suspicious_match = self._match_suspicious_phrase(text)

        normalized_words = re.findall(r"[\w]+", text.lower(), flags=re.UNICODE)
        reasons: list[str] = []
        if known_hallucination_match:
            reasons.append("known_hallucination_phrase")
        if self._is_excessively_repetitive(normalized_words):
            reasons.append("repetitive_output")
        if (segment.get("compression_ratio") or 0) >= 3.2:
            reasons.append("high_compression_ratio")
        if duration_ms <= 1_000 and effective_word_count >= 10:
            reasons.append("too_much_text_for_duration")
        if no_speech_prob is not None and no_speech_prob >= 0.9 and avg_logprob is not None and avg_logprob <= -1.0:
            reasons.append("weak_voice_and_low_log_probability")
        if word_confidence is not None and word_confidence < 0.28:
            reasons.append("very_low_word_confidence")
        elif (
            word_confidence is not None
            and word_confidence < 0.4
            and avg_logprob is not None
            and avg_logprob <= -0.9
        ):
            reasons.append("low_word_and_log_probability")
        if (
            avg_logprob is not None
            and avg_logprob <= -1.1
            and (
                no_speech_prob is None
                or no_speech_prob >= 0.5
                or word_confidence is None
                or word_confidence < 0.5
            )
        ):
            reasons.append("low_confidence_output")
        if suspicious_match and no_speech_prob is not None and no_speech_prob >= 0.75:
            reasons.append("known_hallucination_phrase_with_weak_voice")
        if reasons and self.settings.hallucination_detection_enabled:
            segment["status"] = "suspected_hallucination"
            segment["validation_reasons"] = reasons
        else:
            segment["status"] = "transcribed"
        return segment

    # Kept for callers and old tests; suspicious text is now marked, not destroyed.
    def _filter_segment(self, segment: dict[str, Any]) -> dict[str, Any] | None:
        return self._classify_segment(segment)

    def _match_suspicious_phrase(self, text: str) -> bool:
        normalized = self._fold_text(text)
        return any(self._fold_text(phrase) in normalized for phrase in self._suspicious_phrases)

    def _match_known_hallucination_phrase(self, text: str) -> bool:
        normalized = self._fold_text(text)
        return any(phrase in normalized for phrase in self._known_hallucination_phrases)

    @staticmethod
    def _fold_text(text: str) -> str:
        import unicodedata

        decomposed = unicodedata.normalize("NFD", text.lower())
        without_marks = "".join(char for char in decomposed if unicodedata.category(char) != "Mn")
        return re.sub(r"[^a-z0-9]+", " ", without_marks).strip()

    @staticmethod
    def _is_excessively_repetitive(words: list[str]) -> bool:
        if len(words) >= 8 and len(set(words)) <= math.ceil(len(words) / 4):
            return True
        if len(words) < 4 or len(set(words)) != 1:
            return False
        return words[0] not in {"no", "si", "ja", "eh", "ah", "ay", "oh", "uh", "mm"}

    def _truncate_prompt(self, value: str, max_chars: int = 300) -> str:
        text = (value or "").strip()
        if len(text) <= max_chars:
            return text
        return text[: max_chars - 1].rstrip() + "…"

    def _get_model(self) -> Any:
        with self._lock:
            if self._model is None:
                from faster_whisper import WhisperModel
                if self.settings.device == "cuda":
                    import ctranslate2

                    device_count = ctranslate2.get_cuda_device_count()
                    if device_count < 1:
                        raise RuntimeError("CUDA is configured but CTranslate2 found no CUDA device.")
                    logger.info(
                        "[CUDA] CUDA available; devices=%s gpu=%s model=%s compute_type=%s",
                        device_count,
                        _cuda_device_name(),
                        self.settings.model,
                        self.settings.compute_type,
                    )
                else:
                    logger.warning(
                        "[CUDA] Explicit non-CUDA configuration selected: device=%s",
                        self.settings.device,
                    )

                self._model = WhisperModel(
                    self.settings.model,
                    device=self.settings.device,
                    compute_type=self.settings.compute_type,
                )
                self._active_device = self.settings.device
                logger.info(
                    "[CUDA] Whisper model loaded; device=%s compute_type=%s",
                    self._active_device,
                    self.settings.compute_type,
                )
            return self._model


def _cuda_device_name() -> str:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader"],
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
        name = result.stdout.splitlines()[0].strip() if result.returncode == 0 and result.stdout else ""
        return name or "CUDA device 0"
    except (OSError, subprocess.SubprocessError):
        return "CUDA device 0"
