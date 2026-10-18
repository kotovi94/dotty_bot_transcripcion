"""Preparation freezes jobs without deleting rows or claiming worker inactivity."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
import sqlite3
import uuid

import pytest

from dotty_transcriber.instance_lock import TranscriberInstanceLock
from dotty_transcriber.storage import JobInput, JobStore


def job(job_id: str) -> JobInput:
    return JobInput(job_id, "unused.wav", "user", 0, "es")


def operation_id() -> str:
    return str(uuid.uuid4())


def test_first_and_repeated_preparation_freeze_targets_without_deleting(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    accepted = store.enqueue(job("session:chunk"))
    op = operation_id()
    first = store.prepare_job_deletion(op, "session", "reprocess", {"reason": "manual"})
    repeated = store.prepare_job_deletion(op, "session", "reprocess", {"reason": "manual"})
    assert repeated == first == store.job_deletion_operation(op)
    assert first["status"] == "pending_drain"
    assert first["close_id"] == store._connection().execute(
        "SELECT close_operation_id FROM session_admission WHERE session_id='session'"
    ).fetchone()[0]
    assert first["targets"][0]["generation_id"] == accepted["generation_id"]
    assert first["targets"][0]["identity_status"] == "recorded_generation"
    assert first["targets"][0]["observed_provenance"] == "unknown"
    assert store.get("session:chunk") is not None
    assert store.admission_state("session")["workers_inactive"] is None
    with pytest.raises(ValueError, match="conflicts"):
        store.prepare_job_deletion(op, "session", "reprocess", {"reason": "changed"})
    with pytest.raises(ValueError, match="conflicts"):
        store.prepare_job_deletion(op, "other", "reprocess", {"reason": "manual"})


def test_protected_exact_and_prefixed_jobs_are_selected_without_other_sessions(tmp_path: Path) -> None:
    lock = TranscriberInstanceLock.acquire(tmp_path)
    try:
        store = JobStore(tmp_path / "jobs.db", instance_lock=lock)
        for job_id in ("s1", "s1:chunk", "s10:chunk", "s1x:chunk", "S1:chunk"):
            store.enqueue(job(job_id))
        result = store.prepare_job_deletion(operation_id(), "s1", "administrative_delete")
        assert {target["job_id"] for target in result["targets"]} == {"s1", "s1:chunk"}
        assert all(target["observed_provenance"] == "protected" for target in result["targets"])
        assert all(target["identity_status"] == "recorded_generation" for target in result["targets"])
        assert store.get("s10:chunk") is not None
        assert store.get("S1:chunk") is not None
    finally:
        lock.release()


def test_legacy_job_without_generation_is_observed_without_retrofit(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(job("old:chunk"))
    store._connection().execute(
        "UPDATE transcription_job SET generation_id=NULL WHERE id='old:chunk'"
    )
    result = store.prepare_job_deletion(operation_id(), "old", "manual_recovery")
    target = result["targets"][0]
    assert target["generation_id"] is None
    assert target["observation_id"]
    assert target["identity_status"] == "observed_only"
    assert target["snapshot_hash"]
    assert store.get("old:chunk")["generation_id"] is None
    assert store._connection().execute(
        "SELECT prior_history_status FROM job_history_scope WHERE id=1"
    ).fetchone()[0] == "unknown"


def test_preparation_without_jobs_still_closes_admission(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    result = store.prepare_job_deletion(operation_id(), "empty", "reprocess")
    assert result["targets"] == []
    assert store.admission_state("empty")["closed"] is True
    with pytest.raises(ValueError, match="admission is closed"):
        store.enqueue(job("empty:new"))
    assert store.claim_next() is None


def test_preexisting_unowned_closure_is_not_claimed(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    original = store.close_admission("closed")
    with pytest.raises(ValueError, match="reconciliation required"):
        store.prepare_job_deletion(operation_id(), "closed", "reprocess")
    assert store.admission_state("closed")["closed_at"] == original["closed_at"]
    assert store._connection().execute("SELECT COUNT(*) FROM job_deletion_operation").fetchone()[0] == 0


def test_target_failure_rolls_back_closure_operation_and_targets(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(job("session:chunk"))
    store._connection().execute(
        """CREATE TRIGGER reject_target BEFORE INSERT ON job_deletion_target
        BEGIN SELECT RAISE(ABORT, 'fixture target failure'); END"""
    )
    with pytest.raises(sqlite3.IntegrityError, match="fixture target failure"):
        store.prepare_job_deletion(operation_id(), "session", "reprocess")
    assert store.admission_state("session")["closed"] is False
    assert store._connection().execute("SELECT COUNT(*) FROM job_deletion_operation").fetchone()[0] == 0
    assert store._connection().execute("SELECT COUNT(*) FROM job_deletion_target").fetchone()[0] == 0
    assert store.get("session:chunk") is not None


def test_two_sessions_and_restart_keep_independent_frozen_targets(tmp_path: Path) -> None:
    path = tmp_path / "jobs.db"
    first = JobStore(path)
    first.enqueue(job("one:chunk"))
    first.enqueue(job("two:chunk"))
    one_id, two_id = operation_id(), operation_id()
    with ThreadPoolExecutor(max_workers=2) as pool:
        one_future = pool.submit(first.prepare_job_deletion, one_id, "one", "reprocess")
        two_future = pool.submit(first.prepare_job_deletion, two_id, "two", "reprocess")
        one, two = one_future.result(timeout=5), two_future.result(timeout=5)
    assert one["close_id"] != two["close_id"]
    restarted = JobStore(path)
    assert restarted.prepare_job_deletion(one_id, "one", "reprocess") == one
    assert restarted.job_deletion_operation(two_id) == two
    assert restarted.get("one:chunk") is not None
    assert restarted.get("two:chunk") is not None


def test_concurrent_operations_for_one_session_cannot_share_closure(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    ids = operation_id(), operation_id()
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(store.prepare_job_deletion, value, "session", "reprocess") for value in ids]
        outcomes = []
        for future in futures:
            try:
                outcomes.append(future.result(timeout=5))
            except ValueError as error:
                assert "reconciliation required" in str(error)
    assert len(outcomes) == 1
    assert store._connection().execute("SELECT COUNT(*) FROM job_deletion_operation").fetchone()[0] == 1


def test_prepare_orders_with_enqueue_and_claim_without_sleep(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(job("session:chunk"))
    entered, resume = Event(), Event()
    original = JobStore._record_deletion_target

    def pause_target(connection, operation, session, row):
        entered.set()
        assert resume.wait(5)
        original(connection, operation, session, row)

    monkeypatch.setattr(JobStore, "_record_deletion_target", staticmethod(pause_target))
    with ThreadPoolExecutor(max_workers=3) as pool:
        preparing = pool.submit(store.prepare_job_deletion, operation_id(), "session", "reprocess")
        assert entered.wait(5)
        posting = pool.submit(store.enqueue, job("session:new"))
        claiming = pool.submit(store.claim_next)
        resume.set()
        assert preparing.result(timeout=5)["status"] == "pending_drain"
        with pytest.raises(ValueError, match="admission is closed"):
            posting.result(timeout=5)
        assert claiming.result(timeout=5) is None
    assert store.get("session:chunk") is not None
    assert store.get("session:new") is None


def test_claim_first_is_snapshotted_and_occupation_survives(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(job("session:chunk"))
    claimed = store.claim_next()
    assert claimed is not None
    result = store.prepare_job_deletion(operation_id(), "session", "reprocess")
    state = store.admission_state("session")
    assert state["active_at_close"][0]["id"] == claimed["id"]
    assert state["occupations_at_close"][0]["id"] == claimed["occupation_id"]
    assert store.occupations_for_session("session")[0]["released_at"] is None
    assert result["targets"][0]["observed_status"] == "processing"
    assert store.claim_next() is None
    assert store.release_occupation(claimed["occupation_id"], claimed["id"], claimed["claim_token"])
    assert store.occupations_for_session("session")[0]["released_at"] is not None
    assert store.get("session:chunk") is not None


def test_concurrent_close_cannot_replace_preparation_closure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(job("session:chunk"))
    entered, resume = Event(), Event()
    original = JobStore._record_deletion_target

    def pause_target(connection, operation, session, row):
        entered.set()
        assert resume.wait(5)
        original(connection, operation, session, row)

    monkeypatch.setattr(JobStore, "_record_deletion_target", staticmethod(pause_target))
    with ThreadPoolExecutor(max_workers=2) as pool:
        preparing = pool.submit(store.prepare_job_deletion, operation_id(), "session", "reprocess")
        assert entered.wait(5)
        closing = pool.submit(store.close_admission, "session")
        resume.set()
        prepared = preparing.result(timeout=5)
        closed = closing.result(timeout=5)
    assert closed["closed_at"] == prepared["created_at"]
    assert store._connection().execute(
        "SELECT close_operation_id FROM session_admission WHERE session_id='session'"
    ).fetchone()[0] == prepared["close_id"]


def test_replay_does_not_reselect_even_if_job_row_changes(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(job("session:chunk"))
    op = operation_id()
    first = store.prepare_job_deletion(op, "session", "reprocess")
    store._connection().execute("UPDATE transcription_job SET status='failed' WHERE id='session:chunk'")
    assert store.prepare_job_deletion(op, "session", "reprocess") == first
    assert store.job_deletion_operation(op) == first
