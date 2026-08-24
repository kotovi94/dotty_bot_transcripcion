from __future__ import annotations

import json
import logging
import math
import os
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from statistics import median
from typing import Any, Callable

from .config import Settings

logger = logging.getLogger("dotty.transcriber.voice")


@dataclass(frozen=True)
class VoiceAnalysis:
    state: str
    duration_seconds: float
    speech_seconds: float
    speech_ratio: float
    rms_dbfs: float
    vad_parameters: dict[str, Any]


class AdaptiveVoiceProcessor:
    """Classifies a disposable analysis view; the source WAV is never changed."""

    def __init__(
        self,
        settings: Settings,
        decoder: Callable[[str], Any] | None = None,
        detector: Callable[..., list[dict[str, int]]] | None = None,
    ) -> None:
        self.settings = settings
        self._decoder = decoder
        self._detector = detector
        self._lock = threading.RLock()

    def analyze(self, audio_path: Path, user_id: str, session_id: str) -> VoiceAnalysis:
        parameters = self._parameters_for(user_id, session_id)
        if not self.settings.adaptive_voice_processing or not self.settings.vad_enabled:
            return VoiceAnalysis("SPEECH", 0.0, 0.0, 1.0, -120.0, parameters)

        audio = self._decode(str(audio_path))
        sample_count = len(audio)
        duration = sample_count / 16_000
        rms = self._rms_dbfs(audio)
        timestamps = self._detect(audio, parameters)
        speech_samples = sum(max(0, int(item["end"]) - int(item["start"])) for item in timestamps)
        speech_seconds = speech_samples / 16_000
        speech_ratio = min(1.0, speech_seconds / max(duration, 0.001))
        state = "SPEECH" if timestamps else "NON_SPEECH"
        analysis = VoiceAnalysis(state, duration, speech_seconds, speech_ratio, rms, parameters)
        self._record_observation(user_id, session_id, analysis, timestamps)
        return analysis

    def record_result(
        self,
        session_id: str,
        user_id: str,
        analysis: VoiceAnalysis,
        result: dict[str, Any],
        gpu_seconds: float,
        audio_reference: str,
    ) -> None:
        session_dir = self.settings.recordings_dir / session_id
        event_type = str(result.get("status") or analysis.state.lower())
        event = {
            "type": event_type,
            "user_id": user_id,
            "audio_reference": audio_reference,
            "duration_seconds": analysis.duration_seconds,
            "speech_seconds": analysis.speech_seconds,
            "created_at": _now(),
        }
        with self._lock:
            events_path = session_dir / "events" / "voice_events.json"
            events = _read_json(events_path, {"version": 1, "events": []})
            events.setdefault("events", []).append(event)
            _write_json_atomically(events_path, events)

            metrics_path = session_dir / "voice_metrics.json"
            metrics = _read_json(metrics_path, _empty_metrics())
            timeline = _session_timeline(session_dir / "manifest.json")
            if timeline is None:
                metrics["duration_total_seconds"] += analysis.duration_seconds
            else:
                total_seconds, discord_active_seconds = timeline
                metrics["duration_total_seconds"] = total_seconds
                metrics["time_silence_seconds"] = max(0.0, total_seconds - discord_active_seconds)
            metrics[f"time_{analysis.state.lower()}_seconds"] += (
                analysis.duration_seconds if analysis.state != "SPEECH" else analysis.speech_seconds
            )
            if analysis.state == "SPEECH":
                metrics["segments_sent_to_whisper"] += 1
            if result.get("segments"):
                metrics["segments_transcribed"] += 1
            if result.get("status") == "unintelligible":
                metrics["unintelligible"] += 1
            metrics["suspected_hallucination"] += sum(
                1 for segment in result.get("segments", [])
                if segment.get("status") == "suspected_hallucination"
            )
            metrics["gpu_seconds"] += max(0.0, gpu_seconds)
            metrics["updated_at"] = _now()
            _write_json_atomically(metrics_path, metrics)

    def _decode(self, path: str) -> Any:
        if self._decoder is None:
            from faster_whisper.audio import decode_audio

            self._decoder = lambda value: decode_audio(value, sampling_rate=16_000)
        return self._decoder(path)

    def _detect(self, audio: Any, parameters: dict[str, Any]) -> list[dict[str, int]]:
        if self._detector is None:
            from faster_whisper.vad import VadOptions, get_speech_timestamps

            self._detector = lambda value, **options: get_speech_timestamps(
                value, VadOptions(**options)
            )
        return self._detector(
            audio,
            threshold=parameters["threshold"],
            min_silence_duration_ms=parameters["min_silence_duration_ms"],
            speech_pad_ms=parameters["speech_pad_ms"],
        )

    def _parameters_for(self, user_id: str, session_id: str) -> dict[str, Any]:
        defaults = {
            "threshold": self.settings.vad_threshold,
            "min_silence_duration_ms": self.settings.vad_min_silence_ms,
            "speech_pad_ms": self.settings.vad_speech_pad_ms,
        }
        if not self.settings.voice_profiles_enabled:
            return defaults
        with self._lock:
            historical = _read_json(self._user_profile_path(user_id), {})
            session_profiles = _read_json(self._session_profiles_path(session_id), {"version": 1, "users": {}})
            current = session_profiles.get("users", {}).get(user_id, {})
        adaptive = current.get("vad_parameters") or historical.get("vad_parameters") or defaults
        return {
            "threshold": _clamp(float(adaptive.get("threshold", defaults["threshold"])), self.settings.vad_threshold_min, self.settings.vad_threshold_max),
            "min_silence_duration_ms": round(_clamp(float(adaptive.get("min_silence_duration_ms", defaults["min_silence_duration_ms"])), self.settings.hangover_min_ms, self.settings.hangover_max_ms)),
            "speech_pad_ms": round(_clamp(float(adaptive.get("speech_pad_ms", defaults["speech_pad_ms"])), self.settings.prebuffer_min_ms, self.settings.prebuffer_max_ms)),
        }

    def _record_observation(
        self,
        user_id: str,
        session_id: str,
        analysis: VoiceAnalysis,
        timestamps: list[dict[str, int]],
    ) -> None:
        if not self.settings.voice_profiles_enabled:
            return
        gaps_ms = [
            max(0.0, (right["start"] - left["end"]) / 16)
            for left, right in zip(timestamps, timestamps[1:])
        ]
        observed_hangover = median(gaps_ms) if gaps_ms else analysis.vad_parameters["min_silence_duration_ms"]
        with self._lock:
            session_path = self._session_profiles_path(session_id)
            session_profiles = _read_json(session_path, {"version": 1, "users": {}})
            users = session_profiles.setdefault("users", {})
            current = users.get(user_id, _new_profile())
            current = _update_profile(current, analysis, observed_hangover, acoustic_alpha=0.20, human_alpha=0.08, settings=self.settings)
            users[user_id] = current
            _write_json_atomically(session_path, session_profiles)

            permanent_path = self._user_profile_path(user_id)
            permanent = _read_json(permanent_path, _new_profile())
            permanent = _update_profile(permanent, analysis, observed_hangover, acoustic_alpha=0.03, human_alpha=0.02, settings=self.settings)
            _write_json_atomically(permanent_path, permanent)

    def _user_profile_path(self, user_id: str) -> Path:
        return self.settings.data_dir / "users" / user_id / "voice_profile.json"

    def _session_profiles_path(self, session_id: str) -> Path:
        return self.settings.recordings_dir / session_id / "session_voice_profiles.json"

    @staticmethod
    def _rms_dbfs(audio: Any) -> float:
        if len(audio) == 0:
            return -120.0
        mean_square = sum(float(sample) * float(sample) for sample in audio) / len(audio)
        return max(-120.0, 20 * math.log10(max(math.sqrt(mean_square), 1e-6)))


def _new_profile() -> dict[str, Any]:
    return {
        "version": 1,
        "sample_count": 0,
        "human_speech_profile": {},
        "acoustic_profile": {},
        "vad_parameters": {},
        "updated_at": _now(),
    }


def _update_profile(
    profile: dict[str, Any],
    analysis: VoiceAnalysis,
    observed_hangover: float,
    acoustic_alpha: float,
    human_alpha: float,
    settings: Settings,
) -> dict[str, Any]:
    count = max(0, int(profile.get("sample_count", 0))) + 1
    acoustic = profile.setdefault("acoustic_profile", {})
    acoustic["rms_dbfs"] = _ewma(acoustic.get("rms_dbfs"), analysis.rms_dbfs, acoustic_alpha)
    acoustic["speech_ratio"] = _ewma(acoustic.get("speech_ratio"), analysis.speech_ratio, acoustic_alpha)
    if analysis.state == "SPEECH":
        human = profile.setdefault("human_speech_profile", {})
        human["typical_utterance_seconds"] = _ewma(
            human.get("typical_utterance_seconds"), analysis.speech_seconds, human_alpha
        )
        human["typical_pause_ms"] = _ewma(human.get("typical_pause_ms"), observed_hangover, human_alpha)
    vad = profile.setdefault("vad_parameters", {})
    vad["threshold"] = _clamp(
        _ewma(vad.get("threshold"), analysis.vad_parameters["threshold"], 0.05),
        settings.vad_threshold_min,
        settings.vad_threshold_max,
    )
    vad["min_silence_duration_ms"] = round(_clamp(
        _ewma(vad.get("min_silence_duration_ms"), observed_hangover, human_alpha),
        settings.hangover_min_ms,
        settings.hangover_max_ms,
    ))
    vad["speech_pad_ms"] = round(_clamp(
        float(vad.get("speech_pad_ms", analysis.vad_parameters["speech_pad_ms"])),
        settings.prebuffer_min_ms,
        settings.prebuffer_max_ms,
    ))
    profile["sample_count"] = count
    profile["confidence"] = "stable" if count >= 100 else "medium" if count >= 20 else "preliminary"
    profile["updated_at"] = _now()
    return profile


def _ewma(previous: Any, observed: float, alpha: float) -> float:
    if not isinstance(previous, (int, float)) or not math.isfinite(float(previous)):
        return observed
    previous_value = float(previous)
    maximum_change = max(abs(previous_value) * 3, 1.0)
    bounded_observation = _clamp(observed, previous_value - maximum_change, previous_value + maximum_change)
    return previous_value + alpha * (bounded_observation - previous_value)


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else fallback
    except FileNotFoundError:
        return fallback
    except (OSError, ValueError, TypeError) as error:
        logger.warning("[Profile] Invalid profile ignored path=%s error=%s", path, error)
        return fallback


def _write_json_atomically(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _empty_metrics() -> dict[str, Any]:
    return {
        "version": 1,
        "duration_total_seconds": 0.0,
        "time_silence_seconds": 0.0,
        "time_non_speech_seconds": 0.0,
        "time_speech_seconds": 0.0,
        "segments_sent_to_whisper": 0,
        "segments_transcribed": 0,
        "unintelligible": 0,
        "suspected_hallucination": 0,
        "gpu_seconds": 0.0,
        "updated_at": _now(),
    }


def _session_timeline(manifest_path: Path) -> tuple[float, float] | None:
    manifest = _read_json(manifest_path, {})
    chunks = manifest.get("chunks")
    if not isinstance(chunks, list):
        return None
    intervals = sorted(
        (
            max(0, int(chunk.get("startedOffsetMs", 0))),
            max(0, int(chunk.get("endedOffsetMs", 0))),
        )
        for chunk in chunks
        if isinstance(chunk, dict)
    )
    merged: list[tuple[int, int]] = []
    for start, end in intervals:
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    active_ms = sum(end - start for start, end in merged)
    total_ms = max((end for _, end in intervals), default=0)
    started_at = manifest.get("startedAt")
    ended_at = manifest.get("endedAt")
    if isinstance(started_at, str) and isinstance(ended_at, str):
        try:
            total_ms = max(
                total_ms,
                round((datetime.fromisoformat(ended_at.replace("Z", "+00:00")) - datetime.fromisoformat(started_at.replace("Z", "+00:00"))).total_seconds() * 1_000),
            )
        except ValueError:
            pass
    return total_ms / 1_000, active_ms / 1_000


def _now() -> str:
    return datetime.now(UTC).isoformat()
