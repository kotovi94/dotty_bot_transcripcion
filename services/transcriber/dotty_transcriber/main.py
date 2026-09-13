from __future__ import annotations

import hmac
import logging
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

from .config import Settings
from .diagnostics import DiagnosticReporter, summarize_transcription_result
from .engine import WhisperEngine
from .storage import JobInput, JobStore
from .voice_processing import AdaptiveVoiceProcessor, VoiceAnalysis

logger = logging.getLogger("dotty.transcriber")
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logger.addHandler(handler)
settings = Settings.from_environment()
store = JobStore(settings.database_path)
engine = WhisperEngine(settings)
voice_processor = AdaptiveVoiceProcessor(settings)
diagnostics = DiagnosticReporter(settings.data_dir, enabled=settings.diagnostics_enabled)
stop_event = threading.Event()


class JobRequest(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    audio_path: str = Field(min_length=1)
    speaker_user_id: str = Field(min_length=1, max_length=100)
    start_offset_ms: int = Field(ge=0)
    language: str = Field(default="es", min_length=2, max_length=10)
    initial_prompt: str = Field(default="", max_length=4000)
    hotwords: str = Field(default="", max_length=2000)


def authorize(authorization: Annotated[str | None, Header()] = None) -> None:
    expected = f"Bearer {settings.secret}"
    if authorization is None or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


@asynccontextmanager
async def lifespan(_: FastAPI):
    stop_event.clear()
    workers = [
        threading.Thread(target=_worker_loop, name=f"transcriber-worker-{index + 1}", daemon=True)
        for index in range(settings.gpu_workers)
    ]
    for worker in workers:
        worker.start()
    logger.info("[Transcription] GPU worker concurrency=%s", settings.gpu_workers)
    _record_diagnostic(
        "_system",
        "service",
        "success",
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
    stop_event.set()
    for worker in workers:
        worker.join(timeout=10)
    _record_diagnostic(
        "_system",
        "service",
        "info",
        "Servicio de transcripción detenido.",
        evidence=["stop_event_set", "workers_joined"],
    )


app = FastAPI(title="Dotty Transcriber", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": settings.model,
        "configured_device": settings.device,
        "active_device": engine.active_device,
        "compute_type": settings.compute_type,
        "diagnostics_enabled": settings.diagnostics_enabled,
        "queue": store.metrics(),
        "work": store.current_work(),
    }


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
        job = store.enqueue(JobInput(**payload))
        session_id = _session_id(request.id)
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


@app.delete("/v1/sessions/{session_id}", dependencies=[Depends(authorize)])
def delete_session_jobs(session_id: str) -> dict[str, Any]:
    deleted = store.delete_for_session(session_id)
    _record_diagnostic(
        session_id,
        "maintenance",
        "info",
        "Trabajos de transcripción eliminados de la cola persistente.",
        metrics={"deleted_jobs": deleted},
    )
    return {"session_id": session_id, "deleted": deleted}


@app.post("/v1/sessions/{session_id}/retry", dependencies=[Depends(authorize)])
def retry_session_jobs(session_id: str) -> dict[str, Any]:
    retried = store.retry_failed_for_session(session_id)
    _record_diagnostic(
        session_id,
        "retry",
        "info",
        "Trabajos fallidos de la sesión marcados para reintento.",
        metrics={"retried_jobs": retried},
    )
    return {"session_id": session_id, "retried": retried}


def _worker_loop() -> None:
    while not stop_event.is_set():
        job = store.claim_next()
        if job is None:
            stop_event.wait(0.5)
            continue
        job_started = time.perf_counter()
        session_id = _session_id(str(job["id"]))
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
        try:
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
                    lambda progress, processed, duration: store.update_progress(
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
                outcome = "warning" if result.get("status") == "unintelligible" or suspected > 0 else "success"
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
                    duration_ms=transcription_wall_seconds * 1000,
                    evidence=evidence,
                    metrics=result_metrics,
                )
                if result.get("status") == "unintelligible":
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
            if store.complete(job["id"], job["claim_token"], result):
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
            store.fail(job["id"], job["claim_token"], str(error))
            _record_diagnostic(
                session_id,
                "job",
                "failure",
                "Trabajo de transcripción falló y quedó registrado para diagnóstico/reintento.",
                job_id=job["id"],
                duration_ms=(time.perf_counter() - job_started) * 1000,
                evidence=["exception_captured", "job_marked_failed"],
                metrics={"attempts": job["attempts"], "active_device": engine.active_device},
                error=error,
            )
            time.sleep(1)


def _session_id(job_id: str) -> str:
    return str(job_id).split(":", 1)[0]


def _record_diagnostic(
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
) -> None:
    try:
        diagnostics.record(
            session_id,
            process,
            outcome,
            message,
            job_id=job_id,
            duration_ms=duration_ms,
            evidence=evidence,
            metrics=metrics,
            error=error,
        )
    except Exception:
        logger.exception("Could not persist hidden diagnostics process=%s session=%s", process, session_id)
