from __future__ import annotations

import hmac
import json
import logging
import os
import re
import shutil
import sqlite3
import sys
import threading
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .config import Settings, configured_data_dir
from .diagnostics import DiagnosticReporter, summarize_transcription_result
from .engine import WhisperEngine
from .error_codes import classify_transcription_error
from .storage import JobInput, JobStore
from .instance_lock import InstanceLockError, TranscriberInstanceLock, reject_unsupported_process_mode
from .session_file_coordinator import (
    SessionCoordinationError, SessionFileCoordinator, SessionLockConflict,
    SessionLockPermissionError, SessionLockTimeout,
)
from .voice_processing import AdaptiveVoiceProcessor, VoiceAnalysis

logger = logging.getLogger("dotty.transcriber")
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logger.addHandler(handler)
settings: Settings
store: JobStore
engine: WhisperEngine
voice_processor: AdaptiveVoiceProcessor
diagnostics: DiagnosticReporter
stop_event = threading.Event()
_active_lock: TranscriberInstanceLock | None = None


class JobRequest(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    audio_path: str = Field(min_length=1)
    speaker_user_id: str = Field(min_length=1, max_length=100)
    start_offset_ms: int = Field(ge=0)
    language: str = Field(default="es", min_length=2, max_length=10)
    initial_prompt: str = Field(default="", max_length=4000)
    hotwords: str = Field(default="", max_length=2000)


class JobDeletionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    operation_id: str
    operation_type: Literal["reprocess", "administrative_delete", "manual_recovery"]
    # No operation-specific parameters have been defined yet. Reject rather than
    # persist an unversioned meaning that a later release might reinterpret.
    parameters: dict[str, Any]

    @field_validator("operation_id")
    @classmethod
    def canonical_operation_id(cls, value: str) -> str:
        try:
            if str(uuid.UUID(value)) != value:
                raise ValueError("Operation ID must be a canonical UUID")
        except (AttributeError, ValueError) as error:
            raise ValueError("Operation ID must be a canonical UUID") from error
        return value

    @field_validator("parameters")
    @classmethod
    def empty_parameters(cls, value: dict[str, Any]) -> dict[str, Any]:
        if value:
            raise ValueError("No operation parameters are defined")
        return value


def _canonical_operation_id(value: str) -> str:
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError
    except (AttributeError, ValueError) as error:
        raise HTTPException(status_code=422, detail={"code": "INVALID_OPERATION_ID"}) from error
    return value


def _deletion_projection(operation: dict[str, Any]) -> dict[str, Any]:
    return {
        "operation_id": operation["operation_id"],
        "session_id": operation["session_id"],
        "operation_type": operation["operation_type"],
        "parameters_hash": operation["parameters_hash"],
        "close_id": operation["close_id"],
        "status": operation["status"],
        "targets": [
            {key: target[key] for key in (
                "job_id", "generation_id", "observation_id", "identity_status",
                "observed_status", "observed_provenance",
            )}
            for target in operation["targets"]
        ],
        "workers_inactive": None,
        "jobs_deleted": False,
    }


def _deletion_store_error(error: Exception) -> HTTPException:
    if isinstance(error, sqlite3.Error):
        logger.exception("Job deletion state could not be confirmed")
        return HTTPException(status_code=503, detail={"code": "JOB_DELETION_STATE_UNCERTAIN"})
    if isinstance(error, ValueError):
        code = ("OPERATION_ID_CONFLICT" if "Operation ID conflicts" in str(error)
                else "SESSION_ADMISSION_CLOSED")
        return HTTPException(status_code=409, detail={"code": code})
    logger.exception("Unexpected job deletion preparation failure")
    return HTTPException(status_code=503, detail={"code": "JOB_DELETION_STATE_UNCERTAIN"})


def authorize(authorization: Annotated[str | None, Header()] = None) -> None:
    expected = f"Bearer {settings.secret}"
    if authorization is None or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


@asynccontextmanager
async def lifespan(_: FastAPI):
    global settings, store, engine, voice_processor, diagnostics, _active_lock
    if _active_lock is not None:
        raise InstanceLockError("A previous transcriber lifespan still owns the data directory")
    reject_unsupported_process_mode(sys.argv, os.environ)
    lock = TranscriberInstanceLock.acquire(configured_data_dir())
    _active_lock = lock
    workers: list[threading.Thread] = []
    initialized = False
    try:
        # Acquiring the OS lock precedes Settings' secret creation and every
        # JobStore schema/recovery operation. Module import has no DB effects.
        settings = Settings.from_environment(data_dir=lock.directory)
        store = JobStore(settings.database_path, instance_lock=lock)
        engine = WhisperEngine(settings)
        voice_processor = AdaptiveVoiceProcessor(settings)
        diagnostics = DiagnosticReporter(settings.data_dir, enabled=settings.diagnostics_enabled)
        initialized = True
        stop_event.clear()
        workers = [
            threading.Thread(target=_worker_loop, name=f"transcriber-worker-{index + 1}", daemon=True)
            for index in range(settings.gpu_workers)
        ]
        for worker in workers:
            worker.start()
        logger.info("[Transcription] GPU worker concurrency=%s", settings.gpu_workers)
        _record_diagnostic(
            "_system", "service", "success",
            "Servicio de transcripción iniciado y listo para recibir trabajos.",
            evidence=["workers_started", "job_store_open"],
            metrics={
                "gpu_workers": settings.gpu_workers,
                "model": settings.model,
                "configured_device": settings.device,
                "compute_type": settings.compute_type,
                "diagnostics_enabled": settings.diagnostics_enabled,
            },
        )
        yield
    finally:
        stop_event.set()
        for worker in workers:
            if worker.ident is not None:
                worker.join(timeout=10)
        alive = [worker.name for worker in workers if worker.is_alive()]
        if initialized:
            _record_diagnostic(
                "_system", "service", "warning" if alive else "info",
                "El cierre dejó workers activos; se conserva el bloqueo." if alive else
                "Servicio de transcripción detenido.",
                evidence=["stop_event_set", "workers_still_alive" if alive else "workers_joined"],
                metrics={"workers_still_alive": len(alive)},
            )
        if alive:
            logger.error("Transcriber workers remain alive; retaining data-directory lock: %s", alive)
        else:
            lock.release()
            _active_lock = None


app = FastAPI(title="Dotty Transcriber", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "pid": os.getpid(),
        "launch_id": os.environ.get("DOTTY_TRANSCRIBER_LAUNCH_ID"),
        "model": settings.model,
        "configured_device": settings.device,
        "active_device": engine.active_device,
        "compute_type": settings.compute_type,
        **engine.runtime_status,
        "diagnostics_enabled": settings.diagnostics_enabled,
        "queue": store.metrics(),
        "processing_paused": store.processing_paused(),
        "work": store.current_work(),
    }


@app.post("/v1/processing/pause", dependencies=[Depends(authorize)])
def pause_processing() -> dict[str, Any]:
    return {"paused": store.set_processing_paused(True), "active_work": store.current_work()}


@app.post("/v1/processing/resume", dependencies=[Depends(authorize)])
def resume_processing() -> dict[str, Any]:
    return {"paused": store.set_processing_paused(False)}


@app.post("/v1/jobs", dependencies=[Depends(authorize)])
def enqueue(request: JobRequest) -> dict[str, Any]:
    audio_path = Path(request.audio_path).resolve()
    try:
        audio_path.relative_to(settings.recordings_dir)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Audio path is outside recordings directory") from error
    if not audio_path.is_file():
        raise HTTPException(status_code=400, detail="Audio file does not exist")
    try:
        payload = request.model_dump()
        payload["audio_path"] = str(audio_path)
        session_id = _session_id(request.id)
        with _session_mutation_lock(session_id):
            job = store.enqueue(JobInput(**payload))
        _record_diagnostic(
            session_id,
            "queue",
            "success",
            "Trabajo aceptado por la cola del transcriptor.",
            job_id=request.id,
            evidence=["audio_path_validated", "audio_file_exists", "job_persisted"],
            metrics={
                "speaker_user_id": request.speaker_user_id,
                "start_offset_ms": request.start_offset_ms,
                "language": request.language,
            },
        )
        return job
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(authorize)])
def get_job(job_id: str) -> dict[str, Any]:
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/v1/jobs/{job_id}/diagnostics", dependencies=[Depends(authorize)])
def get_job_diagnostics(job_id: str) -> dict[str, Any]:
    return {
        "session_id": _session_id(job_id),
        "job_id": job_id,
        "report": diagnostics.read_job_report(_session_id(job_id), job_id),
    }


@app.post("/v1/jobs/{job_id}/retry", dependencies=[Depends(authorize)])
def retry_job(job_id: str) -> dict[str, Any]:
    with _session_mutation_lock(_session_id(job_id)):
        job = store.retry(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    _record_diagnostic(
        _session_id(job_id),
        "retry",
        "info",
        "Trabajo marcado para reintento.",
        job_id=job_id,
        evidence=["job_found", "retry_state_persisted"],
    )
    return job


@app.get("/v1/metrics", dependencies=[Depends(authorize)])
def metrics() -> dict[str, int]:
    return store.metrics()


@app.get("/v1/failures", dependencies=[Depends(authorize)])
def failures() -> dict[str, Any]:
    return {"sessions": store.failed_sessions()}


@app.post("/v1/model/unload", dependencies=[Depends(authorize)])
def unload_model() -> dict[str, Any]:
    metrics = store.metrics()
    if metrics.get("processing", 0) > 0 or metrics.get("queued", 0) > 0:
        raise HTTPException(status_code=409, detail="Transcription queue is not idle")
    unloaded = engine.unload()
    _record_diagnostic(
        "_system",
        "model",
        "success" if unloaded else "skipped",
        "Modelo Whisper descargado de memoria." if unloaded else "No había un modelo Whisper cargado para descargar.",
        metrics={"active_device": engine.active_device},
    )
    return {"unloaded": unloaded}


@app.get("/v1/sessions/{session_id}", dependencies=[Depends(authorize)])
def session_jobs(session_id: str) -> dict[str, Any]:
    return {"session_id": session_id, "jobs": store.list_for_session(session_id)}


@app.get("/v1/sessions/{session_id}/diagnostics", dependencies=[Depends(authorize)])
def session_diagnostics(session_id: str) -> dict[str, Any]:
    return {"session_id": session_id, "report": diagnostics.read_session_report(session_id)}


@app.get("/v1/sessions/{session_id}/progress", dependencies=[Depends(authorize)])
def session_progress(session_id: str) -> dict[str, Any]:
    return {"session_id": session_id, **store.session_progress(session_id)}


@app.post("/v1/sessions/{session_id}/job-deletions", status_code=202,
          dependencies=[Depends(authorize)])
def prepare_session_job_deletion(session_id: str, request: JobDeletionRequest) -> dict[str, Any]:
    if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id) is None:
        raise HTTPException(status_code=422, detail={"code": "INVALID_SESSION_ID"})
    try:
        with _session_mutation_lock(session_id):
            operation = store.prepare_job_deletion(
                request.operation_id, session_id, request.operation_type, request.parameters,
            )
    except HTTPException:
        raise
    except Exception as error:
        raise _deletion_store_error(error) from error
    return _deletion_projection(operation)


@app.get("/v1/job-deletions/{operation_id}", dependencies=[Depends(authorize)])
def get_job_deletion(operation_id: str) -> dict[str, Any]:
    _canonical_operation_id(operation_id)
    try:
        operation = store.job_deletion_operation(operation_id)
    except Exception as error:
        raise _deletion_store_error(error) from error
    if operation is None:
        raise HTTPException(status_code=404, detail={"code": "JOB_DELETION_NOT_FOUND"})
    return _deletion_projection(operation)


@app.delete("/v1/sessions/{session_id}", dependencies=[Depends(authorize)])
def delete_session_jobs(session_id: str) -> dict[str, Any]:
    raise HTTPException(status_code=410, detail={"code": "LEGACY_JOB_DELETE_DISABLED"})


@app.post("/v1/sessions/{session_id}/retry", dependencies=[Depends(authorize)])
def retry_session_jobs(session_id: str) -> dict[str, Any]:
    with _session_mutation_lock(session_id):
        retried = store.retry_failed_for_session(session_id)
    _record_diagnostic(
        session_id,
        "retry",
        "info",
        "Trabajos fallidos de la sesión marcados para reintento.",
        metrics={"retried_jobs": retried},
    )
    return {"session_id": session_id, "retried": retried}


@app.post("/v1/sessions/{session_id}/retranscribe", dependencies=[Depends(authorize)])
def retranscribe_session(session_id: str) -> dict[str, Any]:
    if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id) is None:
        raise HTTPException(status_code=422, detail="Sesión inválida")
    with _session_mutation_lock(session_id):
        return _retranscribe_session_locked(session_id)


@contextmanager
def _session_mutation_lock(session_id: str):
    try:
        coordinator = SessionFileCoordinator(settings.data_dir, node_data_dir=configured_data_dir())
        with coordinator.acquire(session_id, timeout_ms=4_000):
            yield
    except SessionLockTimeout as error:
        raise HTTPException(status_code=423, detail={"code": "SESSION_LOCK_TIMEOUT"}) from error
    except SessionLockConflict as error:
        raise HTTPException(status_code=409, detail={"code": "SESSION_LOCK_CONFLICT"}) from error
    except SessionLockPermissionError as error:
        raise HTTPException(status_code=503, detail={"code": "SESSION_LOCK_PERMISSION"}) from error
    except SessionCoordinationError as error:
        raise HTTPException(status_code=503, detail={"code": "SESSION_LOCK_CONFIGURATION"}) from error


def _retranscribe_session_locked(session_id: str) -> dict[str, Any]:
    recording_dir = settings.recordings_dir / session_id
    manifest_path = recording_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=404, detail="No se encontró la grabación de la sesión") from error
    if manifest.get("sessionId") != session_id or manifest.get("status") not in ("completed", "interrupted"):
        raise HTTPException(status_code=409, detail="Termina la grabación antes de rehacer la transcripción")
    jobs = store.list_for_session(session_id)
    if not jobs:
        raise HTTPException(status_code=404, detail="No hay fragmentos para volver a transcribir")
    regeneration_marker = recording_dir / ".transcription-regenerating"
    already_running = any(job["status"] in ("queued", "processing") for job in jobs)
    if already_running and not regeneration_marker.is_file():
        raise HTTPException(status_code=409, detail="La transcripción de esta sesión ya está en curso")
    if not already_running and regeneration_marker.is_file():
        raise HTTPException(status_code=409, detail="La regeneración anterior aún no terminó")
    allowed_audio_roots = (recording_dir.resolve(), (settings.data_dir / "recovered-audio" / session_id).resolve())
    for job in jobs:
        audio_path = Path(job["audio_path"]).resolve()
        if not any(audio_path.is_relative_to(root) for root in allowed_audio_roots) or not audio_path.is_file():
            raise HTTPException(status_code=409, detail="Falta audio original para rehacer esta sesión")

    export_dir = settings.data_dir / "exports" / session_id
    raw_path = export_dir / "transcript.raw.json"
    backup_created = False
    stale_markers = {}
    for name in (".transcription-ready", ".transcription-published", ".transcription-failed"):
        path = recording_dir / name
        try:
            stale_markers[path] = path.stat()
        except FileNotFoundError:
            pass

    def prepare_artifacts() -> None:
        nonlocal backup_created
        marker_content = f"{time.time()}-{uuid.uuid4().hex}\n"
        try:
            with regeneration_marker.open("x", encoding="utf-8") as marker:
                marker.write(marker_content)
        except FileExistsError as error:
            raise ValueError("La regeneración anterior aún no terminó") from error
        try:
            if raw_path.is_file():
                backup_path = export_dir / "transcript.raw.respaldo.json"
                temporary = export_dir / f".transcript.raw.respaldo-{uuid.uuid4().hex}.tmp"
                try:
                    shutil.copyfile(raw_path, temporary)
                    os.replace(temporary, backup_path)
                    backup_created = True
                finally:
                    temporary.unlink(missing_ok=True)
            for path, observed in stale_markers.items():
                try:
                    current = path.stat()
                except FileNotFoundError:
                    continue
                if (current.st_ino, current.st_ctime_ns, current.st_mtime_ns, current.st_size) == (
                    observed.st_ino, observed.st_ctime_ns, observed.st_mtime_ns, observed.st_size
                ):
                    path.unlink(missing_ok=True)
        except BaseException:
            if regeneration_marker.read_text(encoding="utf-8") == marker_content:
                regeneration_marker.unlink(missing_ok=True)
            raise

    try:
        result = store.retranscribe_session(session_id, on_accepted=prepare_artifacts)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    _record_diagnostic(
        session_id, "retranscribe", "info", "Fragmentos de audio reenviados para rehacer el raw.",
        metrics={"queued_jobs": result["queued"], "total_jobs": result["total"]},
    )
    return {"session_id": session_id, **result, "backup": backup_created}


def _worker_loop() -> None:
    while not stop_event.is_set():
        try:
            worker_store = store
            job = worker_store.claim_next()
        except Exception:
            logger.exception("Could not claim job; worker will retry")
            stop_event.wait(1)
            continue
        if job is None:
            stop_event.wait(0.5)
            continue
        job_started = time.perf_counter()
        session_id = _session_id(str(job["id"]))
        release_allowed = True
        try:
            _record_diagnostic(
                session_id,
                "job",
                "started",
                "Worker tomó el trabajo y comenzó a procesarlo.",
                job_id=job["id"],
                evidence=["job_claimed", "claim_token_assigned"],
                metrics={
                    "speaker_user_id": job["speaker_user_id"],
                    "attempts": job["attempts"],
                    "start_offset_ms": job["start_offset_ms"],
                },
            )
            logger.info(
                "Starting transcription job=%s audio=%s speaker=%s attempts=%s",
                job["id"],
                job["audio_path"],
                job["speaker_user_id"],
                job["attempts"],
            )
            audio_path = Path(job["audio_path"])
            analysis_started = time.perf_counter()
            analysis_fallback = False
            try:
                analysis = voice_processor.analyze(audio_path, job["speaker_user_id"], session_id)
            except Exception as error:
                logger.exception("[VAD] Analysis failed; using conservative SPEECH fallback")
                analysis_fallback = True
                analysis = VoiceAnalysis(
                    "SPEECH", 0.0, 0.0, 1.0, -120.0,
                    {
                        "threshold": settings.vad_threshold,
                        "min_silence_duration_ms": settings.vad_min_silence_ms,
                        "speech_pad_ms": settings.vad_speech_pad_ms,
                    },
                )
                _record_diagnostic(
                    session_id,
                    "voice_analysis",
                    "warning",
                    "El análisis VAD falló; Dotty usó el fallback conservador SPEECH para no perder audio.",
                    job_id=job["id"],
                    issue="VAD_ANALYSIS_FAILED_FALLBACK",
                    duration_ms=(time.perf_counter() - analysis_started) * 1000,
                    evidence=["vad_exception", "fallback_speech_selected"],
                    error=error,
                )
            if not analysis_fallback:
                _record_diagnostic(
                    session_id,
                    "voice_analysis",
                    "success",
                    f"VAD clasificó el audio como {analysis.state}.",
                    job_id=job["id"],
                    duration_ms=(time.perf_counter() - analysis_started) * 1000,
                    evidence=[
                        "speech_timestamps_detected" if analysis.state == "SPEECH" else "no_speech_timestamps_detected",
                        "adaptive_vad_parameters_applied",
                    ],
                    metrics={
                        "state": analysis.state,
                        "duration_seconds": round(analysis.duration_seconds, 3),
                        "speech_seconds": round(analysis.speech_seconds, 3),
                        "speech_ratio": round(analysis.speech_ratio, 4),
                        "rms_dbfs": round(analysis.rms_dbfs, 2),
                        "vad_threshold": analysis.vad_parameters["threshold"],
                        "vad_min_silence_ms": analysis.vad_parameters["min_silence_duration_ms"],
                        "vad_speech_pad_ms": analysis.vad_parameters["speech_pad_ms"],
                    },
                )

            if analysis.state == "NON_SPEECH":
                logger.info("[VAD] User %s non-speech ignored", job["speaker_user_id"])
                result = {
                    "device": engine.active_device,
                    "language": job["language"],
                    "duration_seconds": analysis.duration_seconds,
                    "duration_after_vad_seconds": 0.0,
                    "segments": [],
                    "status": "non_speech",
                }
                gpu_seconds = 0.0
                transcription_wall_seconds = 0.0
                _record_diagnostic(
                    session_id,
                    "whisper",
                    "skipped",
                    "Whisper no se ejecutó porque VAD no detectó voz útil.",
                    job_id=job["id"],
                    evidence=["vad_state_non_speech", "gpu_work_avoided"],
                    metrics={
                        "duration_seconds": round(analysis.duration_seconds, 3),
                        "speech_ratio": round(analysis.speech_ratio, 4),
                    },
                )
            else:
                logger.info(
                    "[VAD] User %s speech detected; pre-buffer=%sms hangover=%sms",
                    job["speaker_user_id"],
                    analysis.vad_parameters["speech_pad_ms"],
                    analysis.vad_parameters["min_silence_duration_ms"],
                )
                _record_diagnostic(
                    session_id,
                    "whisper",
                    "started",
                    "Whisper comenzó la transcripción del fragmento con voz detectada.",
                    job_id=job["id"],
                    evidence=["vad_state_speech", "whisper_request_started"],
                    metrics={
                        "model": settings.model,
                        "configured_device": settings.device,
                        "compute_type": settings.compute_type,
                    },
                )
                started = time.perf_counter()
                result = engine.transcribe(
                    audio_path,
                    job["language"],
                    job["initial_prompt"],
                    job["hotwords"],
                    lambda progress, processed, duration: worker_store.update_progress(
                        job["id"], job["claim_token"], progress, processed, duration,
                        phase="transcribing"
                    ),
                    analysis.vad_parameters,
                )
                transcription_wall_seconds = time.perf_counter() - started
                gpu_seconds = transcription_wall_seconds if engine.active_device == "cuda" else 0.0
                result_metrics = summarize_transcription_result(
                    result,
                    wall_seconds=transcription_wall_seconds,
                    gpu_seconds=gpu_seconds,
                    speech_ratio=analysis.speech_ratio,
                    rms_dbfs=analysis.rms_dbfs,
                )
                suspected = int(result_metrics.get("segments_suspected_hallucination", 0) or 0)
                unintelligible = result.get("status") == "unintelligible"
                outcome = "warning" if unintelligible or suspected > 0 else "success"
                evidence = ["whisper_completed", "segment_quality_classification_applied"]
                if suspected > 0:
                    evidence.append("suspicious_segments_preserved_and_marked")
                if result.get("status") == "transcribed" and suspected == 0:
                    evidence.append("all_returned_segments_passed_primary_quality_checks")
                _record_diagnostic(
                    session_id,
                    "whisper",
                    outcome,
                    (
                        "Whisper terminó con segmentos que requieren revisión."
                        if outcome == "warning"
                        else "Whisper terminó correctamente y los segmentos devueltos pasaron los controles primarios."
                    ),
                    job_id=job["id"],
                    issue="WHISPER_UNINTELLIGIBLE" if unintelligible else None,
                    duration_ms=transcription_wall_seconds * 1000,
                    evidence=evidence,
                    metrics=result_metrics,
                )
                if suspected > 0:
                    _record_diagnostic(
                        session_id,
                        "validation",
                        "warning",
                        "La validación marcó segmentos como posibles alucinaciones y los preservó para revisión.",
                        job_id=job["id"],
                        issue="SUSPECTED_HALLUCINATION",
                        evidence=["suspected_hallucination_detected", "segment_preserved_for_review"],
                        metrics={"suspected_segments": suspected},
                    )
                if unintelligible:
                    logger.info("[Whisper] Segment marked unintelligible user=%s", job["speaker_user_id"])

            result["speaker_user_id"] = job["speaker_user_id"]
            result["start_offset_ms"] = job["start_offset_ms"]
            result["audio_reference"] = job["audio_path"]
            result["voice_analysis"] = {
                "state": analysis.state,
                "duration_seconds": analysis.duration_seconds,
                "speech_seconds": analysis.speech_seconds,
                "speech_ratio": analysis.speech_ratio,
                "rms_dbfs": analysis.rms_dbfs,
            }
            if worker_store.complete(job["id"], job["claim_token"], result):
                _record_diagnostic(
                    session_id,
                    "persistence",
                    "success",
                    "Resultado de transcripción guardado en la cola persistente.",
                    job_id=job["id"],
                    evidence=["claim_token_valid", "result_committed"],
                    metrics={
                        "status": result.get("status", "unknown"),
                        "segments": len(result.get("segments", [])),
                    },
                )
                try:
                    voice_processor.record_result(
                        session_id,
                        job["speaker_user_id"],
                        analysis,
                        result,
                        gpu_seconds,
                        job["audio_path"],
                    )
                    _record_diagnostic(
                        session_id,
                        "voice_metrics",
                        "success",
                        "Métricas de voz y perfil adaptativo actualizados.",
                        job_id=job["id"],
                        evidence=["voice_event_recorded", "voice_metrics_updated"],
                    )
                except Exception as error:
                    logger.exception("Could not record voice metrics job=%s", job["id"])
                    _record_diagnostic(
                        session_id,
                        "voice_metrics",
                        "failure",
                        "La transcripción terminó, pero no se pudieron guardar las métricas de voz.",
                        job_id=job["id"],
                        issue="VOICE_METRICS_WRITE_FAILED",
                        error=error,
                    )
                logger.info("Completed transcription job=%s segments=%d", job["id"], len(result.get("segments", [])))
                _record_diagnostic(
                    session_id,
                    "job",
                    "success",
                    "Trabajo de transcripción completado de punta a punta.",
                    job_id=job["id"],
                    duration_ms=(time.perf_counter() - job_started) * 1000,
                    evidence=["voice_analysis_completed", "transcription_decision_completed", "result_persisted"],
                    metrics={
                        "result_status": result.get("status", "unknown"),
                        "segments": len(result.get("segments", [])),
                        "active_device": engine.active_device,
                        "attempts": job["attempts"],
                    },
                )
            else:
                logger.info("Discarded stale transcription result job=%s", job["id"])
                _record_diagnostic(
                    session_id,
                    "persistence",
                    "warning",
                    "Resultado descartado porque el claim del trabajo ya no era vigente.",
                    job_id=job["id"],
                    issue="STALE_CLAIM_DISCARDED",
                    evidence=["stale_claim_token", "result_not_committed"],
                )
                _record_diagnostic(
                    session_id,
                    "job",
                    "skipped",
                    "Trabajo finalizado sin publicar su resultado porque otro claim lo reemplazó.",
                    job_id=job["id"],
                    duration_ms=(time.perf_counter() - job_started) * 1000,
                    evidence=["stale_result_discarded"],
                )
        except Exception as error:
            logger.exception("Transcription job %s failed", job["id"])
            worker_store.fail(job["id"], job["claim_token"], str(error))
            cause_issue = classify_transcription_error(error)
            _record_diagnostic(
                session_id,
                "failure_cause",
                "failure",
                "Dotty clasificó la causa técnica principal del fallo de transcripción.",
                job_id=job["id"],
                issue=cause_issue,
                evidence=["exception_classified", "specific_issue_code_assigned"],
                metrics={"active_device": engine.active_device},
                error=error,
            )
            _record_diagnostic(
                session_id,
                "job",
                "failure",
                "Trabajo de transcripción falló y quedó registrado para diagnóstico/reintento.",
                job_id=job["id"],
                issue="TRANSCRIPTION_JOB_FAILED",
                duration_ms=(time.perf_counter() - job_started) * 1000,
                evidence=["exception_captured", "job_marked_failed", f"cause={cause_issue}"],
                metrics={"attempts": job["attempts"], "active_device": engine.active_device},
                error=error,
            )
            time.sleep(1)
        except BaseException:
            # An interrupted native call may leave work whose completion cannot
            # be verified here. Keep the durable occupation for reconciliation.
            release_allowed = False
            logger.exception("Worker interrupted; retaining occupation job=%s", job["id"])
            raise
        finally:
            if release_allowed:
                try:
                    released = worker_store.release_occupation(
                        job["occupation_id"], job["id"], job["claim_token"]
                    )
                    if not released:
                        logger.error("Occupation release was not verified job=%s occupation=%s",
                                     job["id"], job["occupation_id"])
                except Exception:
                    logger.exception("Could not release occupation job=%s occupation=%s",
                                     job["id"], job["occupation_id"])


def _session_id(job_id: str) -> str:
    return str(job_id).split(":", 1)[0]


def _record_diagnostic(
    session_id: str,
    process: str,
    outcome: str,
    message: str,
    *,
    job_id: str | None = None,
    issue: str | None = None,
    duration_ms: float | int | None = None,
    evidence: list[str] | tuple[str, ...] | None = None,
    metrics: dict[str, Any] | None = None,
    error: BaseException | str | None = None,
) -> None:
    try:
        diagnostics.record(
            session_id,
            process,
            outcome,
            message,
            job_id=job_id,
            issue=issue,
            duration_ms=duration_ms,
            evidence=evidence,
            metrics=metrics,
            error=error,
        )
    except Exception:
        logger.exception("Could not persist hidden diagnostics process=%s session=%s", process, session_id)
