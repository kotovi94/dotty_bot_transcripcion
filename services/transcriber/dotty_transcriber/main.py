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
    yield
    stop_event.set()
    for worker in workers:
        worker.join(timeout=10)


app = FastAPI(title="Dotty Transcriber", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": settings.model,
        "configured_device": settings.device,
        "active_device": engine.active_device,
        "compute_type": settings.compute_type,
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
        return store.enqueue(JobInput(**payload))
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(authorize)])
def get_job(job_id: str) -> dict[str, Any]:
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.post("/v1/jobs/{job_id}/retry", dependencies=[Depends(authorize)])
def retry_job(job_id: str) -> dict[str, Any]:
    job = store.retry(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
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
    return {"unloaded": engine.unload()}


@app.get("/v1/sessions/{session_id}", dependencies=[Depends(authorize)])
def session_jobs(session_id: str) -> dict[str, Any]:
    return {"session_id": session_id, "jobs": store.list_for_session(session_id)}


@app.delete("/v1/sessions/{session_id}", dependencies=[Depends(authorize)])
def delete_session_jobs(session_id: str) -> dict[str, Any]:
    return {"session_id": session_id, "deleted": store.delete_for_session(session_id)}


@app.post("/v1/sessions/{session_id}/retry", dependencies=[Depends(authorize)])
def retry_session_jobs(session_id: str) -> dict[str, Any]:
    return {"session_id": session_id, "retried": store.retry_failed_for_session(session_id)}


def _worker_loop() -> None:
    while not stop_event.is_set():
        job = store.claim_next()
        if job is None:
            stop_event.wait(0.5)
            continue
        try:
            logger.info(
                "Starting transcription job=%s audio=%s speaker=%s attempts=%s",
                job["id"],
                job["audio_path"],
                job["speaker_user_id"],
                job["attempts"],
            )
            audio_path = Path(job["audio_path"])
            session_id = str(job["id"]).split(":", 1)[0]
            try:
                analysis = voice_processor.analyze(audio_path, job["speaker_user_id"], session_id)
            except Exception:
                logger.exception("[VAD] Analysis failed; using conservative SPEECH fallback")
                analysis = VoiceAnalysis(
                    "SPEECH", 0.0, 0.0, 1.0, -120.0,
                    {
                        "threshold": settings.vad_threshold,
                        "min_silence_duration_ms": settings.vad_min_silence_ms,
                        "speech_pad_ms": settings.vad_speech_pad_ms,
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
            else:
                logger.info(
                    "[VAD] User %s speech detected; pre-buffer=%sms hangover=%sms",
                    job["speaker_user_id"],
                    analysis.vad_parameters["speech_pad_ms"],
                    analysis.vad_parameters["min_silence_duration_ms"],
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
                gpu_seconds = time.perf_counter() - started if engine.active_device == "cuda" else 0.0
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
                try:
                    voice_processor.record_result(
                        session_id,
                        job["speaker_user_id"],
                        analysis,
                        result,
                        gpu_seconds,
                        job["audio_path"],
                    )
                except Exception:
                    logger.exception("Could not record voice metrics job=%s", job["id"])
                logger.info("Completed transcription job=%s segments=%d", job["id"], len(result.get("segments", [])))
            else:
                logger.info("Discarded stale transcription result job=%s", job["id"])
        except Exception as error:
            logger.exception("Transcription job %s failed", job["id"])
            store.fail(job["id"], job["claim_token"], str(error))
            time.sleep(1)
