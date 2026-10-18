"""Admission history uses only temporary SQLite databases and fixture files."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3

import pytest

from dotty_transcriber.instance_lock import TranscriberInstanceLock
from dotty_transcriber.storage import JobInput, JobStore, PROVENANCE_PROTOCOL_VERSION


def job(job_id: str, audio_path: str = "unused.wav") -> JobInput:
    return JobInput(job_id, audio_path, "user", 0, "es")


def generations(store: JobStore, session_id: str) -> list[sqlite3.Row]:
    return store._connection().execute(
        "SELECT * FROM job_generation_history WHERE session_id=? ORDER BY admitted_at,generation_id",
        (session_id,),
    ).fetchall()


def events(store: JobStore) -> list[sqlite3.Row]:
    return store._connection().execute("SELECT * FROM job_admission_event").fetchall()


def test_protected_admission_records_generation_and_event_atomically(tmp_path: Path) -> None:
    lock = TranscriberInstanceLock.acquire(tmp_path)
    try:
        store = JobStore(tmp_path / "jobs.db", instance_lock=lock)
        accepted = store.enqueue(job("session:chunk"))
        generation = generations(store, "session")[0]
        event = events(store)[0]
        assert accepted["generation_id"] == generation["generation_id"] == event["generation_id"]
        assert generation["job_id"] == "session:chunk"
        assert generation["admission_provenance"] == "protected"
        assert generation["protocol_version"] == PROVENANCE_PROTOCOL_VERSION
        assert generation["instance_id"] == lock.instance_id
        assert generation["audio_origin_status"] == "unknown"
        assert event["event_id"] and event["event_type"] == "created"
        assert event["evidence_kind"] == "transaction_observed"
        assert store._connection().execute(
            "SELECT prior_history_status FROM job_history_scope WHERE id=1"
        ).fetchone()[0] == "unknown"
    finally:
        lock.release()


def test_unprotected_admission_remains_unknown(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    accepted = store.enqueue(job("historical:chunk"))
    generation = generations(store, "historical")[0]
    assert accepted["provenance_status"] == "unknown"
    assert generation["admission_provenance"] == "unknown"
    assert generation["protocol_version"] is None
    assert generation["instance_id"] is None
    assert generation["audio_origin_status"] == "unknown"


def test_duplicate_post_does_not_create_generation_or_change_origin(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    original = store.enqueue(job("session:chunk"))
    lock = TranscriberInstanceLock.acquire(tmp_path)
    try:
        protected_store = JobStore(tmp_path / "jobs.db", instance_lock=lock)
        repeated = protected_store.enqueue(job("session:chunk"))
        assert repeated["generation_id"] == original["generation_id"]
        assert repeated["provenance_status"] == "unknown"
        assert len(generations(store, "session")) == len(events(store)) == 1
        with pytest.raises(ValueError, match="different audio_path"):
            protected_store.enqueue(job("session:chunk", "other.wav"))
        assert len(generations(store, "session")) == len(events(store)) == 1
    finally:
        lock.release()


def test_history_failure_rolls_back_operational_job_and_generation(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store._connection().execute(
        """CREATE TRIGGER reject_event BEFORE INSERT ON job_admission_event
        BEGIN SELECT RAISE(ABORT, 'fixture event failure'); END"""
    )
    with pytest.raises(sqlite3.IntegrityError, match="fixture event failure"):
        store.enqueue(job("session:chunk"))
    assert store.get("session:chunk") is None
    assert generations(store, "session") == []
    assert events(store) == []


def test_restart_keeps_history_and_unknown_baseline(tmp_path: Path) -> None:
    path = tmp_path / "jobs.db"
    first = JobStore(path)
    original = first.enqueue(job("session:chunk"))
    restarted = JobStore(path)
    assert restarted.get("session:chunk")["generation_id"] == original["generation_id"]
    assert len(generations(restarted, "session")) == len(events(restarted)) == 1
    assert restarted._connection().execute(
        "SELECT prior_history_status FROM job_history_scope WHERE id=1"
    ).fetchone()[0] == "unknown"


def test_old_database_is_not_retroactively_given_a_generation(tmp_path: Path) -> None:
    path = tmp_path / "old.db"
    original = JobStore(path)
    original.enqueue(job("old:chunk"))
    connection = original._connection()
    connection.execute("DROP TABLE job_admission_event")
    connection.execute("DROP TABLE job_generation_history")
    connection.execute("DROP TABLE job_history_scope")
    connection.execute("ALTER TABLE transcription_job DROP COLUMN generation_id")
    restored = JobStore(path)
    assert restored.get("old:chunk")["generation_id"] is None
    assert restored.get("old:chunk")["provenance_status"] == "unknown"
    assert generations(restored, "old") == []
    assert events(restored) == []
    assert restored._connection().execute(
        "SELECT prior_history_status FROM job_history_scope WHERE id=1"
    ).fetchone()[0] == "unknown"
    assert restored.enqueue(job("new:chunk"))["generation_id"] is not None


def test_two_sessions_and_concurrent_admissions_get_distinct_generations(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = list(pool.map(store.enqueue, [job("one:chunk"), job("two:chunk")]))
    assert first["generation_id"] != second["generation_id"]
    assert len(generations(store, "one")) == len(generations(store, "two")) == 1
    assert len(events(store)) == 2


def test_closed_admission_rejects_job_without_history_event(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.close_admission("closed")
    with pytest.raises(ValueError, match="admission is closed"):
        store.enqueue(job("closed:chunk"))
    assert generations(store, "closed") == []
    assert events(store) == []
    assert store.admission_state("closed")["workers_inactive"] is None


def test_reused_job_id_has_new_generation_without_erasing_old_one(tmp_path: Path) -> None:
    fixture_wav = tmp_path / "fixture.wav"
    fixture_wav.write_bytes(b"temporary fixture bytes")
    store = JobStore(tmp_path / "jobs.db")
    original = store.enqueue(job("session:chunk", str(fixture_wav)))
    assert store.delete_for_session("session") == 1
    replacement = store.enqueue(job("session:chunk", str(fixture_wav)))
    assert original["generation_id"] != replacement["generation_id"]
    assert {row["generation_id"] for row in generations(store, "session")} == {
        original["generation_id"], replacement["generation_id"]
    }
    assert len(events(store)) == 2
    assert fixture_wav.read_bytes() == b"temporary fixture bytes"


def test_history_is_append_only_and_inventory_contract_is_unchanged(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(job("session:chunk"))
    connection = store._connection()
    for statement in (
        "UPDATE job_generation_history SET audio_origin_status='unknown'",
        "DELETE FROM job_generation_history",
        "UPDATE job_admission_event SET evidence_kind='transaction_observed'",
        "DELETE FROM job_admission_event",
    ):
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            connection.execute(statement)
    inventory = store.inventory_for_session("session")
    assert inventory["classification"] == "unknown-only"
    assert inventory["counts"]["jobs_unknown"] == 1
    assert "workers_inactive" not in inventory
    assert "wav_safe" not in inventory
