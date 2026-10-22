"""Session mutations use the shared lock before their SQLite transaction."""

from pathlib import Path
from types import SimpleNamespace
import uuid

import pytest
from fastapi import HTTPException

from dotty_transcriber import main
from dotty_transcriber.session_file_coordinator import SessionFileCoordinator
from dotty_transcriber.storage import JobInput, JobStore


def fixture(tmp_path: Path, monkeypatch):
    recording = tmp_path / "recordings" / "session-one"
    recording.mkdir(parents=True)
    audio = recording / "chunk.wav"
    audio.write_bytes(b"RIFF" + b"\0" * 48)
    store = JobStore(tmp_path / "queue.db")
    monkeypatch.setattr(main, "settings", SimpleNamespace(data_dir=tmp_path, recordings_dir=tmp_path / "recordings"), raising=False)
    monkeypatch.setattr(main, "configured_data_dir", lambda: tmp_path)
    monkeypatch.setattr(main, "store", store, raising=False)
    monkeypatch.setattr(main, "_record_diagnostic", lambda *args, **kwargs: None)
    return store, audio, SessionFileCoordinator(tmp_path, node_data_dir=tmp_path)


def test_enqueue_and_retry_acquire_and_release(tmp_path: Path, monkeypatch):
    store, audio, coordinator = fixture(tmp_path, monkeypatch)
    request = main.JobRequest(id="session-one:chunk", audio_path=str(audio), speaker_user_id="speaker", start_offset_ms=0)
    assert main.enqueue(request)["status"] == "queued"
    assert not coordinator.path_for("session-one").exists()
    store._connection().execute("UPDATE transcription_job SET status='failed' WHERE id='session-one:chunk'")
    assert main.retry_job("session-one:chunk")["status"] == "queued"
    assert not coordinator.path_for("session-one").exists()


def test_node_lock_blocks_enqueue_retry_and_session_retry_without_sqlite_changes(tmp_path: Path, monkeypatch):
    store, audio, coordinator = fixture(tmp_path, monkeypatch)
    store.enqueue(JobInput("session-one:old", str(audio), "speaker", 0, "es"))
    store._connection().execute("UPDATE transcription_job SET status='failed' WHERE id='session-one:old'")
    before = [dict(row) for row in store._connection().execute("SELECT * FROM transcription_job")]
    class ImmediateCoordinator(SessionFileCoordinator):
        def acquire(self, session_id, *, timeout_ms=4_000, **kwargs):
            return super().acquire(session_id, timeout_ms=0, **kwargs)
    monkeypatch.setattr(main, "SessionFileCoordinator", ImmediateCoordinator)
    with coordinator.acquire("session-one"):
        operations = (
            lambda: main.enqueue(main.JobRequest(id="session-one:new", audio_path=str(audio), speaker_user_id="speaker", start_offset_ms=0)),
            lambda: main.retry_job("session-one:old"),
            lambda: main.retry_session_jobs("session-one"),
        )
        for operation in operations:
            with pytest.raises(HTTPException) as rejected:
                operation()
            assert rejected.value.status_code == 423
            assert [dict(row) for row in store._connection().execute("SELECT * FROM transcription_job")] == before


def test_different_session_can_mutate_while_first_locked(tmp_path: Path, monkeypatch):
    store, audio, coordinator = fixture(tmp_path, monkeypatch)
    with coordinator.acquire("session-one"):
        request = main.JobRequest(id="session-two:chunk", audio_path=str(audio), speaker_user_id="speaker", start_offset_ms=0)
        assert main.enqueue(request)["id"] == "session-two:chunk"
    assert store.get("session-two:chunk") is not None


def test_administrative_preparation_obeys_the_same_lock(tmp_path: Path, monkeypatch):
    store, audio, coordinator = fixture(tmp_path, monkeypatch)
    store.enqueue(JobInput("session-one:chunk", str(audio), "speaker", 0, "es"))
    class ImmediateCoordinator(SessionFileCoordinator):
        def acquire(self, session_id, *, timeout_ms=4_000, **kwargs):
            return super().acquire(session_id, timeout_ms=0, **kwargs)
    monkeypatch.setattr(main, "SessionFileCoordinator", ImmediateCoordinator)
    request = main.JobDeletionRequest(operation_id=str(uuid.uuid4()), operation_type="reprocess", parameters={})
    with coordinator.acquire("session-one"):
        with pytest.raises(HTTPException) as rejected:
            main.prepare_session_job_deletion("session-one", request)
        assert rejected.value.status_code == 423
        assert store.admission_state("session-one")["closed"] is False
    result = main.prepare_session_job_deletion("session-one", request)
    assert result["status"] == "pending_drain"
