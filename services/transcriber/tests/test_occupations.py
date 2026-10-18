import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest

from dotty_transcriber.storage import JobInput, JobStore


def _job(job_id: str, audio_path: str = "unused.wav") -> JobInput:
    return JobInput(job_id, audio_path, "user", 0, "es")


def test_claim_creates_occupation_in_same_transaction(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(_job("session:chunk"))
    claim = store.claim_next()
    assert claim is not None
    occupation = store.occupations_for_session("session")[0]
    assert occupation["id"] == claim["occupation_id"]
    assert occupation["session_id"] == "session"
    assert occupation["job_id"] == claim["id"]
    assert occupation["claim_token"] == claim["claim_token"]
    assert occupation["instance_id"] == claim["instance_id"] == store.instance_id
    assert occupation["acquired_at"]
    assert occupation["released_at"] is None
    assert occupation["pending_reconciliation"] is False


def test_occupation_insert_failure_rolls_back_claim(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(_job("session:chunk"))
    store._connection().execute(
        """CREATE TRIGGER reject_occupation BEFORE INSERT ON worker_occupation
        BEGIN SELECT RAISE(ABORT, 'fixture occupation failure'); END"""
    )
    with pytest.raises(sqlite3.IntegrityError, match="fixture occupation failure"):
        store.claim_next()
    assert store.get("session:chunk")["status"] == "queued"
    assert store.get("session:chunk")["attempts"] == 0
    assert store.occupations_for_session("session") == []


def test_closed_session_cannot_claim_or_create_occupation(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(_job("session:chunk"))
    store.close_admission("session")
    assert store.claim_next() is None
    assert store.occupations_for_session("session") == []


def test_claim_before_close_snapshots_occupation_and_release_keeps_evidence(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(_job("session:chunk"))
    claim = store.claim_next()
    closed = store.close_admission("session")
    assert len(closed["occupations_at_close"]) == 1
    assert closed["occupations_at_close"][0]["id"] == claim["occupation_id"]
    assert closed["active_occupations"][0]["id"] == claim["occupation_id"]
    assert closed["workers_inactive"] is None
    assert store.release_occupation(claim["occupation_id"], claim["id"], claim["claim_token"])
    after = store.admission_state("session")
    assert after["active_occupations"] == []
    assert after["occupations_at_close"] == closed["occupations_at_close"]
    assert after["workers_inactive"] is None


def test_two_workers_claim_distinct_jobs_and_occupations(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(_job("session:first"))
    store.enqueue(_job("session:second"))
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = [future.result(timeout=5) for future in
                  (pool.submit(store.claim_next), pool.submit(store.claim_next))]
    assert {claim["id"] for claim in claims} == {"session:first", "session:second"}
    assert len({claim["occupation_id"] for claim in claims}) == 2
    assert len(store.occupations_for_session("session")) == 2


def test_close_waits_for_claim_transaction_and_captures_occupation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(_job("session:chunk"))
    entered, release = Event(), Event()
    original = JobStore._record_occupation

    def paused_record(self, *args):
        entered.set()
        assert release.wait(5)
        return original(self, *args)

    monkeypatch.setattr(JobStore, "_record_occupation", paused_record)
    with ThreadPoolExecutor(max_workers=2) as pool:
        claiming = pool.submit(store.claim_next)
        assert entered.wait(5)
        closing = pool.submit(store.close_admission, "session")
        release.set()
        claim = claiming.result(timeout=5)
        closed = closing.result(timeout=5)
    assert closed["occupations_at_close"][0]["id"] == claim["occupation_id"]


def test_two_sessions_have_independent_occupation_evidence(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(_job("one:chunk"))
    store.enqueue(_job("two:chunk"))
    one = store.claim_next()
    store.close_admission("one")
    two = store.claim_next()
    assert two["id"] == "two:chunk"
    assert [row["id"] for row in store.occupations_for_session("one")] == [one["occupation_id"]]
    assert [row["id"] for row in store.occupations_for_session("two")] == [two["occupation_id"]]


def test_restart_preserves_occupation_as_pending_reconciliation(tmp_path: Path) -> None:
    path = tmp_path / "jobs.db"
    first = JobStore(path)
    first.enqueue(_job("session:chunk"))
    claim = first.claim_next()
    restarted = JobStore(path)
    assert restarted.instance_id != first.instance_id
    occupation = restarted.occupations_for_session("session")[0]
    assert occupation["id"] == claim["occupation_id"]
    assert occupation["released_at"] is None
    assert occupation["pending_reconciliation"] is True
    assert restarted.get("session:chunk")["status"] == "queued"
    assert restarted.admission_state("session")["workers_inactive"] is None


def test_release_checks_token_instance_job_and_duplicate(tmp_path: Path) -> None:
    path = tmp_path / "jobs.db"
    owner = JobStore(path)
    owner.enqueue(_job("session:chunk"))
    claim = owner.claim_next()
    other = JobStore(path)
    assert not other.release_occupation(claim["occupation_id"], claim["id"], claim["claim_token"])
    assert not owner.release_occupation(claim["occupation_id"], claim["id"], "wrong-token")
    assert not owner.release_occupation(claim["occupation_id"], "other:chunk", claim["claim_token"])
    assert owner.release_occupation(claim["occupation_id"], claim["id"], claim["claim_token"])
    assert not owner.release_occupation(claim["occupation_id"], claim["id"], claim["claim_token"])
    assert owner.occupations_for_session("session")[0]["released_at"] is not None


def test_job_completion_failure_and_deletion_do_not_release(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(_job("session:completed"))
    completed = store.claim_next()
    assert store.complete(completed["id"], completed["claim_token"], {})
    store.enqueue(_job("session:failed"))
    failed = store.claim_next()
    assert store.fail(failed["id"], failed["claim_token"], "fixture failure")
    assert store.delete_for_session("session") == 2
    occupations = store.occupations_for_session("session")
    assert {row["id"] for row in occupations} == {
        completed["occupation_id"], failed["occupation_id"]
    }
    assert all(row["released_at"] is None for row in occupations)


def test_existing_database_adds_occupation_schema_without_changing_job_or_wav(tmp_path: Path) -> None:
    path = tmp_path / "existing.db"
    wav = tmp_path / "fixture.wav"
    wav.write_bytes(b"fixture only")
    original = JobStore(path)
    original.enqueue(_job("session:chunk", str(wav)))
    original._connection().execute("DROP TABLE worker_occupation")
    original._connection().execute("DROP TABLE session_admission")
    original._connection().execute(
        """CREATE TABLE session_admission (
        session_id TEXT PRIMARY KEY, closed_at TEXT NOT NULL,
        active_at_close_json TEXT NOT NULL)"""
    )
    restarted = JobStore(path)
    assert restarted.get("session:chunk")["status"] == "queued"
    claim = restarted.claim_next()
    assert restarted.occupations_for_session("session")[0]["id"] == claim["occupation_id"]
    assert wav.read_bytes() == b"fixture only"
