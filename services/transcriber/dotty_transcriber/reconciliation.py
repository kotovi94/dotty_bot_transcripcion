"""Read-only assessment of prepared administrative job operations.

An assessment is a snapshot observation, never permission to delete jobs or
release occupations. No trusted process/CUDA completion evidence is recorded
by the current service, so the only available evidence source fails closed.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

from .storage import JobStore, _job_belongs_to_session, _valid_instance_id


Verdict = Literal["missing_evidence", "contradictory_evidence", "accredited_inactive"]


@dataclass(frozen=True)
class OccupationIdentity:
    instance_id: str
    occupation_id: str
    job_id: str
    claim_token: str


@dataclass(frozen=True)
class ProcessOwnerIdentity:
    """A process identity must survive PID reuse; none is persisted yet."""

    pid: int
    created_at_ns: int
    boot_id: str


@dataclass(frozen=True)
class ProcessEvidenceIdentity:
    """Scope required for future evidence, bound to this observed operation."""

    operation_id: str
    snapshot_hash: str
    lock_epoch_id: str | None
    instance_id: str
    owner: ProcessOwnerIdentity | None
    process_scope: tuple[ProcessOwnerIdentity, ...] | None
    occupations: tuple[OccupationIdentity, ...]


@dataclass(frozen=True)
class ReconciliationAssessment:
    operation_id: str
    session_id: str
    close_id: str
    verdict: Verdict
    eligible: bool
    reasons: tuple[str, ...]
    occupation_ids: tuple[str, ...]
    # This describes the observed database snapshot, not an authorization token.
    snapshot_hash: str


class NoVerifiedInactivityEvidence:
    """Internal fail-closed source until lifecycle attestations exist.

    Its exact type is required by the evaluator. An HTTP body, bool, callable,
    or ad-hoc object cannot claim that a process or CUDA work has ended.
    """

    __slots__ = ()

    def observe(self, _identity: ProcessEvidenceIdentity) -> Literal["missing_evidence"]:
        return "missing_evidence"


# These values identify a job and its inputs. Runtime progress, results and
# claim_token may legitimately change after admission closes.
_FROZEN_JOB_FIELDS = (
    "id", "generation_id", "audio_path", "speaker_user_id", "start_offset_ms",
    "language", "initial_prompt", "hotwords", "created_at", "max_attempts",
    "provenance_protocol_version", "provenance_instance_id",
)


def evaluate_job_deletion_reconciliation(
    store: JobStore,
    operation_id: str,
    evidence_source: NoVerifiedInactivityEvidence,
) -> ReconciliationAssessment:
    """Evaluate one consistent SQLite snapshot without changing persisted state.

    Not-found and malformed operation IDs are caller errors. SQLite failures
    propagate; they must never be converted to an eligible assessment.
    """
    if not isinstance(operation_id, str):
        raise ValueError("Operation ID must be a canonical UUID")
    try:
        if str(uuid.UUID(operation_id)) != operation_id:
            raise ValueError
    except ValueError as error:
        raise ValueError("Operation ID must be a canonical UUID") from error
    if type(evidence_source) is not NoVerifiedInactivityEvidence:
        raise TypeError("A trusted internal evidence source is required")

    # mode=ro prevents accidental database creation or writes, including through
    # connection initialization. The explicit transaction pins all SELECTs to
    # one WAL snapshot while workers may finish concurrently.
    uri = f"{Path(store.path).resolve().as_uri()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=30, isolation_level=None)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        data_version = connection.execute("PRAGMA data_version").fetchone()[0]
        connection.execute("BEGIN")
        operation = connection.execute(
            "SELECT * FROM job_deletion_operation WHERE operation_id=?", (operation_id,),
        ).fetchone()
        if operation is None:
            raise LookupError("Job deletion operation not found")
        session_id = operation["session_id"]
        gate = connection.execute(
            "SELECT * FROM session_admission WHERE session_id=?", (session_id,),
        ).fetchone()
        targets = connection.execute(
            "SELECT * FROM job_deletion_target WHERE operation_id=? ORDER BY job_id",
            (operation_id,),
        ).fetchall()
        jobs = connection.execute(
            """SELECT rowid AS observed_rowid,* FROM transcription_job
            WHERE id COLLATE BINARY=? OR
              (id COLLATE BINARY>=? AND id COLLATE BINARY<?) ORDER BY id""",
            (session_id, f"{session_id}:", f"{session_id};"),
        ).fetchall()
        occupations = connection.execute(
            """SELECT * FROM worker_occupation WHERE session_id=? OR
              job_id COLLATE BINARY=? OR
              (job_id COLLATE BINARY>=? AND job_id COLLATE BINARY<?)
              ORDER BY acquired_at,id""",
            (session_id, session_id, f"{session_id}:", f"{session_id};"),
        ).fetchall()
        generations = connection.execute(
            """SELECT generation_id,session_id,job_id,admitted_at
            FROM job_generation_history WHERE session_id=?""",
            (session_id,),
        ).fetchall()
        assessment = _assess_snapshot(
            operation_id, evidence_source, operation, gate, targets, jobs,
            occupations, generations,
        )
        connection.execute("COMMIT")
        if connection.execute("PRAGMA data_version").fetchone()[0] != data_version:
            return replace(
                assessment, verdict="contradictory_evidence", eligible=False,
                reasons=tuple(sorted(set(assessment.reasons) | {"snapshot_changed_during_evaluation"})),
            )
        return assessment
    except BaseException:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()



def _assess_snapshot(
    operation_id: str, evidence_source: NoVerifiedInactivityEvidence,
    operation: sqlite3.Row, gate: sqlite3.Row | None,
    targets: list[sqlite3.Row], jobs: list[sqlite3.Row],
    occupations: list[sqlite3.Row], generations: list[sqlite3.Row],
) -> ReconciliationAssessment:
    """Check only the pinned database view; the caller also checks concurrent writes."""
    session_id = operation["session_id"]
    reasons: set[str] = set()
    if operation["status"] != "pending_drain":
        reasons.add("operation_not_pending_drain")
    if gate is None or gate["close_operation_id"] != operation["close_id"]:
        reasons.add("close_identity_mismatch")
    if gate is not None and gate["closed_at"] != operation["created_at"]:
        reasons.add("close_identity_mismatch")

    jobs_by_id = {row["id"]: row for row in jobs}
    targets_by_id = {row["job_id"]: row for row in targets}
    history = {(row["generation_id"], row["session_id"], row["job_id"])
               for row in generations}
    if gate is not None and any(
        row["admitted_at"] > gate["closed_at"] for row in generations
    ):
        reasons.add("admission_after_close")
    if set(jobs_by_id) - set(targets_by_id):
        reasons.add("job_after_close")
    if set(targets_by_id) - set(jobs_by_id):
        reasons.add("frozen_target_missing")

    for target in targets:
        job_id = target["job_id"]
        if not _job_belongs_to_session(job_id, session_id):
            reasons.add("target_session_mismatch")
        if target["identity_status"] != "recorded_generation":
            reasons.add("observed_only_target")
        if (target["generation_id"], session_id, job_id) not in history:
            reasons.add("target_generation_unrecorded")
        if hashlib.sha256(target["snapshot_json"].encode("utf-8")).hexdigest() != target["snapshot_hash"]:
            reasons.add("target_snapshot_mismatch")
        frozen_job = None
        try:
            frozen_job = json.loads(target["snapshot_json"])
            if (not isinstance(frozen_job, dict) or frozen_job.get("id") != job_id
                    or frozen_job.get("generation_id") != target["generation_id"]
                    or frozen_job.get("observed_rowid") != target["observed_rowid"]):
                reasons.add("target_snapshot_mismatch")
        except (TypeError, ValueError):
            reasons.add("target_snapshot_mismatch")
        current = jobs_by_id.get(job_id)
        if current is not None and current["generation_id"] != target["generation_id"]:
            reasons.add("generation_substituted")
        if current is not None and isinstance(frozen_job, dict):
            if (current["observed_rowid"] != target["observed_rowid"]
                    or set(frozen_job) != set(current.keys())
                    or any(field not in frozen_job
                           or type(current[field]) is not type(frozen_job[field])
                           or current[field] != frozen_job[field]
                           for field in _FROZEN_JOB_FIELDS)):
                reasons.add("frozen_job_identity_mismatch")

    occupations_by_id = {row["id"]: row for row in occupations}
    if gate is not None:
        try:
            at_close = json.loads(gate["occupations_at_close_json"])
            active_at_close = json.loads(gate["active_at_close_json"])
            if not isinstance(at_close, list):
                raise ValueError
            if not isinstance(active_at_close, list):
                raise ValueError
            frozen_occupation_ids: set[str] = set()
            frozen_claims: set[tuple[str, str]] = set()
            active_claims: set[tuple[str, str]] = set()
            for frozen_job in active_at_close:
                target = targets_by_id.get(frozen_job["id"])
                active_claims.add((frozen_job["id"], frozen_job["claim_token"]))
                if (target is None or target["observed_status"] != "processing"
                        or json.loads(target["snapshot_json"]).get("claim_token")
                        != frozen_job["claim_token"]):
                    reasons.add("active_at_close_mismatch")
            for frozen in at_close:
                frozen_occupation_ids.add(frozen["id"])
                frozen_claims.add((frozen["job_id"], frozen["claim_token"]))
                current = occupations_by_id.get(frozen["id"])
                if current is None or any(current[key] != frozen[key] for key in (
                    "instance_id", "id", "job_id", "claim_token", "session_id", "acquired_at"
                )):
                    reasons.add("occupation_snapshot_mismatch")
                if (frozen["session_id"] != session_id
                        or not all(_valid_instance_id(frozen[key]) for key in (
                            "id", "instance_id", "claim_token"
                        ))):
                    reasons.add("frozen_occupation_identity_mismatch")
            if (len(frozen_occupation_ids) != len(at_close)
                    or len(frozen_claims) != len(at_close)
                    or len(active_claims) != len(active_at_close)
                    or frozen_claims != active_claims):
                reasons.add("frozen_claim_occupation_mismatch")
            if any(row["released_at"] is None and row["id"] not in frozen_occupation_ids
                   for row in occupations):
                reasons.add("occupation_after_close")
        except (AttributeError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            reasons.add("occupation_snapshot_mismatch")

    active_per_job: dict[str, int] = {}
    identities: list[OccupationIdentity] = []
    for row in occupations:
        identity = OccupationIdentity(row["instance_id"], row["id"],
                                      row["job_id"], row["claim_token"])
        identities.append(identity)
        if not all(_valid_instance_id(value) for value in (
            identity.instance_id, identity.occupation_id, identity.claim_token
        )):
            reasons.add("malformed_occupation_identity")
        if (row["session_id"] != session_id
                or not _job_belongs_to_session(identity.job_id, session_id)
                or identity.job_id not in targets_by_id):
            reasons.add("orphan_occupation")
        if row["released_at"] is None:
            active_per_job[identity.job_id] = active_per_job.get(identity.job_id, 0) + 1
            job = jobs_by_id.get(identity.job_id)
            if job is not None and job["status"] == "processing" and job["claim_token"] != identity.claim_token:
                reasons.add("active_claim_mismatch")
    if any(count > 1 for count in active_per_job.values()):
        reasons.add("multiple_active_occupations")
    if gate is not None and any(row["acquired_at"] > gate["closed_at"] for row in occupations):
        reasons.add("occupation_after_close")

    snapshot = {
        "operation": dict(operation),
        "gate": dict(gate) if gate is not None else None,
        "targets": [dict(row) for row in targets],
        "jobs": [dict(row) for row in jobs],
        "occupations": [dict(row) for row in occupations],
        "generations": [dict(row) for row in generations],
    }
    snapshot_hash = hashlib.sha256(json.dumps(
        snapshot, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")).hexdigest()
    # The database has no lock epoch, authenticated owner, or process-tree
    # record. Build the required identity explicitly, but never fill these
    # gaps from a PID, HTTP declaration, released_at, or current lock state.
    for instance_id in sorted({identity.instance_id for identity in identities}):
        evidence_identity = ProcessEvidenceIdentity(
            operation_id=operation_id,
            snapshot_hash=snapshot_hash,
            lock_epoch_id=None,
            instance_id=instance_id,
            owner=None,
            process_scope=None,
            occupations=tuple(identity for identity in identities
                              if identity.instance_id == instance_id),
        )
        if evidence_source.observe(evidence_identity) != "missing_evidence":
            raise TypeError("Unverified process evidence cannot accredit inactivity")
    if reasons:
        verdict: Verdict = "contradictory_evidence"
    else:
        verdict = "missing_evidence"
        reasons.add("verified_inactivity_unavailable")
    return ReconciliationAssessment(
        operation_id=operation_id,
        session_id=session_id,
        close_id=operation["close_id"],
        verdict=verdict,
        # This read-only observation can never authorize a later mutation.
        eligible=False,
        reasons=tuple(sorted(reasons)),
        occupation_ids=tuple(identity.occupation_id for identity in identities),
        snapshot_hash=snapshot_hash,
    )
