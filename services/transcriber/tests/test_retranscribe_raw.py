import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from dotty_transcriber import main
from dotty_transcriber.storage import JobInput, JobStore


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
