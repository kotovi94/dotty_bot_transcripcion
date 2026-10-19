"""Fail-closed, read-only administrative reconciliation assessment."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid

import pytest

from dotty_transcriber.instance_lock import TranscriberInstanceLock
from dotty_transcriber.reconciliation import (
    NoVerifiedInactivityEvidence,
    _assess_snapshot,
    evaluate_job_deletion_reconciliation,
)
from dotty_transcriber.storage import JobInput, JobStore


def prepared(tmp_path: Path, *, claim: bool = False):
    wav = tmp_path / "fixture.wav"
    wav.write_bytes(b"fictional WAV")
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(JobInput("session:chunk", str(wav), "fixture", 0, "es"))
    claimed = store.claim_next() if claim else None
    operation_id = str(uuid.uuid4())
    store.prepare_job_deletion(operation_id, "session", "reprocess")
    return store, operation_id, wav, claimed


def assess(store: JobStore, operation_id: str):
    return evaluate_job_deletion_reconciliation(
        store, operation_id, NoVerifiedInactivityEvidence()
    )


def test_missing_evidence_blocks_even_when_occupation_is_recorded(tmp_path: Path) -> None:
    store, operation_id, _, claim = prepared(tmp_path, claim=True)
    result = assess(store, operation_id)
    assert result.verdict == "missing_evidence"
    assert result.eligible is False
    assert result.occupation_ids == (claim["occupation_id"],)
    assert result.reasons == ("verified_inactivity_unavailable",)
    assert store.occupations_for_session("session")[0]["released_at"] is None


def test_current_os_lock_and_no_occupations_do_not_fabricate_process_proof(
    tmp_path: Path,
) -> None:
    wav = tmp_path / "fixture.wav"
    wav.write_bytes(b"fictional WAV")
    lock = TranscriberInstanceLock.acquire(tmp_path)
    try:
        store = JobStore(tmp_path / "jobs.db", instance_lock=lock)
        store.enqueue(JobInput("session:chunk", str(wav), "fixture", 0, "es"))
        operation_id = str(uuid.uuid4())
        store.prepare_job_deletion(operation_id, "session", "reprocess")
        result = assess(store, operation_id)
        assert result.verdict == "missing_evidence"
        assert result.eligible is False
    finally:
        lock.release()


@pytest.mark.parametrize("untrusted", [True, {"workers_inactive": True}, object()])
def test_untrusted_boolean_or_http_shaped_evidence_is_rejected(
    tmp_path: Path, untrusted: object,
) -> None:
    store, operation_id, _, _ = prepared(tmp_path)
    with pytest.raises(TypeError, match="trusted internal evidence"):
        evaluate_job_deletion_reconciliation(store, operation_id, untrusted)


def test_crossed_claim_identity_is_contradictory(tmp_path: Path) -> None:
    store, operation_id, _, claim = prepared(tmp_path, claim=True)
    store._connection().execute(
        "UPDATE worker_occupation SET claim_token=? WHERE id=?",
        (uuid.uuid4().hex, claim["occupation_id"]),
    )
    result = assess(store, operation_id)
    assert result.verdict == "contradictory_evidence"
    assert result.eligible is False
    assert "occupation_snapshot_mismatch" in result.reasons
    assert "active_claim_mismatch" in result.reasons


@pytest.mark.parametrize("field,replacement", [
    ("audio_path", "other.wav"),
    ("speaker_user_id", "another-speaker"),
    ("language", "en"),
    ("initial_prompt", "altered prompt"),
    ("hotwords", "altered hotwords"),
    ("created_at", "2000-01-01T00:00:00+00:00"),
])
def test_changed_job_identity_or_input_blocks_assessment(
    tmp_path: Path, field: str, replacement: str,
) -> None:
    store, operation_id, _, _ = prepared(tmp_path)
    store._connection().execute(
        f"UPDATE transcription_job SET {field}=? WHERE id='session:chunk'", (replacement,),
    )
    result = assess(store, operation_id)
    assert result.verdict == "contradictory_evidence"
    assert "frozen_job_identity_mismatch" in result.reasons
    assert result.eligible is False


def test_rehashed_frozen_snapshot_cannot_be_written(tmp_path: Path) -> None:
    store, operation_id, _, _ = prepared(tmp_path)
    row = store._connection().execute(
        "SELECT snapshot_json FROM job_deletion_target WHERE operation_id=?", (operation_id,),
    ).fetchone()
    frozen = json.loads(row["snapshot_json"])
    frozen["audio_path"] = "substituted.wav"
    changed = json.dumps(frozen, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        store._connection().execute(
            "UPDATE job_deletion_target SET snapshot_json=?,snapshot_hash=? WHERE operation_id=?",
            (changed, hashlib.sha256(changed.encode()).hexdigest(), operation_id),
        )
    result = assess(store, operation_id)
    assert result.verdict == "missing_evidence"
    assert result.eligible is False


def test_evaluator_rejects_rehashed_but_inconsistent_snapshot_rows(tmp_path: Path) -> None:
    store, operation_id, _, _ = prepared(tmp_path)
    db = store._connection()
    operation = db.execute(
        "SELECT * FROM job_deletion_operation WHERE operation_id=?", (operation_id,),
    ).fetchone()
    gate = db.execute(
        "SELECT * FROM session_admission WHERE session_id='session'"
    ).fetchone()
    target = dict(db.execute(
        "SELECT * FROM job_deletion_target WHERE operation_id=?", (operation_id,),
    ).fetchone())
    frozen = json.loads(target["snapshot_json"])
    frozen["audio_path"] = "substituted.wav"
    target["snapshot_json"] = json.dumps(
        frozen, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    )
    target["snapshot_hash"] = hashlib.sha256(target["snapshot_json"].encode()).hexdigest()
    jobs = db.execute("SELECT rowid AS observed_rowid,* FROM transcription_job").fetchall()
    generations = db.execute("SELECT * FROM job_generation_history").fetchall()
    result = _assess_snapshot(
        operation_id, NoVerifiedInactivityEvidence(), operation, gate, [target],
        jobs, [], generations,
    )
    assert result.verdict == "contradictory_evidence"
    assert "frozen_job_identity_mismatch" in result.reasons


def test_frozen_occupation_must_match_frozen_active_job(tmp_path: Path) -> None:
    store, operation_id, _, claim = prepared(tmp_path, claim=True)
    row = store._connection().execute(
        "SELECT occupations_at_close_json FROM session_admission WHERE session_id='session'"
    ).fetchone()
    occupations = json.loads(row["occupations_at_close_json"])
    crossed = uuid.uuid4().hex
    occupations[0]["claim_token"] = crossed
    store._connection().execute(
        "UPDATE session_admission SET occupations_at_close_json=? WHERE session_id='session'",
        (json.dumps(occupations),),
    )
    store._connection().execute(
        "UPDATE worker_occupation SET claim_token=? WHERE id=?",
        (crossed, claim["occupation_id"]),
    )
    result = assess(store, operation_id)
    assert result.verdict == "contradictory_evidence"
    assert "frozen_claim_occupation_mismatch" in result.reasons
    assert result.eligible is False


@pytest.mark.parametrize("field", ["id", "instance_id"])
def test_crossed_frozen_occupation_identity_is_contradictory(
    tmp_path: Path, field: str,
) -> None:
    store, operation_id, _, _ = prepared(tmp_path, claim=True)
    row = store._connection().execute(
        "SELECT occupations_at_close_json FROM session_admission WHERE session_id='session'"
    ).fetchone()
    occupations = json.loads(row["occupations_at_close_json"])
    occupations[0][field] = uuid.uuid4().hex
    store._connection().execute(
        "UPDATE session_admission SET occupations_at_close_json=? WHERE session_id='session'",
        (json.dumps(occupations),),
    )
    result = assess(store, operation_id)
    assert result.verdict == "contradictory_evidence"
    assert "occupation_snapshot_mismatch" in result.reasons


def test_process_evidence_identity_remains_unverified_without_persisted_epoch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, operation_id, _, claim = prepared(tmp_path, claim=True)
    observed = []

    def observe(_self, identity):
        observed.append(identity)
        return "missing_evidence"

    monkeypatch.setattr(NoVerifiedInactivityEvidence, "observe", observe)
    result = assess(store, operation_id)
    assert result.verdict == "missing_evidence"
    assert result.eligible is False
    assert len(observed) == 1
    assert observed[0].operation_id == operation_id
    assert observed[0].instance_id == claim["instance_id"]
    assert observed[0].snapshot_hash == result.snapshot_hash
    assert observed[0].lock_epoch_id is None
    assert observed[0].owner is None
    assert observed[0].process_scope is None
    assert len(observed[0].occupations) == 1
    assert observed[0].occupations[0].occupation_id == claim["occupation_id"]
    assert observed[0].occupations[0].job_id == claim["id"]
    assert observed[0].occupations[0].claim_token == claim["claim_token"]


def test_unverified_positive_response_cannot_become_authorization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, operation_id, _, _ = prepared(tmp_path, claim=True)
    monkeypatch.setattr(
        NoVerifiedInactivityEvidence, "observe", lambda _self, _identity: "accredited_inactive",
    )
    with pytest.raises(TypeError, match="Unverified process evidence"):
        assess(store, operation_id)


def test_write_during_evidence_observation_invalidates_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, operation_id, _, _ = prepared(tmp_path, claim=True)

    def change_after_snapshot(_self, _identity):
        store._connection().execute(
            "UPDATE transcription_job SET audio_path='changed-after-snapshot.wav' "
            "WHERE id='session:chunk'"
        )
        return "missing_evidence"

    monkeypatch.setattr(NoVerifiedInactivityEvidence, "observe", change_after_snapshot)
    result = assess(store, operation_id)
    assert result.verdict == "contradictory_evidence"
    assert "snapshot_changed_during_evaluation" in result.reasons
    assert result.eligible is False


def test_orphan_occupation_is_contradictory(tmp_path: Path) -> None:
    store, operation_id, _, claim = prepared(tmp_path, claim=True)
    store._connection().execute(
        "UPDATE worker_occupation SET job_id='session:missing' WHERE id=?",
        (claim["occupation_id"],),
    )
    result = assess(store, operation_id)
    assert result.verdict == "contradictory_evidence"
    assert "orphan_occupation" in result.reasons
    assert result.eligible is False


def test_occupation_with_crossed_session_identity_is_still_discovered(
    tmp_path: Path,
) -> None:
    store, operation_id, _, claim = prepared(tmp_path, claim=True)
    store._connection().execute(
        "UPDATE worker_occupation SET session_id='other' WHERE id=?",
        (claim["occupation_id"],),
    )
    result = assess(store, operation_id)
    assert result.verdict == "contradictory_evidence"
    assert "orphan_occupation" in result.reasons
    assert "occupation_snapshot_mismatch" in result.reasons
    assert result.eligible is False


def test_observed_only_target_is_never_eligible(tmp_path: Path) -> None:
    wav = tmp_path / "fixture.wav"
    wav.write_bytes(b"fictional WAV")
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(JobInput("session:chunk", str(wav), "fixture", 0, "es"))
    store._connection().execute(
        "UPDATE transcription_job SET generation_id=NULL WHERE id='session:chunk'"
    )
    operation_id = str(uuid.uuid4())
    store.prepare_job_deletion(operation_id, "session", "manual_recovery")
    result = assess(store, operation_id)
    assert result.verdict == "contradictory_evidence"
    assert "observed_only_target" in result.reasons
    assert result.eligible is False


def test_substituted_generation_is_contradictory(tmp_path: Path) -> None:
    store, operation_id, _, _ = prepared(tmp_path)
    store._connection().execute(
        "UPDATE transcription_job SET generation_id=? WHERE id='session:chunk'",
        (uuid.uuid4().hex,),
    )
    result = assess(store, operation_id)
    assert result.verdict == "contradictory_evidence"
    assert "generation_substituted" in result.reasons
    assert result.eligible is False


def test_job_added_after_close_is_contradictory(tmp_path: Path) -> None:
    store, operation_id, wav, _ = prepared(tmp_path)
    store._connection().execute(
        """INSERT INTO transcription_job
        (id,audio_path,speaker_user_id,start_offset_ms,language,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)""",
        ("session:late", str(wav), "fixture", 1, "es", "fixture-time", "fixture-time"),
    )
    result = assess(store, operation_id)
    assert result.verdict == "contradictory_evidence"
    assert "job_after_close" in result.reasons
    assert result.eligible is False


def test_append_only_history_detects_late_job_even_if_row_is_absent(
    tmp_path: Path,
) -> None:
    store, operation_id, _, _ = prepared(tmp_path)
    store._connection().execute(
        """INSERT INTO job_generation_history
        (generation_id,session_id,job_id,admission_provenance,audio_origin_status,admitted_at)
        VALUES (?,? ,?,'unknown','unknown',?)""",
        (uuid.uuid4().hex, "session", "session:late", "9999-01-01T00:00:00+00:00"),
    )
    result = assess(store, operation_id)
    assert result.verdict == "contradictory_evidence"
    assert "admission_after_close" in result.reasons
    assert result.eligible is False


def test_close_identity_and_frozen_active_claim_are_checked(tmp_path: Path) -> None:
    store, operation_id, _, _ = prepared(tmp_path, claim=True)
    store._connection().execute(
        "UPDATE session_admission SET active_at_close_json=? WHERE session_id='session'",
        ('[{"id":"session:chunk","claim_token":"crossed"}]',),
    )
    result = assess(store, operation_id)
    assert result.verdict == "contradictory_evidence"
    assert "active_at_close_mismatch" in result.reasons
    store._connection().execute(
        "UPDATE session_admission SET close_operation_id='other' WHERE session_id='session'"
    )
    assert "close_identity_mismatch" in assess(store, operation_id).reasons


def test_assessment_is_read_only_and_concurrent_calls_do_not_release(
    tmp_path: Path,
) -> None:
    store, operation_id, wav, claim = prepared(tmp_path, claim=True)
    before = tuple(store._connection().iterdump())
    audio_before = wav.read_bytes()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: assess(store, operation_id), range(2)))
    assert results[0] == results[1]
    assert results[0].eligible is False
    assert tuple(store._connection().iterdump()) == before
    assert wav.read_bytes() == audio_before
    assert store.occupations_for_session("session")[0]["id"] == claim["occupation_id"]
    assert store.occupations_for_session("session")[0]["released_at"] is None
    assert not hasattr(results[0], "claim_token")


def test_invalid_and_missing_operations_do_not_produce_an_assessment(
    tmp_path: Path,
) -> None:
    store, _, _, _ = prepared(tmp_path)
    with pytest.raises(ValueError, match="canonical UUID"):
        assess(store, "not-an-id")
    with pytest.raises(LookupError, match="not found"):
        assess(store, str(uuid.uuid4()))
