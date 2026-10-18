from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest

from dotty_transcriber.instance_lock import TranscriberInstanceLock
from dotty_transcriber.storage import JobInput, JobStore, PROVENANCE_PROTOCOL_VERSION


def test_job_provenance_uses_the_held_lock_identity_and_does_not_retrofit_old_jobs(
    tmp_path: Path,
) -> None:
    path = tmp_path / "queue.db"
    legacy_store = JobStore(path)
    legacy = legacy_store.enqueue(JobInput("legacy:chunk", "unused.wav", "user", 0, "es"))
    assert legacy["provenance_status"] == "unknown"
    assert legacy["provenance_protocol_version"] is None
    assert legacy["provenance_instance_id"] is None
    legacy_store._connection().execute(
        "ALTER TABLE transcription_job DROP COLUMN provenance_instance_id"
    )
    legacy_store._connection().execute(
        "ALTER TABLE transcription_job DROP COLUMN provenance_protocol_version"
    )

    lock = TranscriberInstanceLock.acquire(tmp_path)
    try:
        store = JobStore(path, instance_lock=lock)
        accepted = store.enqueue(JobInput("new:chunk", "unused.wav", "user", 0, "es"))
        assert accepted["provenance_status"] == "protected"
        assert accepted["provenance_protocol_version"] == PROVENANCE_PROTOCOL_VERSION
        assert accepted["provenance_instance_id"] == lock.instance_id
        assert store.instance_id == lock.instance_id

        historical = store.get("legacy:chunk")
        assert historical is not None
        assert historical["provenance_status"] == "unknown"
        assert historical["provenance_protocol_version"] is None
        assert historical["provenance_instance_id"] is None
    finally:
        lock.release()


def test_unlocked_or_released_store_cannot_mark_jobs_as_protected(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    unlocked = JobStore(path)
    accepted = unlocked.enqueue(JobInput("unlocked:chunk", "unused.wav", "user", 0, "es"))
    assert accepted["provenance_status"] == "unknown"

    lock = TranscriberInstanceLock.acquire(tmp_path)
    try:
        store = JobStore(path, instance_lock=lock)
        lock.release()
        with pytest.raises(RuntimeError, match="held transcriber instance lock"):
            store.enqueue(JobInput("released:chunk", "unused.wav", "user", 0, "es"))
        assert store.get("released:chunk") is None
    finally:
        lock.release()


def test_job_store_rejects_lock_for_another_data_directory(tmp_path: Path) -> None:
    lock = TranscriberInstanceLock.acquire(tmp_path / "owner")
    try:
        with pytest.raises(ValueError, match="does not own"):
            JobStore(tmp_path / "other" / "queue.db", instance_lock=lock)
    finally:
        lock.release()


def test_lock_release_waits_until_protected_enqueue_commits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    lock = TranscriberInstanceLock.acquire(tmp_path)
    store = JobStore(tmp_path / "queue.db", instance_lock=lock)
    entered, continue_enqueue, release_attempted = Event(), Event(), Event()
    original = JobStore._assert_open

    class ObservedStateLock:
        def __init__(self, inner) -> None:
            self.inner = inner

        def __enter__(self):
            if entered.is_set():
                release_attempted.set()
            self.inner.acquire()
            return self

        def __exit__(self, *_args) -> None:
            self.inner.release()

    def paused_assert_open(connection, session_id):
        original(connection, session_id)
        entered.set()
        assert continue_enqueue.wait(5)

    monkeypatch.setattr(JobStore, "_assert_open", staticmethod(paused_assert_open))
    lock._state_lock = ObservedStateLock(lock._state_lock)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            enqueue = pool.submit(
                store.enqueue, JobInput("session:chunk", "unused.wav", "user", 0, "es")
            )
            assert entered.wait(5)
            release = pool.submit(lock.release)
            assert release_attempted.wait(5)
            assert not release.done()
            continue_enqueue.set()
            accepted = enqueue.result(timeout=5)
            release.result(timeout=5)
        assert accepted["provenance_instance_id"] == lock.instance_id
    finally:
        continue_enqueue.set()
        lock.release()


def test_session_inventory_matches_exact_and_delimited_ids_without_collisions(
    tmp_path: Path,
) -> None:
    lock = TranscriberInstanceLock.acquire(tmp_path)
    try:
        store = JobStore(tmp_path / "inventory.db", instance_lock=lock)
        for job_id in ("s1", "s1:chunk", "s10:chunk", "s1x:chunk", "S1:chunk"):
            store.enqueue(JobInput(job_id, "unused.wav", "user", 0, "es"))

        inventory = store.inventory_for_session("s1")
        assert {job["id"] for job in inventory["jobs"]} == {"s1", "s1:chunk"}
        assert inventory["classification"] == "protected-only"
        assert inventory["counts"]["jobs_protected"] == 2
        assert inventory["counts"]["jobs_unknown"] == 0
        assert inventory["instance_ids"] == [lock.instance_id]

        assert {job["id"] for job in store.inventory_for_session("s10")["jobs"]} == {"s10:chunk"}
        assert store.inventory_for_session("empty")["classification"] == "empty"
        assert "workers_inactive" not in inventory
        assert "wav_safe" not in inventory
    finally:
        lock.release()


def test_session_inventory_distinguishes_unknown_mixed_and_invalid_provenance(
    tmp_path: Path,
) -> None:
    path = tmp_path / "inventory.db"
    legacy_store = JobStore(path)
    legacy_store.enqueue(JobInput("unknown:old", "unused.wav", "user", 0, "es"))
    legacy_store.enqueue(JobInput("mixed:old", "unused.wav", "user", 0, "es"))

    lock = TranscriberInstanceLock.acquire(tmp_path)
    try:
        store = JobStore(path, instance_lock=lock)
        store.enqueue(JobInput("mixed:new", "unused.wav", "user", 0, "es"))
        store.enqueue(JobInput("corrupt:job", "unused.wav", "user", 0, "es"))
        store.enqueue(JobInput("future:job", "unused.wav", "user", 0, "es"))
        store._connection().execute(
            "UPDATE transcription_job SET provenance_protocol_version=1, "
            "provenance_instance_id='not-an-instance-id' WHERE id='corrupt:job'"
        )
        store._connection().execute(
            "UPDATE transcription_job SET provenance_protocol_version=?, "
            "provenance_instance_id=? WHERE id='future:job'",
            (PROVENANCE_PROTOCOL_VERSION + 1, lock.instance_id),
        )

        unknown = store.inventory_for_session("unknown")
        assert unknown["classification"] == "unknown-only"
        assert unknown["counts"]["jobs_unknown"] == 1

        mixed = store.inventory_for_session("mixed")
        assert mixed["classification"] == "mixed"
        assert mixed["counts"]["jobs_protected"] == 1
        assert mixed["counts"]["jobs_unknown"] == 1

        corrupt = store.inventory_for_session("corrupt")
        assert corrupt["classification"] == "uncertain"
        assert corrupt["counts"]["jobs_malformed_or_unrecognized"] == 1
        assert corrupt["jobs"][0]["provenance_status"] == "malformed"

        future = store.inventory_for_session("future")
        assert future["classification"] == "uncertain"
        assert future["counts"]["jobs_malformed_or_unrecognized"] == 1
        assert future["jobs"][0]["provenance_status"] == "unrecognized_version"
    finally:
        lock.release()


def test_session_inventory_preserves_provenance_across_retry_and_restart(
    tmp_path: Path,
) -> None:
    path = tmp_path / "inventory.db"
    first_lock = TranscriberInstanceLock.acquire(tmp_path)
    try:
        first = JobStore(path, instance_lock=first_lock)
        first.enqueue(JobInput("retry:chunk", "unused.wav", "user", 0, "es"))
        first._connection().execute(
            "UPDATE transcription_job SET max_attempts=1 WHERE id='retry:chunk'"
        )
        failed_claim = first.claim_next()
        assert failed_claim is not None
        assert first.fail(failed_claim["id"], failed_claim["claim_token"], "fixture failure")
        assert first.release_occupation(
            failed_claim["occupation_id"], failed_claim["id"], failed_claim["claim_token"]
        )
        original = first.get("retry:chunk")
        retried = first.retry("retry:chunk")
        assert retried["provenance_protocol_version"] == original["provenance_protocol_version"]
        assert retried["provenance_instance_id"] == original["provenance_instance_id"]

        retry_claim = first.claim_next()
        assert retry_claim is not None
        assert first.complete(retry_claim["id"], retry_claim["claim_token"], {})
        assert first.release_occupation(
            retry_claim["occupation_id"], retry_claim["id"], retry_claim["claim_token"]
        )

        first.enqueue(JobInput("pending:chunk", "unused.wav", "user", 0, "es"))
        pending_claim = first.claim_next()
        assert pending_claim is not None and pending_claim["id"] == "pending:chunk"
        first_instance_id = first_lock.instance_id
    finally:
        first_lock.release()

    second_lock = TranscriberInstanceLock.acquire(tmp_path)
    try:
        restarted = JobStore(path, instance_lock=second_lock)
        assert restarted.claim_next() is None
        pending = restarted.inventory_for_session("pending")
        assert pending["classification"] == "uncertain"
        assert pending["counts"]["jobs_protected"] == 1
        assert pending["counts"]["occupations_active"] == 1
        assert pending["counts"]["occupations_unreconciled"] == 1
        assert pending["jobs"][0]["provenance_instance_id"] == first_instance_id
        assert pending["current_instance_id"] == second_lock.instance_id
        assert first_instance_id in pending["instance_ids"]

        retried_inventory = restarted.inventory_for_session("retry")
        assert retried_inventory["classification"] == "protected-only"
        assert retried_inventory["jobs"][0]["provenance_instance_id"] == first_instance_id
    finally:
        second_lock.release()


def test_session_inventory_is_uncertain_after_job_delete_and_recreation(tmp_path: Path) -> None:
    fake_wav = tmp_path / "fixture.wav"
    fake_wav.write_bytes(b"temporary fixture audio bytes")
    lock = TranscriberInstanceLock.acquire(tmp_path)
    try:
        store = JobStore(tmp_path / "inventory.db", instance_lock=lock)
        job = JobInput("session:chunk", str(fake_wav), "user", 0, "es")
        store.enqueue(job)
        old_claim = store.claim_next()
        assert old_claim is not None

        assert store.delete_for_session("session") == 1
        store.enqueue(job)
        inventory = store.inventory_for_session("session")
        assert inventory["classification"] == "uncertain"
        assert inventory["counts"]["jobs_protected"] == 1
        assert inventory["counts"]["occupations_active"] == 1
        assert "active_occupation_claim_mismatch" in inventory["uncertainty_reasons"]
        assert fake_wav.read_bytes() == b"temporary fixture audio bytes"
        assert "workers_inactive" not in inventory
        assert "wav_safe" not in inventory
    finally:
        lock.release()


def test_session_inventory_reads_consistently_during_admission_and_release(
    tmp_path: Path,
) -> None:
    lock = TranscriberInstanceLock.acquire(tmp_path)
    try:
        store = JobStore(tmp_path / "inventory.db", instance_lock=lock)
        store.enqueue(JobInput("session:chunk", "unused.wav", "user", 0, "es"))
        claim = store.claim_next()
        assert claim is not None

        def read_inventories():
            return [store.inventory_for_session("session") for _ in range(30)]

        with ThreadPoolExecutor(max_workers=3) as pool:
            reads = pool.submit(read_inventories)
            closing = pool.submit(store.close_admission, "session")
            releasing = pool.submit(
                store.release_occupation, claim["occupation_id"], claim["id"], claim["claim_token"]
            )
            snapshots = reads.result(timeout=10)
            assert closing.result(timeout=10)["closed"] is True
            assert releasing.result(timeout=10) is True

        for snapshot in snapshots:
            assert snapshot["counts"]["jobs_total"] == 1
            assert snapshot["counts"]["jobs_protected"] == 1
            assert snapshot["counts"]["occupations_active"] in {0, 1}
            assert snapshot["counts"]["occupations_active"] == sum(
                occupation["active"] for occupation in snapshot["occupations"]
            )
    finally:
        lock.release()


def test_repeated_failures_become_visible_and_manually_retryable(tmp_path: Path) -> None:
    path = tmp_path / "crashes.db"
    store = JobStore(path)
    store.enqueue(JobInput("session:chunk", "unused.wav", "user", 0, "es"))
    for attempt in range(1, 4):
        claimed = store.claim_next()
        assert claimed is not None and claimed["attempts"] == attempt
        assert store.fail(claimed["id"], claimed["claim_token"], "fixture failure")
        assert store.claim_next() is None
        assert store.release_occupation(
            claimed["occupation_id"], claimed["id"], claimed["claim_token"]
        )
    store = JobStore(path)
    assert store.metrics()["failed"] == 1
    assert store.metrics()["queued"] == 0
    assert store.claim_next() is None
    assert store.retry_failed_for_session("session") == 1
    new_claim = store.claim_next()
    assert new_claim is not None and new_claim["attempts"] == 1
    assert not store.complete(claimed["id"], claimed["claim_token"], {"stale": True})
    assert store.complete(new_claim["id"], new_claim["claim_token"], {"recovered": True})


def test_recovers_legacy_exhausted_queued_job(tmp_path: Path) -> None:
    path = tmp_path / "legacy.db"
    store = JobStore(path)
    store.enqueue(JobInput("session:chunk", "unused.wav", "user", 0, "es"))
    store._connection().execute("UPDATE transcription_job SET attempts=3")
    recovered = JobStore(path)
    assert recovered.get("session:chunk")["status"] == "failed"
    recovered.retry("session:chunk")
    assert recovered.claim_next() is not None


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
    assert recovered_claim is None
    assert recovered.occupations_for_session("chunk-1")[0]["pending_reconciliation"] is True
    assert store.release_occupation(claimed["occupation_id"], claimed["id"], claimed["claim_token"])
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
        assert store.claim_next() is None
        assert store.release_occupation(
            claimed["occupation_id"], claimed["id"], claimed["claim_token"]
        )
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
        assert store.release_occupation(second["occupation_id"], second["id"], second["claim_token"])
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
    assert store.claim_next() is None
    assert store.release_occupation(old_claim["occupation_id"], old_claim["id"], old_claim["claim_token"])
    new_claim = store.claim_next()
    assert new_claim is not None
    assert new_claim["claim_token"] != old_claim["claim_token"]

    assert not store.complete(old_claim["id"], old_claim["claim_token"], {"stale": True})
    assert not store.fail(old_claim["id"], old_claim["claim_token"], "stale failure")
    assert store.get(job.id)["status"] == "processing"
    assert store.complete(new_claim["id"], new_claim["claim_token"], {"fresh": True})
    assert store.get(job.id)["result"] == {"fresh": True}


def test_admission_closure_is_idempotent_persistent_and_preserves_active_evidence(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    wav = tmp_path / "audio.wav"
    wav.write_bytes(b"temporary fixture only")
    store = JobStore(path)
    assert store.admission_state("session-1")["closed"] is False
    store.enqueue(JobInput("session-1:active", str(wav), "user", 0, "es"))
    store.enqueue(JobInput("session-1:pending", str(wav), "user", 1, "es"))
    active = store.claim_next()
    assert active is not None and active["id"] == "session-1:active"
    closed = store.close_admission("session-1")
    assert closed["closed"] is True
    assert closed["pending_jobs"] == 1
    assert closed["active_jobs"] == 1
    assert closed["active_at_close"] == [{"id": active["id"], "claim_token": active["claim_token"]}]
    assert closed["workers_inactive"] is None
    assert store.close_admission("session-1")["closed_at"] == closed["closed_at"]
    with pytest.raises(ValueError, match="admission is closed"):
        store.enqueue(JobInput("session-1:new", str(wav), "user", 2, "es"))
    assert store.claim_next() is None
    restarted = JobStore(path)
    assert restarted.admission_state("session-1")["active_at_close"] == closed["active_at_close"]
    assert restarted.admission_state("session-1")["active_jobs"] == 1
    assert restarted.get(active["id"])["status"] == "processing"
    assert restarted.claim_next() is None
    assert wav.read_bytes() == b"temporary fixture only"


def test_closed_session_does_not_block_other_jobs_or_allow_retries(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "queue.db")
    closed = JobInput("closed:failed", "unused.wav", "user", 0, "es")
    store.enqueue(closed)
    claim = store.claim_next()
    assert claim is not None
    for attempt in range(3):
        store.fail(closed.id, claim["claim_token"], "failed")
        assert store.release_occupation(claim["occupation_id"], claim["id"], claim["claim_token"])
        if attempt < 2:
            claim = store.claim_next()
            assert claim is not None
    store.close_admission("closed")
    with pytest.raises(ValueError, match="admission is closed"):
        store.retry(closed.id)
    with pytest.raises(ValueError, match="admission is closed"):
        store.retry_failed_for_session("closed")
    other = JobInput("other:chunk", "unused.wav", "user", 0, "es")
    assert store.enqueue(other)["status"] == "queued"
    assert store.claim_next()["id"] == other.id


def test_enqueue_commits_before_concurrent_close(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = JobStore(tmp_path / "queue.db")
    entered, release = Event(), Event()
    original = JobStore._assert_open

    def paused_check(connection, session_id):
        original(connection, session_id)
        if session_id == "session":
            entered.set()
            assert release.wait(5)

    monkeypatch.setattr(JobStore, "_assert_open", staticmethod(paused_check))
    with ThreadPoolExecutor(max_workers=2) as pool:
        posting = pool.submit(store.enqueue, JobInput("session:chunk", "unused.wav", "user", 0, "es"))
        assert entered.wait(5)
        closing = pool.submit(store.close_admission, "session")
        release.set()
        assert posting.result(timeout=5)["id"] == "session:chunk"
        state = closing.result(timeout=5)
    assert state["pending_jobs"] == 1
    assert store.claim_next() is None


def test_close_commits_before_concurrent_enqueue_and_claim(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = JobStore(tmp_path / "queue.db")
    store.enqueue(JobInput("session:chunk", "unused.wav", "user", 0, "es"))
    entered, release = Event(), Event()
    original = JobStore._admission_state

    def paused_state(connection, session_id):
        state = original(connection, session_id)
        if session_id == "session":
            entered.set()
            assert release.wait(5)
        return state

    monkeypatch.setattr(JobStore, "_admission_state", staticmethod(paused_state))
    with ThreadPoolExecutor(max_workers=3) as pool:
        closing = pool.submit(store.close_admission, "session")
        assert entered.wait(5)
        posting = pool.submit(store.enqueue, JobInput("session:new", "unused.wav", "user", 1, "es"))
        claiming = pool.submit(store.claim_next)
        release.set()
        assert closing.result(timeout=5)["closed"] is True
        with pytest.raises(ValueError, match="admission is closed"):
            posting.result(timeout=5)
        assert claiming.result(timeout=5) is None
    assert store.get("session:new") is None


def test_claim_commits_before_concurrent_close_and_is_recorded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = JobStore(tmp_path / "queue.db")
    store.enqueue(JobInput("session:chunk", "unused.wav", "user", 0, "es"))
    entered, release = Event(), Event()
    from dotty_transcriber import storage
    original = storage.uuid.uuid4

    def paused_uuid():
        entered.set()
        assert release.wait(5)
        return original()

    monkeypatch.setattr(storage.uuid, "uuid4", paused_uuid)
    with ThreadPoolExecutor(max_workers=2) as pool:
        claiming = pool.submit(store.claim_next)
        assert entered.wait(5)
        closing = pool.submit(store.close_admission, "session")
        release.set()
        claim = claiming.result(timeout=5)
        state = closing.result(timeout=5)
    assert claim is not None
    assert state["active_at_close"] == [{"id": claim["id"], "claim_token": claim["claim_token"]}]
    assert state["workers_inactive"] is None


def test_additive_schema_on_existing_database_and_snapshot_after_row_delete(tmp_path: Path) -> None:
    path = tmp_path / "existing.db"
    first = JobStore(path)
    first.enqueue(JobInput("session:chunk", "unused.wav", "user", 0, "es"))
    first._connection().execute("DROP TABLE session_admission")
    restored = JobStore(path)
    assert restored.get("session:chunk")["status"] == "queued"
    active = restored.claim_next()
    assert active is not None
    snapshot = restored.close_admission("session")
    assert restored.delete_for_session("session") == 1
    after_delete = restored.admission_state("session")
    assert after_delete["active_jobs"] == 0
    assert after_delete["active_at_close"] == snapshot["active_at_close"]
    assert after_delete["workers_inactive"] is None
