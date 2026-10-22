import json
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace
import uuid

import pytest
from fastapi import HTTPException

from dotty_transcriber import main
from dotty_transcriber.storage import JobInput, JobStore
from dotty_transcriber.session_file_coordinator import SessionFileCoordinator


def _fixture(tmp_path: Path, monkeypatch):
    session_id = "session-one"
    recording = tmp_path / "recordings" / session_id
    exported = tmp_path / "exports" / session_id
    recording.mkdir(parents=True)
    exported.mkdir(parents=True)
    (recording / "manifest.json").write_text(
        json.dumps({"sessionId": session_id, "status": "completed"}), encoding="utf-8",
    )
    audio = recording / "chunk.wav"
    audio.write_bytes(b"RIFF" + b"\0" * 48)
    raw = exported / "transcript.raw.json"
    raw.write_text('{"version":1}\n', encoding="utf-8")
    store = JobStore(tmp_path / "queue.db")
    store.enqueue(JobInput(f"{session_id}:chunk-a", str(audio), "speaker", 0, "es"))
    monkeypatch.setattr(main, "settings", SimpleNamespace(
        data_dir=tmp_path, recordings_dir=tmp_path / "recordings", secret="fixture-secret",
    ), raising=False)
    monkeypatch.setattr(main, "configured_data_dir", lambda: tmp_path)
    monkeypatch.setattr(main, "store", store, raising=False)
    monkeypatch.setattr(main, "_record_diagnostic", lambda *args, **kwargs: None)
    return store, recording, exported


def _job_row(store: JobStore) -> dict:
    return dict(store._connection().execute(
        "SELECT * FROM transcription_job WHERE id='session-one:chunk-a'",
    ).fetchone())


@pytest.mark.parametrize("status", ["completed", "failed"])
def test_retranscription_rejects_terminal_job_with_open_occupation(
    tmp_path: Path, monkeypatch, status: str,
) -> None:
    store, recording, exported = _fixture(tmp_path, monkeypatch)
    if status == "failed":
        store._connection().execute(
            "UPDATE transcription_job SET max_attempts=1 WHERE id='session-one:chunk-a'",
        )
    claim = store.claim_next()
    assert claim is not None
    if status == "completed":
        assert store.complete(claim["id"], claim["claim_token"], {"segments": []})
    else:
        assert store.fail(claim["id"], claim["claim_token"], "fixture failure")
    before = _job_row(store)
    existing_backup = exported / "transcript.raw.respaldo.json"
    existing_backup.write_text("older backup", encoding="utf-8")
    ready = recording / ".transcription-ready"
    ready.write_text("ready", encoding="utf-8")

    with pytest.raises(HTTPException) as rejected:
        main.retranscribe_session("session-one")
    assert rejected.value.status_code == 409
    assert _job_row(store) == before
    assert store.occupations_for_session("session-one")[0]["released_at"] is None
    assert existing_backup.read_text(encoding="utf-8") == "older backup"
    assert (exported / "transcript.raw.json").read_text(encoding="utf-8") == '{"version":1}\n'
    assert not (recording / ".transcription-regenerating").exists()
    assert ready.read_text(encoding="utf-8") == "ready"


def test_closed_admission_returns_http_409_without_new_artifacts(
    tmp_path: Path, monkeypatch,
) -> None:
    store, recording, exported = _fixture(tmp_path, monkeypatch)
    store._connection().execute(
        "UPDATE transcription_job SET status='completed', result_json='{}'",
    )
    store.prepare_job_deletion(str(uuid.uuid4()), "session-one", "reprocess")
    before = _job_row(store)
    ready = recording / ".transcription-ready"
    ready.write_text("ready", encoding="utf-8")

    with pytest.raises(HTTPException) as rejected:
        main.retranscribe_session("session-one")
    assert rejected.value.status_code == 409
    assert _job_row(store) == before
    assert not (exported / "transcript.raw.respaldo.json").exists()
    assert not (recording / ".transcription-regenerating").exists()
    assert ready.read_text(encoding="utf-8") == "ready"
    assert store.admission_state("session-one")["closed"] is True


def test_existing_regeneration_marker_is_not_removed_by_a_second_request(
    tmp_path: Path, monkeypatch,
) -> None:
    store, recording, exported = _fixture(tmp_path, monkeypatch)
    store._connection().execute(
        "UPDATE transcription_job SET status='completed', result_json='{}'",
    )
    marker = recording / ".transcription-regenerating"
    marker.write_text("other operation", encoding="utf-8")
    before = _job_row(store)

    with pytest.raises(HTTPException) as rejected:
        main.retranscribe_session("session-one")
    assert rejected.value.status_code == 409
    assert marker.read_text(encoding="utf-8") == "other operation"
    assert _job_row(store) == before
    assert not (exported / "transcript.raw.respaldo.json").exists()


def test_marker_created_after_initial_check_blocks_without_touching_other_operation(
    tmp_path: Path, monkeypatch,
) -> None:
    store, recording, exported = _fixture(tmp_path, monkeypatch)
    store._connection().execute(
        "UPDATE transcription_job SET status='completed', result_json='{}'",
    )
    before = _job_row(store)
    marker = recording / ".transcription-regenerating"
    original = store.retranscribe_session

    def concurrent_marker(session_id: str, *, on_accepted):
        marker.write_text("concurrent operation", encoding="utf-8")
        return original(session_id, on_accepted=on_accepted)

    monkeypatch.setattr(store, "retranscribe_session", concurrent_marker)
    with pytest.raises(HTTPException) as rejected:
        main.retranscribe_session("session-one")

    assert rejected.value.status_code == 409
    assert marker.read_text(encoding="utf-8") == "concurrent operation"
    assert _job_row(store) == before
    assert not (exported / "transcript.raw.respaldo.json").exists()


def test_new_completion_marker_from_concurrent_writer_is_preserved(
    tmp_path: Path, monkeypatch,
) -> None:
    store, recording, _ = _fixture(tmp_path, monkeypatch)
    store._connection().execute(
        "UPDATE transcription_job SET status='completed', result_json='{}'",
    )
    ready = recording / ".transcription-ready"
    original = store.retranscribe_session

    def concurrent_completion(session_id: str, *, on_accepted):
        ready.write_text("concurrent completion", encoding="utf-8")
        return original(session_id, on_accepted=on_accepted)

    monkeypatch.setattr(store, "retranscribe_session", concurrent_completion)
    assert main.retranscribe_session("session-one")["queued"] == 1
    assert ready.read_text(encoding="utf-8") == "concurrent completion"


@pytest.mark.parametrize("status", ["completed", "interrupted"])
def test_retranscription_rotates_one_raw_backup_and_keeps_current_until_replaced(tmp_path: Path, monkeypatch, status: str) -> None:
    session_id = "session-one"
    recording = tmp_path / "recordings" / session_id
    exported = tmp_path / "exports" / session_id
    recording.mkdir(parents=True)
    exported.mkdir(parents=True)
    (recording / "manifest.json").write_text(json.dumps({"sessionId": session_id, "status": status}), encoding="utf-8")
    audio = recording / "chunk.wav"
    audio.write_bytes(b"RIFF" + b"\0" * 48)
    raw = exported / "transcript.raw.json"
    backup = exported / "transcript.raw.respaldo.json"
    raw.write_text('{"version":1}\n', encoding="utf-8")
    (recording / ".transcription-ready").write_text("ready", encoding="utf-8")
    store = JobStore(tmp_path / "queue.db")
    store.enqueue(JobInput(f"{session_id}:chunk-a", str(audio), "speaker", 0, "es"))
    store._connection().execute("UPDATE transcription_job SET status='completed', result_json='{}'")
    monkeypatch.setattr(main, "settings", SimpleNamespace(data_dir=tmp_path, recordings_dir=tmp_path / "recordings"), raising=False)
    monkeypatch.setattr(main, "configured_data_dir", lambda: tmp_path)
    monkeypatch.setattr(main, "store", store, raising=False)
    monkeypatch.setattr(main, "_record_diagnostic", lambda *args, **kwargs: None)

    first = main.retranscribe_session(session_id)
    assert first["queued"] == 1
    assert backup.read_text(encoding="utf-8") == '{"version":1}\n'
    assert raw.read_text(encoding="utf-8") == '{"version":1}\n'
    assert not (recording / ".transcription-ready").exists()

    store._connection().execute("UPDATE transcription_job SET status='completed', result_json='{}'")
    raw.write_text('{"version":2}\n', encoding="utf-8")
    (recording / ".transcription-regenerating").unlink()
    second = main.retranscribe_session(session_id)
    assert second["queued"] == 1
    assert backup.read_text(encoding="utf-8") == '{"version":2}\n'
    assert len(list(exported.glob("*respaldo*"))) == 1


def _completed_fixture(tmp_path: Path, monkeypatch):
    store, recording, exported = _fixture(tmp_path, monkeypatch)
    store._connection().execute("UPDATE transcription_job SET status='completed', result_json='{}'")
    return store, recording, exported


def test_retranscription_holds_lock_through_requeue_and_releases_it(tmp_path: Path, monkeypatch) -> None:
    store, _, _ = _completed_fixture(tmp_path, monkeypatch)
    path = SessionFileCoordinator(tmp_path, node_data_dir=tmp_path).path_for("session-one")
    original = store.retranscribe_session

    def observed(session_id: str, *, on_accepted):
        assert path.is_file()
        result = original(session_id, on_accepted=on_accepted)
        assert path.is_file()
        return result

    monkeypatch.setattr(store, "retranscribe_session", observed)
    assert main.retranscribe_session("session-one")["queued"] == 1
    assert _job_row(store)["status"] == "queued"
    assert not path.exists()


def test_node_lock_blocks_retranscription_without_changing_jobs_or_markers(tmp_path: Path, monkeypatch) -> None:
    store, recording, exported = _completed_fixture(tmp_path, monkeypatch)
    before = _job_row(store)
    ready = recording / ".transcription-ready"
    ready.write_text("old marker", encoding="utf-8")
    script = (
        f"import {{ SessionFileCoordinator }} from "
        f"{json.dumps((Path(__file__).resolve().parents[3] / 'apps/bot/src/sessions/session-file-coordinator.ts').as_uri())};"
        f"await new SessionFileCoordinator({json.dumps(str(tmp_path / 'session-locks'))}).runExclusive("
        "'session-one',async()=>{console.log('READY');await new Promise(done=>process.stdin.once('data',done));});"
    )
    process = subprocess.Popen(
        ["node", "--import", "tsx", "--input-type=module", "-e", script],
        cwd=Path(__file__).resolve().parents[3], text=True, encoding="utf-8",
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        assert process.stdout is not None
        assert process.stdout.readline().strip() == "READY"
        with pytest.raises(HTTPException) as rejected:
            main.retranscribe_session("session-one")
        assert rejected.value.status_code == 423
        assert rejected.value.detail == {"code": "SESSION_LOCK_TIMEOUT"}
        assert _job_row(store) == before
        assert ready.read_text(encoding="utf-8") == "old marker"
        assert not (recording / ".transcription-regenerating").exists()
        assert not (exported / "transcript.raw.respaldo.json").exists()
    finally:
        assert process.stdin is not None
        process.stdin.write("release\n")
        process.stdin.flush()
        stdout, stderr = process.communicate(timeout=15)
        assert process.returncode == 0, (stdout, stderr)


def test_permission_error_has_no_partial_effects(tmp_path: Path, monkeypatch) -> None:
    store, recording, exported = _completed_fixture(tmp_path, monkeypatch)
    before = _job_row(store)
    ready = recording / ".transcription-ready"
    ready.write_text("old marker", encoding="utf-8")
    original_open = os.open

    def denied(path, *args, **kwargs):
        if str(path).endswith(".session.lock"):
            raise PermissionError("synthetic denial")
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(os, "open", denied)
    with pytest.raises(HTTPException) as rejected:
        main.retranscribe_session("session-one")
    assert rejected.value.status_code == 503
    assert rejected.value.detail == {"code": "SESSION_LOCK_PERMISSION"}
    assert _job_row(store) == before
    assert ready.read_text(encoding="utf-8") == "old marker"
    assert not (exported / "transcript.raw.respaldo.json").exists()


def test_preparation_failure_rolls_back_sqlite_and_releases_lock(tmp_path: Path, monkeypatch) -> None:
    store, recording, exported = _completed_fixture(tmp_path, monkeypatch)
    before = _job_row(store)
    path = SessionFileCoordinator(tmp_path, node_data_dir=tmp_path).path_for("session-one")

    def failed_copy(*args, **kwargs):
        assert path.exists()
        raise OSError("synthetic copy failure")

    monkeypatch.setattr(main.shutil, "copyfile", failed_copy)
    with pytest.raises(OSError, match="synthetic copy failure"):
        main.retranscribe_session("session-one")
    assert _job_row(store) == before
    assert not path.exists()
    assert not (recording / ".transcription-regenerating").exists()
    assert not (exported / "transcript.raw.respaldo.json").exists()


def test_other_session_can_retranscribe_while_first_is_locked(tmp_path: Path, monkeypatch) -> None:
    store, _, _ = _completed_fixture(tmp_path, monkeypatch)
    other = tmp_path / "recordings" / "session-two"
    other.mkdir()
    (other / "manifest.json").write_text('{"sessionId":"session-two","status":"completed"}', encoding="utf-8")
    audio = other / "chunk.wav"
    audio.write_bytes(b"RIFF" + b"\0" * 48)
    store.enqueue(JobInput("session-two:chunk-a", str(audio), "speaker", 0, "es"))
    store._connection().execute("UPDATE transcription_job SET status='completed', result_json='{}' WHERE id='session-two:chunk-a'")
    owner = SessionFileCoordinator(tmp_path, node_data_dir=tmp_path)
    with owner.acquire("session-one"):
        assert main.retranscribe_session("session-two")["queued"] == 1
    assert store.list_for_session("session-two")[0]["status"] == "queued"


def test_surviving_lock_and_different_data_dir_fail_before_changes(tmp_path: Path, monkeypatch) -> None:
    store, recording, exported = _completed_fixture(tmp_path, monkeypatch)
    before = _job_row(store)
    path = SessionFileCoordinator(tmp_path, node_data_dir=tmp_path).path_for("session-one")
    path.parent.mkdir()
    path.write_text("abandoned", encoding="utf-8")
    with pytest.raises(HTTPException) as rejected:
        main.retranscribe_session("session-one")
    assert rejected.value.status_code == 423
    assert path.read_text(encoding="utf-8") == "abandoned"
    monkeypatch.setattr(main, "configured_data_dir", lambda: tmp_path / "other-data")
    with pytest.raises(HTTPException) as rejected:
        main.retranscribe_session("session-one")
    assert rejected.value.status_code == 503
    assert rejected.value.detail == {"code": "SESSION_LOCK_CONFIGURATION"}
    assert _job_row(store) == before
    assert not (recording / ".transcription-regenerating").exists()
    assert not (exported / "transcript.raw.respaldo.json").exists()
