from __future__ import annotations

import json
import math
import os
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


_OUTCOMES = ("started", "success", "warning", "failure", "skipped", "info")


class DiagnosticReporter:
    """Append-only diagnostics for transcription jobs without storing transcript text."""

    def __init__(self, data_dir: Path, enabled: bool = True) -> None:
        self.root = data_dir / ".diagnostics"
        self.enabled = enabled
        self._lock = threading.RLock()
        self._sequence = 0

    def record(
        self,
        session_id: str,
        process: str,
        outcome: str,
        message: str,
        *,
        job_id: str | None = None,
        duration_ms: float | int | None = None,
        evidence: list[str] | tuple[str, ...] | None = None,
        metrics: dict[str, Any] | None = None,
        error: BaseException | str | None = None,
    ) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        if outcome not in _OUTCOMES:
            raise ValueError(f"Unsupported diagnostic outcome: {outcome}")

        with self._lock:
            self._sequence += 1
            timestamp = _now()
            event: dict[str, Any] = {
                "version": 1,
                "id": f"{int(datetime.now(UTC).timestamp() * 1000)}-{os.getpid()}-{self._sequence}",
                "timestamp": timestamp,
                "session_id": session_id or "_system",
                "component": "transcriber",
                "process": process or "unknown",
                "outcome": outcome,
                "message": message.strip(),
            }
            if job_id:
                event["job_id"] = job_id
            if duration_ms is not None and math.isfinite(float(duration_ms)):
                event["duration_ms"] = max(0, round(float(duration_ms)))
            if evidence:
                event["evidence"] = [str(item).strip() for item in evidence if str(item).strip()][:30]
            if metrics:
                event["metrics"] = _sanitize_metrics(metrics)
            serialized_error = _serialize_error(error)
            if serialized_error is not None:
                event["error"] = serialized_error

            directory = self._session_directory(session_id)
            directory.mkdir(parents=True, exist_ok=True)
            with (directory / "activity.transcriber.jsonl").open("a", encoding="utf-8", newline="\n") as stream:
                stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")))
                stream.write("\n")
                stream.flush()

            self._update_session_report(directory, event)
            if job_id:
                self._update_job_report(directory, job_id, event)
            return event

    def read_session_report(self, session_id: str) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        return _read_json(self._session_directory(session_id) / "report.transcriber.json")

    def read_job_report(self, session_id: str, job_id: str) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        path = self._session_directory(session_id) / "jobs" / f"{_safe_path_segment(job_id)}.json"
        return _read_json(path)

    def _session_directory(self, session_id: str) -> Path:
        return self.root / _safe_path_segment(session_id or "_system")

    def _update_session_report(self, directory: Path, event: dict[str, Any]) -> None:
        path = directory / "report.transcriber.json"
        report = _read_json(path) or {
            "version": 1,
            "session_id": event["session_id"],
            "component": "transcriber",
            "updated_at": event["timestamp"],
            "event_count": 0,
            "outcomes": _empty_outcomes(),
            "processes": {},
            "recent_failures": [],
            "last_event": event,
        }
        report["updated_at"] = event["timestamp"]
        report["event_count"] = int(report.get("event_count", 0)) + 1
        outcomes = report.setdefault("outcomes", _empty_outcomes())
        outcomes[event["outcome"]] = int(outcomes.get(event["outcome"], 0)) + 1
        report["last_event"] = event

        processes = report.setdefault("processes", {})
        process = processes.setdefault(
            event["process"],
            {
                "events": 0,
                "outcomes": _empty_outcomes(),
                "total_duration_ms": 0,
                "timed_events": 0,
                "last_event": event,
            },
        )
        process["events"] = int(process.get("events", 0)) + 1
        process_outcomes = process.setdefault("outcomes", _empty_outcomes())
        process_outcomes[event["outcome"]] = int(process_outcomes.get(event["outcome"], 0)) + 1
        process["last_event"] = event
        if "duration_ms" in event:
            process["total_duration_ms"] = int(process.get("total_duration_ms", 0)) + int(event["duration_ms"])
            process["timed_events"] = int(process.get("timed_events", 0)) + 1

        if event["outcome"] == "failure":
            report["recent_failures"] = [*report.get("recent_failures", []), event][-20:]
        _write_json_atomically(path, report)

    def _update_job_report(self, directory: Path, job_id: str, event: dict[str, Any]) -> None:
        jobs_directory = directory / "jobs"
        jobs_directory.mkdir(parents=True, exist_ok=True)
        path = jobs_directory / f"{_safe_path_segment(job_id)}.json"
        report = _read_json(path) or {
            "version": 1,
            "session_id": event["session_id"],
            "job_id": job_id,
            "component": "transcriber",
            "started_at": event["timestamp"],
            "updated_at": event["timestamp"],
            "event_count": 0,
            "outcomes": _empty_outcomes(),
            "events": [],
        }
        report["updated_at"] = event["timestamp"]
        report["event_count"] = int(report.get("event_count", 0)) + 1
        outcomes = report.setdefault("outcomes", _empty_outcomes())
        outcomes[event["outcome"]] = int(outcomes.get(event["outcome"], 0)) + 1
        report.setdefault("events", []).append(event)
        report["last_event"] = event
        if event["process"] == "job" and event["outcome"] in {"success", "failure", "skipped"}:
            report["final_outcome"] = event["outcome"]
            report["finished_at"] = event["timestamp"]
        _write_json_atomically(path, report)


def summarize_transcription_result(
    result: dict[str, Any],
    *,
    wall_seconds: float,
    gpu_seconds: float,
    speech_ratio: float,
    rms_dbfs: float,
) -> dict[str, Any]:
    segments = list(result.get("segments") or [])
    word_probabilities: list[float] = []
    word_count = 0
    suspected = 0
    accepted = 0
    for segment in segments:
        if segment.get("status") == "suspected_hallucination":
            suspected += 1
        else:
            accepted += 1
        for word in segment.get("words") or []:
            text = str(word.get("text") or "").strip()
            if text:
                word_count += 1
            probability = word.get("probability")
            if isinstance(probability, (int, float)) and math.isfinite(float(probability)):
                word_probabilities.append(float(probability))

    audio_seconds = max(0.0, float(result.get("duration_seconds") or 0.0))
    vad_seconds = max(0.0, float(result.get("duration_after_vad_seconds") or 0.0))
    metrics: dict[str, Any] = {
        "status": str(result.get("status") or "unknown"),
        "device": str(result.get("device") or "unknown"),
        "language": str(result.get("language") or "unknown"),
        "audio_seconds": round(audio_seconds, 3),
        "audio_after_vad_seconds": round(vad_seconds, 3),
        "wall_seconds": round(max(0.0, wall_seconds), 3),
        "gpu_seconds": round(max(0.0, gpu_seconds), 3),
        "speech_ratio": round(max(0.0, min(1.0, speech_ratio)), 4),
        "rms_dbfs": round(rms_dbfs, 2),
        "segments_total": len(segments),
        "segments_accepted": accepted,
        "segments_suspected_hallucination": suspected,
        "word_count": word_count,
        "average_word_confidence": (
            round(sum(word_probabilities) / len(word_probabilities), 4)
            if word_probabilities
            else None
        ),
    }
    language_probability = result.get("language_probability")
    if isinstance(language_probability, (int, float)) and math.isfinite(float(language_probability)):
        metrics["language_probability"] = round(float(language_probability), 4)
    if wall_seconds > 0 and vad_seconds > 0:
        metrics["realtime_factor"] = round(wall_seconds / vad_seconds, 4)
        metrics["audio_seconds_per_wall_second"] = round(vad_seconds / wall_seconds, 3)
    return metrics


def _safe_path_segment(value: str) -> str:
    safe = "".join(character if character.isalnum() or character in "._-" else "_" for character in value)
    return safe[:160] or "_system"


def _empty_outcomes() -> dict[str, int]:
    return {name: 0 for name in _OUTCOMES}


def _sanitize_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}
    for key, value in metrics.items():
        lowered = key.lower()
        if any(secret in lowered for secret in ("token", "secret", "authorization", "password")):
            sanitized[key] = "[REDACTED]"
        elif value is None or isinstance(value, (str, int, float, bool)):
            sanitized[key] = value
        else:
            sanitized[key] = str(value)
    return sanitized


def _serialize_error(error: BaseException | str | None) -> dict[str, str] | None:
    if error is None:
        return None
    if isinstance(error, BaseException):
        return {"name": type(error).__name__, "message": str(error)}
    return {"message": str(error)}


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (FileNotFoundError, OSError, ValueError, TypeError):
        return None


def _write_json_atomically(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _now() -> str:
    return datetime.now(UTC).isoformat()
