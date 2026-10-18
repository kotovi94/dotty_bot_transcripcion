from __future__ import annotations

import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from dotty_transcriber import main
from dotty_transcriber.engine import WhisperEngine
from dotty_transcriber.storage import JobInput, JobStore
from dotty_transcriber.voice_processing import VoiceAnalysis


RESULT = {
    "device": "cpu", "language": "es", "duration_seconds": 1.0,
    "duration_after_vad_seconds": 1.0, "segments": [], "status": "transcribed",
}


class FakeVoice:
    def __init__(self) -> None:
        self.analyze_action = None
        self.record_action = None

    def analyze(self, audio_path, user_id, session_id):
        if self.analyze_action:
            return self.analyze_action(audio_path)
        return VoiceAnalysis("SPEECH", 1.0, 1.0, 1.0, -20.0, {
            "threshold": 0.5, "min_silence_duration_ms": 500, "speech_pad_ms": 200,
        })

    def record_result(self, *args):
        if self.record_action:
            self.record_action()


class FakeEngine:
    active_device = "cpu"

    def __init__(self) -> None:
        self.action = None

    def transcribe(self, *args):
        if self.action:
            return self.action()
        return dict(RESULT)


def _setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, count: int = 1):
    store = JobStore(tmp_path / "jobs.db")
    wav = tmp_path / "fixture.wav"
    wav.write_bytes(b"fixture WAV bytes only")
    for number in range(count):
        store.enqueue(JobInput(f"session:chunk-{number}", str(wav), "user", number, "es"))
    voice = FakeVoice()
    engine = FakeEngine()
    monkeypatch.setattr(main, "store", store, raising=False)
    monkeypatch.setattr(main, "voice_processor", voice, raising=False)
    monkeypatch.setattr(main, "engine", engine, raising=False)
    monkeypatch.setattr(main, "settings", SimpleNamespace(
        vad_threshold=0.5, vad_min_silence_ms=500, vad_speech_pad_ms=200,
        model="fixture", device="cpu", compute_type="int8",
    ), raising=False)
    monkeypatch.setattr(main, "_record_diagnostic", lambda *args, **kwargs: None)
    main.stop_event.clear()
    return store, wav, voice, engine


def _run_one(store: JobStore, monkeypatch: pytest.MonkeyPatch):
    done = threading.Event()
    original = store.release_occupation

    def release(*args):
        try:
            return original(*args)
        finally:
            main.stop_event.set()
            done.set()

    monkeypatch.setattr(store, "release_occupation", release)
    worker = threading.Thread(target=main._worker_loop, daemon=True)
    worker.start()
    return worker, done


def _finish(worker: threading.Thread, done: threading.Event) -> None:
    try:
        assert done.wait(5)
        worker.join(timeout=5)
        assert not worker.is_alive()
    finally:
        main.stop_event.set()


def test_normal_completion_releases_after_result_and_metrics(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, wav, voice, _ = _setup(tmp_path, monkeypatch)

    def record():
        assert store.get("session:chunk-0")["status"] == "completed"
        assert store.occupations_for_session("session")[0]["released_at"] is None

    voice.record_action = record
    worker, done = _run_one(store, monkeypatch)
    _finish(worker, done)
    assert store.occupations_for_session("session")[0]["released_at"] is not None
    assert wav.read_bytes() == b"fixture WAV bytes only"


@pytest.mark.parametrize("stage", ["vad", "whisper", "profile", "diagnostic"])
def test_blocked_operation_retains_occupation_until_return(
    stage: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, wav, voice, engine = _setup(tmp_path, monkeypatch)
    entered, unblock = threading.Event(), threading.Event()

    def pause():
        entered.set()
        assert unblock.wait(5)

    if stage == "vad":
        voice.analyze_action = lambda path: (pause(), VoiceAnalysis(
            "SPEECH", 1.0, 1.0, 1.0, -20.0,
            {"threshold": 0.5, "min_silence_duration_ms": 500, "speech_pad_ms": 200},
        ))[1]
    elif stage == "whisper":
        engine.action = lambda: (pause(), dict(RESULT))[1]
    elif stage == "profile":
        voice.record_action = pause
    else:
        def diagnostic(_session, process, outcome, _message, **_kwargs):
            if process == "job" and outcome == "success":
                pause()
        monkeypatch.setattr(main, "_record_diagnostic", diagnostic)

    worker, done = _run_one(store, monkeypatch)
    try:
        assert entered.wait(5)
        occupation = store.occupations_for_session("session")[0]
        assert occupation["released_at"] is None
        assert not done.is_set()
        if stage in ("profile", "diagnostic"):
            assert store.get("session:chunk-0")["status"] == "completed"
    finally:
        unblock.set()
        _finish(worker, done)
    assert store.occupations_for_session("session")[0]["released_at"] is not None
    assert wav.read_bytes() == b"fixture WAV bytes only"


def test_vad_exception_fallback_releases_after_processing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, _, voice, engine = _setup(tmp_path, monkeypatch)

    def broken_vad(_path):
        raise ValueError("fixture VAD failure")

    voice.analyze_action = broken_vad
    called = threading.Event()
    engine.action = lambda: (called.set(), dict(RESULT))[1]
    worker, done = _run_one(store, monkeypatch)
    _finish(worker, done)
    assert called.is_set()
    assert store.get("session:chunk-0")["status"] == "completed"
    assert store.occupations_for_session("session")[0]["released_at"] is not None


def test_whisper_exception_requeues_but_cannot_reclaim_before_release(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, _, _, engine = _setup(tmp_path, monkeypatch)
    entered, unblock = threading.Event(), threading.Event()

    def broken_whisper():
        raise RuntimeError("fixture Whisper failure")

    engine.action = broken_whisper
    monkeypatch.setattr(main.time, "sleep", lambda _seconds: (entered.set(), unblock.wait(5)))
    worker, done = _run_one(store, monkeypatch)
    try:
        assert entered.wait(5)
        assert store.get("session:chunk-0")["status"] == "queued"
        assert store.claim_next() is None
        assert store.occupations_for_session("session")[0]["released_at"] is None
    finally:
        unblock.set()
        _finish(worker, done)
    assert store.occupations_for_session("session")[0]["released_at"] is not None


def test_cuda_fallback_keeps_occupation_through_cpu_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, _, _, _ = _setup(tmp_path, monkeypatch)
    engine = WhisperEngine.__new__(WhisperEngine)
    engine._lock = threading.Lock()
    engine._model = None
    engine._active_device = "cuda"
    engine._active_compute_type = "float16"
    engine._fallback_reason = None
    engine.settings = SimpleNamespace(language="es")
    engine._get_model = lambda: object()
    calls = []

    def transcribe(*_args):
        calls.append(engine.active_device)
        assert store.occupations_for_session("session")[0]["released_at"] is None
        if len(calls) == 1:
            raise RuntimeError("CUDA out of memory")
        return dict(RESULT)

    engine._transcribe_with_model = transcribe
    monkeypatch.setattr(main, "engine", engine)
    worker, done = _run_one(store, monkeypatch)
    _finish(worker, done)
    assert calls == ["cuda", "cpu"]
    assert store.get("session:chunk-0")["status"] == "completed"
    assert store.occupations_for_session("session")[0]["released_at"] is not None


def test_release_failure_preserves_occupation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, _, _, _ = _setup(tmp_path, monkeypatch)
    done = threading.Event()

    def broken_release(*_args):
        main.stop_event.set()
        done.set()
        raise RuntimeError("fixture SQLite failure")

    monkeypatch.setattr(store, "release_occupation", broken_release)
    worker = threading.Thread(target=main._worker_loop, daemon=True)
    worker.start()
    _finish(worker, done)
    assert store.occupations_for_session("session")[0]["released_at"] is None
    assert store.claim_next() is None


def test_shutdown_waits_for_inflight_profile_write_before_release(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, _, voice, _ = _setup(tmp_path, monkeypatch)
    entered, unblock = threading.Event(), threading.Event()

    def blocked_profile():
        entered.set()
        assert unblock.wait(5)

    voice.record_action = blocked_profile
    worker, done = _run_one(store, monkeypatch)
    try:
        assert entered.wait(5)
        main.stop_event.set()
        assert store.occupations_for_session("session")[0]["released_at"] is None
        assert worker.is_alive()
    finally:
        unblock.set()
        _finish(worker, done)
    assert store.occupations_for_session("session")[0]["released_at"] is not None


def test_interrupted_worker_preserves_occupation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, _, voice, _ = _setup(tmp_path, monkeypatch)

    def interrupt(_path):
        raise KeyboardInterrupt("fixture interruption")

    voice.analyze_action = interrupt
    with pytest.raises(KeyboardInterrupt, match="fixture interruption"):
        main._worker_loop()
    main.stop_event.set()
    assert store.occupations_for_session("session")[0]["released_at"] is None
    assert store.claim_next() is None


def test_two_workers_release_only_their_own_jobs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, _, voice, _ = _setup(tmp_path, monkeypatch, count=2)
    entered, unblock = threading.Event(), threading.Event()
    completed = 0
    counter_lock = threading.Lock()
    original = store.release_occupation

    def profile():
        if threading.current_thread().name == "blocked-worker":
            entered.set()
            assert unblock.wait(5)

    voice.record_action = profile

    def release(*args):
        nonlocal completed
        result = original(*args)
        with counter_lock:
            completed += 1
            if completed == 2:
                main.stop_event.set()
        return result

    monkeypatch.setattr(store, "release_occupation", release)
    blocked = threading.Thread(target=main._worker_loop, name="blocked-worker", daemon=True)
    blocked.start()
    assert entered.wait(5)
    other = threading.Thread(target=main._worker_loop, name="other-worker", daemon=True)
    other.start()
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            rows = store.occupations_for_session("session")
            if len(rows) == 2 and sum(row["released_at"] is not None for row in rows) == 1:
                break
            threading.Event().wait(0.02)
        assert len(rows) == 2
        assert sum(row["released_at"] is not None for row in rows) == 1
    finally:
        unblock.set()
        main.stop_event.set()
        blocked.join(timeout=5)
        other.join(timeout=5)
    assert not blocked.is_alive() and not other.is_alive()
    assert all(row["released_at"] is not None for row in store.occupations_for_session("session"))
