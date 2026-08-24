from pathlib import Path

import pytest

from dotty_transcriber.storage import JobInput, JobStore


def test_queue_is_idempotent_and_recovers_processing(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "queue.db")
    job = JobInput("chunk-1", "audio.wav", "user-1", 1200, "es")
    assert store.enqueue(job)["status"] == "queued"
    assert store.enqueue(job)["id"] == "chunk-1"
    claimed = store.claim_next()
    assert claimed["status"] == "processing"
    store.update_progress("chunk-1", claimed["claim_token"], 0.5, 10.0, 20.0)
    assert store.current_work()["progress"] == 0.5
    assert store.current_work()["processed_audio_seconds"] == 10.0

    recovered = JobStore(tmp_path / "queue.db")
    recovered_claim = recovered.claim_next()
    assert recovered_claim["attempts"] == 2
    recovered.complete("chunk-1", recovered_claim["claim_token"], {"segments": []})
    assert recovered.get("chunk-1")["status"] == "completed"
    assert recovered.get("chunk-1")["progress"] == 1
    assert recovered.current_work() is None


def test_rejects_id_reuse_with_different_payload(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "queue.db")
    store.enqueue(JobInput("same", "one.wav", "user", 0, "es"))
    with pytest.raises(ValueError):
        store.enqueue(JobInput("same", "two.wav", "user", 0, "es"))


def test_failed_job_can_be_retried(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "queue.db")
    store.enqueue(JobInput("retry", "audio.wav", "user", 0, "es"))
    for _ in range(3):
        claimed = store.claim_next()
        store.fail("retry", claimed["claim_token"], "temporary failure")
    assert store.get("retry")["status"] == "failed"
    assert store.retry("retry")["status"] == "queued"
    assert store.get("retry")["attempts"] == 0


def test_reports_session_progress_and_retries_failed_session(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "queue.db")
    store.enqueue(JobInput("session-1:first", "a.wav", "user", 0, "es"))
    store.enqueue(JobInput("session-1:second", "b.wav", "user", 1, "es"))
    store.enqueue(JobInput("session-2:other", "c.wav", "user", 2, "es"))
    first = store.claim_next()
    assert first is not None
    store.complete(first["id"], first["claim_token"], {"segments": []})
    second = store.claim_next()
    assert second is not None
    store.update_progress(second["id"], second["claim_token"], 0.5, 1.0, 2.0)
    work = store.current_work()
    assert work is not None
    assert work["session_id"] == "session-1"
    assert work["session_total_jobs"] == 2
    assert work["session_completed_jobs"] == 1
    assert work["session_progress"] == 0.75
    for _ in range(3):
        store.fail(second["id"], second["claim_token"], "temporary")
        if store.get(second["id"])["status"] != "failed":
            second = store.claim_next()
            assert second is not None
    assert store.failed_sessions()[0]["session_id"] == "session-1"
    assert store.retry_failed_for_session("session-1") == 1


def test_lists_jobs_for_one_session_in_timeline_order(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "queue.db")
    store.enqueue(JobInput("session-1:later", "b.wav", "user", 2000, "es"))
    store.enqueue(JobInput("session-2:other", "c.wav", "user", 0, "es"))
    store.enqueue(JobInput("session-1:first", "a.wav", "user", 100, "es"))
    assert [job["id"] for job in store.list_for_session("session-1")] == [
        "session-1:first",
        "session-1:later",
    ]
    assert store.delete_for_session("session-1") == 2
    assert store.list_for_session("session-1") == []
    assert store.get("session-2:other") is not None


def test_stale_worker_cannot_overwrite_recreated_job(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "queue.db")
    job = JobInput("session-1:chunk", "audio.wav", "user", 0, "es")
    store.enqueue(job)
    old_claim = store.claim_next()
    assert old_claim is not None
    assert store.delete_for_session("session-1") == 1

    store.enqueue(job)
    new_claim = store.claim_next()
    assert new_claim is not None
    assert new_claim["claim_token"] != old_claim["claim_token"]

    assert not store.complete(old_claim["id"], old_claim["claim_token"], {"stale": True})
    assert not store.fail(old_claim["id"], old_claim["claim_token"], "stale failure")
    assert store.get(job.id)["status"] == "processing"
    assert store.complete(new_claim["id"], new_claim["claim_token"], {"fresh": True})
    assert store.get(job.id)["result"] == {"fresh": True}
