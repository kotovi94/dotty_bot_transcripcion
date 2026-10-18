from __future__ import annotations

import json
import hashlib
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from .instance_lock import TranscriberInstanceLock


PROVENANCE_PROTOCOL_VERSION = 1


@dataclass(frozen=True)
class JobInput:
    id: str
    audio_path: str
    speaker_user_id: str
    start_offset_ms: int
    language: str
    initial_prompt: str = ""
    hotwords: str = ""


class JobStore:
    def __init__(self, path: Path, *, instance_lock: TranscriberInstanceLock | None = None) -> None:
        self.path = path
        self._instance_lock = instance_lock
        if instance_lock is not None:
            self._validate_instance_lock()
            self.instance_id = instance_lock.instance_id
        else:
            self.instance_id = uuid.uuid4().hex
        self._local = threading.local()
        self._initialize()

    def _validate_instance_lock(self) -> None:
        if type(self._instance_lock) is not TranscriberInstanceLock or not self._instance_lock.is_held:
            raise RuntimeError("A held transcriber instance lock is required")
        if self._instance_lock.directory != self.path.resolve().parent:
            raise ValueError("Transcriber instance lock does not own the job database directory")

    @contextmanager
    def _enqueue_provenance(self) -> Iterator[tuple[int | None, str | None]]:
        if self._instance_lock is None:
            yield None, None
            return
        if type(self._instance_lock) is not TranscriberInstanceLock:
            raise RuntimeError("A held transcriber instance lock is required")
        if self._instance_lock.directory != self.path.resolve().parent:
            raise ValueError("Transcriber instance lock does not own the job database directory")
        with self._instance_lock.hold_identity() as instance_id:
            yield PROVENANCE_PROTOCOL_VERSION, instance_id

    def _connection(self) -> sqlite3.Connection:
        connection = getattr(self._local, "connection", None)
        if connection is None:
            connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA busy_timeout=30000")
            self._local.connection = connection
        return connection

    def _initialize(self) -> None:
        connection = self._connection()
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS transcription_job (
              id TEXT PRIMARY KEY,
              audio_path TEXT NOT NULL,
              speaker_user_id TEXT NOT NULL,
              start_offset_ms INTEGER NOT NULL,
              language TEXT NOT NULL,
              initial_prompt TEXT NOT NULL DEFAULT '',
              hotwords TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'queued',
              phase TEXT NOT NULL DEFAULT 'queued',
              progress REAL NOT NULL DEFAULT 0,
              processed_audio_seconds REAL NOT NULL DEFAULT 0,
              audio_duration_seconds REAL,
              attempts INTEGER NOT NULL DEFAULT 0,
              max_attempts INTEGER NOT NULL DEFAULT 3,
              claim_token TEXT,
              generation_id TEXT,
              provenance_protocol_version INTEGER,
              provenance_instance_id TEXT,
              result_json TEXT,
              error TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              started_at TEXT,
              completed_at TEXT
            );
            CREATE INDEX IF NOT EXISTS transcription_job_status_created
              ON transcription_job(status, created_at);
            CREATE TABLE IF NOT EXISTS session_admission (
              session_id TEXT PRIMARY KEY,
              closed_at TEXT NOT NULL,
              active_at_close_json TEXT NOT NULL,
              occupations_at_close_json TEXT NOT NULL DEFAULT '[]',
              close_operation_id TEXT
            );
            CREATE TABLE IF NOT EXISTS worker_occupation (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              job_id TEXT NOT NULL,
              claim_token TEXT NOT NULL,
              instance_id TEXT NOT NULL,
              acquired_at TEXT NOT NULL,
              released_at TEXT
            );
            CREATE INDEX IF NOT EXISTS worker_occupation_session_active
              ON worker_occupation(session_id, released_at);
            CREATE TABLE IF NOT EXISTS job_history_scope (
              id INTEGER PRIMARY KEY CHECK (id=1),
              prior_history_status TEXT NOT NULL CHECK (prior_history_status='unknown'),
              established_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS job_generation_history (
              generation_id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              job_id TEXT NOT NULL,
              admission_provenance TEXT NOT NULL CHECK (admission_provenance IN ('protected','unknown')),
              protocol_version INTEGER,
              instance_id TEXT,
              audio_origin_status TEXT NOT NULL CHECK (audio_origin_status='unknown'),
              admitted_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS job_generation_history_session
              ON job_generation_history(session_id, admitted_at, generation_id);
            CREATE TABLE IF NOT EXISTS job_admission_event (
              event_id TEXT PRIMARY KEY,
              generation_id TEXT NOT NULL UNIQUE REFERENCES job_generation_history(generation_id),
              event_type TEXT NOT NULL CHECK (event_type='created'),
              evidence_kind TEXT NOT NULL CHECK (evidence_kind='transaction_observed'),
              occurred_at TEXT NOT NULL
            );
            CREATE TRIGGER IF NOT EXISTS job_generation_history_no_update
              BEFORE UPDATE ON job_generation_history BEGIN
                SELECT RAISE(ABORT, 'job generation history is append-only');
              END;
            CREATE TRIGGER IF NOT EXISTS job_generation_history_no_delete
              BEFORE DELETE ON job_generation_history BEGIN
                SELECT RAISE(ABORT, 'job generation history is append-only');
              END;
            CREATE TRIGGER IF NOT EXISTS job_admission_event_no_update
              BEFORE UPDATE ON job_admission_event BEGIN
                SELECT RAISE(ABORT, 'job admission events are append-only');
              END;
            CREATE TRIGGER IF NOT EXISTS job_admission_event_no_delete
              BEFORE DELETE ON job_admission_event BEGIN
                SELECT RAISE(ABORT, 'job admission events are append-only');
              END;
            CREATE TABLE IF NOT EXISTS job_deletion_operation (
              operation_id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              operation_type TEXT NOT NULL,
              parameters_hash TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN
                ('pending_drain','ready_to_delete','completed','failed','uncertain')),
              close_id TEXT NOT NULL UNIQUE,
              created_at TEXT NOT NULL,
              result_json TEXT,
              uncertainty_reason TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS job_deletion_one_active_session
              ON job_deletion_operation(session_id)
              WHERE status IN ('pending_drain','ready_to_delete','uncertain');
            CREATE TABLE IF NOT EXISTS job_deletion_target (
              operation_id TEXT NOT NULL REFERENCES job_deletion_operation(operation_id),
              job_id TEXT NOT NULL,
              generation_id TEXT,
              observation_id TEXT NOT NULL UNIQUE,
              observed_rowid INTEGER NOT NULL,
              observed_status TEXT NOT NULL,
              observed_provenance TEXT NOT NULL,
              identity_status TEXT NOT NULL CHECK (identity_status IN ('recorded_generation','observed_only')),
              snapshot_hash TEXT NOT NULL,
              snapshot_json TEXT NOT NULL,
              PRIMARY KEY(operation_id,job_id)
            );
            CREATE TRIGGER IF NOT EXISTS job_deletion_target_no_update
              BEFORE UPDATE ON job_deletion_target BEGIN
                SELECT RAISE(ABORT, 'deletion targets are immutable');
              END;
            CREATE TRIGGER IF NOT EXISTS job_deletion_target_no_delete
              BEFORE DELETE ON job_deletion_target BEGIN
                SELECT RAISE(ABORT, 'deletion targets are immutable');
              END;
            """
        )
        # No existing database, including an empty one, proves the absence of
        # pre-protocol jobs or readers. Never upgrade this baseline on startup.
        connection.execute(
            "INSERT OR IGNORE INTO job_history_scope VALUES (1,'unknown',?)", (_now(),)
        )
        admission_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(session_admission)").fetchall()
        }
        if "occupations_at_close_json" not in admission_columns:
            connection.execute(
                "ALTER TABLE session_admission ADD COLUMN occupations_at_close_json "
                "TEXT NOT NULL DEFAULT '[]'"
            )
        if "close_operation_id" not in admission_columns:
            connection.execute(
                "ALTER TABLE session_admission ADD COLUMN close_operation_id TEXT"
            )
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS session_admission_close_operation "
            "ON session_admission(close_operation_id) WHERE close_operation_id IS NOT NULL"
        )
        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(transcription_job)").fetchall()
        }
        if "initial_prompt" not in columns:
            connection.execute(
                "ALTER TABLE transcription_job ADD COLUMN initial_prompt TEXT NOT NULL DEFAULT ''"
            )
        if "hotwords" not in columns:
            connection.execute(
                "ALTER TABLE transcription_job ADD COLUMN hotwords TEXT NOT NULL DEFAULT ''"
            )
        if "phase" not in columns:
            connection.execute(
                "ALTER TABLE transcription_job ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued'"
            )
        if "progress" not in columns:
            connection.execute(
                "ALTER TABLE transcription_job ADD COLUMN progress REAL NOT NULL DEFAULT 0"
            )
        if "processed_audio_seconds" not in columns:
            connection.execute(
                "ALTER TABLE transcription_job ADD COLUMN processed_audio_seconds REAL NOT NULL DEFAULT 0"
            )
        if "audio_duration_seconds" not in columns:
            connection.execute(
                "ALTER TABLE transcription_job ADD COLUMN audio_duration_seconds REAL"
            )
        if "claim_token" not in columns:
            connection.execute(
                "ALTER TABLE transcription_job ADD COLUMN claim_token TEXT"
            )
        if "generation_id" not in columns:
            connection.execute(
                "ALTER TABLE transcription_job ADD COLUMN generation_id TEXT"
            )
        if "provenance_protocol_version" not in columns:
            connection.execute(
                "ALTER TABLE transcription_job ADD COLUMN provenance_protocol_version INTEGER"
            )
        if "provenance_instance_id" not in columns:
            connection.execute(
                "ALTER TABLE transcription_job ADD COLUMN provenance_instance_id TEXT"
            )
        # Exhausted jobs must be visible/retryable, including queues written by
        # older versions that left an exhausted job in queued after a crash.
        connection.execute(
            "UPDATE transcription_job SET status='failed', phase='failed', claim_token=NULL, "
            "error='Interrupted after maximum attempts; manual retry required', updated_at=? "
            "WHERE status IN ('processing','queued') AND attempts >= max_attempts "
            "AND NOT EXISTS (SELECT 1 FROM session_admission AS gate "
            "WHERE gate.session_id=CASE WHEN instr(transcription_job.id, ':')=0 "
            "THEN transcription_job.id ELSE substr(transcription_job.id,1,instr(transcription_job.id,':')-1) END)",
            (_now(),),
        )
        connection.execute(
            "UPDATE transcription_job SET status='queued', phase='queued', progress=0, "
            "processed_audio_seconds=0, claim_token=NULL, updated_at=? WHERE status='processing' "
            "AND NOT EXISTS (SELECT 1 FROM session_admission AS gate "
            "WHERE gate.session_id=CASE WHEN instr(transcription_job.id, ':')=0 "
            "THEN transcription_job.id ELSE substr(transcription_job.id,1,instr(transcription_job.id,':')-1) END)",
            (_now(),),
        )

    def enqueue(self, job: JobInput) -> dict[str, Any]:
        session_id = _session_id(job.id)
        now = _now()
        connection = self._connection()
        with self._enqueue_provenance() as (protocol_version, provenance_instance_id):
            connection.execute("BEGIN IMMEDIATE")
            try:
                self._assert_open(connection, session_id)
                generation_id = uuid.uuid4().hex
                inserted = connection.execute(
                    """INSERT OR IGNORE INTO transcription_job
                    (id,audio_path,speaker_user_id,start_offset_ms,language,initial_prompt,hotwords,status,
                     generation_id,provenance_protocol_version,provenance_instance_id,created_at,updated_at)
                    VALUES (:id,:audio_path,:speaker_user_id,:start_offset_ms,:language,:initial_prompt,:hotwords,
                     'queued',:generation_id,:protocol_version,:instance_id,:now,:now)""",
                    {**asdict(job), "protocol_version": protocol_version,
                     "instance_id": provenance_instance_id, "generation_id": generation_id, "now": now},
                )
                if inserted.rowcount == 1:
                    self._record_admission(
                        connection, generation_id, session_id, job.id,
                        protocol_version, provenance_instance_id, now,
                    )
                row = connection.execute("SELECT * FROM transcription_job WHERE id=?", (job.id,)).fetchone()
                assert row is not None
                existing = _serialize(row)
                for key, value in asdict(job).items():
                    if existing[key] != value:
                        raise ValueError(f"Job id already exists with different {key}.")
                connection.execute("COMMIT")
                return existing
            except BaseException:
                connection.execute("ROLLBACK")
                raise

    @staticmethod
    def _record_admission(
        connection: sqlite3.Connection, generation_id: str, session_id: str,
        job_id: str, protocol_version: int | None, instance_id: str | None, now: str,
    ) -> None:
        connection.execute(
            """INSERT INTO job_generation_history
            (generation_id,session_id,job_id,admission_provenance,protocol_version,
             instance_id,audio_origin_status,admitted_at)
            VALUES (?,?,?,?,?,?,'unknown',?)""",
            (generation_id, session_id, job_id,
             "protected" if protocol_version is not None else "unknown",
             protocol_version, instance_id, now),
        )
        connection.execute(
            """INSERT INTO job_admission_event
            (event_id,generation_id,event_type,evidence_kind,occurred_at)
            VALUES (?,?,'created','transaction_observed',?)""",
            (uuid.uuid4().hex, generation_id, now),
        )

    def close_admission(self, session_id: str) -> dict[str, Any]:
        """Persist the admission barrier, without claiming that active workers stopped."""
        _validate_session_id(session_id)
        connection = self._connection()
        connection.execute("BEGIN IMMEDIATE")
        try:
            active = connection.execute(
                """SELECT id,claim_token FROM transcription_job
                WHERE status='processing' AND (id=? OR substr(id,1,instr(id,':')-1)=?)
                ORDER BY id""", (session_id, session_id),
            ).fetchall()
            occupations = connection.execute(
                """SELECT id,session_id,job_id,claim_token,instance_id,acquired_at
                FROM worker_occupation WHERE session_id=? AND released_at IS NULL ORDER BY acquired_at,id""",
                (session_id,),
            ).fetchall()
            connection.execute(
                """INSERT OR IGNORE INTO session_admission
                (session_id,closed_at,active_at_close_json,occupations_at_close_json)
                VALUES (?,?,?,?)""",
                (session_id, _now(), json.dumps([dict(row) for row in active]),
                 json.dumps([dict(row) for row in occupations])),
            )
            state = self._admission_state(connection, session_id)
            connection.execute("COMMIT")
            return state
        except BaseException:
            connection.execute("ROLLBACK")
            raise

    def admission_state(self, session_id: str) -> dict[str, Any]:
        _validate_session_id(session_id)
        connection = self._connection()
        connection.execute("BEGIN")
        try:
            state = self._admission_state(connection, session_id)
            connection.execute("COMMIT")
            return state
        except BaseException:
            connection.execute("ROLLBACK")
            raise

    def prepare_job_deletion(
        self, operation_id: str, session_id: str, operation_type: str,
        parameters: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Freeze targets and close admission; never delete a job or infer worker liveness."""
        _validate_session_id(session_id)
        if not isinstance(operation_id, str) or str(uuid.UUID(operation_id)) != operation_id:
            raise ValueError("Operation ID must be a canonical UUID")
        if operation_type not in {"reprocess", "administrative_delete", "manual_recovery"}:
            raise ValueError("Unsupported deletion operation type")
        if parameters is not None and not isinstance(parameters, dict):
            raise ValueError("Operation parameters must be an object")
        canonical = json.dumps(
            {"session_id": session_id, "operation_type": operation_type,
             "parameters": parameters or {}},
            sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False,
        )
        parameters_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        connection = self._connection()
        connection.execute("BEGIN IMMEDIATE")
        try:
            existing = connection.execute(
                "SELECT * FROM job_deletion_operation WHERE operation_id=?", (operation_id,),
            ).fetchone()
            if existing is not None:
                if (existing["session_id"] != session_id or
                    existing["operation_type"] != operation_type or
                    existing["parameters_hash"] != parameters_hash):
                    raise ValueError("Operation ID conflicts with persisted parameters")
                result = self._job_deletion_operation(connection, operation_id)
                connection.execute("COMMIT")
                assert result is not None
                return result

            gate = connection.execute(
                "SELECT close_operation_id FROM session_admission WHERE session_id=?", (session_id,),
            ).fetchone()
            if gate is not None:
                raise ValueError("Session admission was already closed; reconciliation required")
            if connection.execute(
                "SELECT 1 FROM job_deletion_operation WHERE session_id=? AND status='pending_drain'",
                (session_id,),
            ).fetchone() is not None:
                raise ValueError("Another deletion operation controls this session")

            now = _now()
            close_id = uuid.uuid4().hex
            active = connection.execute(
                """SELECT id,claim_token FROM transcription_job WHERE status='processing'
                AND (id=? OR substr(id,1,instr(id,':')-1)=?) ORDER BY id""",
                (session_id, session_id),
            ).fetchall()
            occupations = connection.execute(
                """SELECT id,session_id,job_id,claim_token,instance_id,acquired_at
                FROM worker_occupation WHERE session_id=? AND released_at IS NULL ORDER BY acquired_at,id""",
                (session_id,),
            ).fetchall()
            connection.execute(
                """INSERT INTO session_admission
                (session_id,closed_at,active_at_close_json,occupations_at_close_json,close_operation_id)
                VALUES (?,?,?,?,?)""",
                (session_id, now, json.dumps([dict(row) for row in active]),
                 json.dumps([dict(row) for row in occupations]), close_id),
            )
            connection.execute(
                """INSERT INTO job_deletion_operation
                (operation_id,session_id,operation_type,parameters_hash,status,close_id,created_at)
                VALUES (?,?,?,?,'pending_drain',?,?)""",
                (operation_id, session_id, operation_type, parameters_hash, close_id, now),
            )
            rows = connection.execute(
                """SELECT rowid AS observed_rowid,* FROM transcription_job
                WHERE id COLLATE BINARY=? OR
                  (id COLLATE BINARY>=? AND id COLLATE BINARY<?)
                ORDER BY id""",
                (session_id, f"{session_id}:", f"{session_id};"),
            ).fetchall()
            for row in rows:
                self._record_deletion_target(connection, operation_id, session_id, row)
            result = self._job_deletion_operation(connection, operation_id)
            connection.execute("COMMIT")
            assert result is not None
            return result
        except BaseException:
            connection.execute("ROLLBACK")
            raise

    @staticmethod
    def _record_deletion_target(
        connection: sqlite3.Connection, operation_id: str, session_id: str, row: sqlite3.Row,
    ) -> None:
        snapshot = dict(row)
        snapshot_json = json.dumps(snapshot, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        generation_id = row["generation_id"]
        # A legacy rowid and hash only document this observation. They cannot
        # authenticate a later row after deletion/reuse; later stages must fail
        # closed on observed_only targets unless identity is reconciled.
        recorded = connection.execute(
            """SELECT 1 FROM job_generation_history
            WHERE generation_id=? AND session_id=? AND job_id=?""",
            (generation_id, session_id, row["id"]),
        ).fetchone() is not None if generation_id is not None else False
        connection.execute(
            """INSERT INTO job_deletion_target
            (operation_id,job_id,generation_id,observation_id,observed_rowid,
             observed_status,observed_provenance,identity_status,snapshot_hash,snapshot_json)
            VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (operation_id, row["id"], generation_id, uuid.uuid4().hex,
             row["observed_rowid"], row["status"], _job_provenance_status(row),
             "recorded_generation" if recorded else "observed_only",
             hashlib.sha256(snapshot_json.encode("utf-8")).hexdigest(), snapshot_json),
        )

    def job_deletion_operation(self, operation_id: str) -> dict[str, Any] | None:
        connection = self._connection()
        connection.execute("BEGIN")
        try:
            result = self._job_deletion_operation(connection, operation_id)
            connection.execute("COMMIT")
            return result
        except BaseException:
            connection.execute("ROLLBACK")
            raise

    @staticmethod
    def _job_deletion_operation(
        connection: sqlite3.Connection, operation_id: str,
    ) -> dict[str, Any] | None:
        operation = connection.execute(
            "SELECT * FROM job_deletion_operation WHERE operation_id=?", (operation_id,),
        ).fetchone()
        if operation is None:
            return None
        targets = connection.execute(
            """SELECT job_id,generation_id,observation_id,observed_rowid,
            observed_status,observed_provenance,identity_status,snapshot_hash,snapshot_json
            FROM job_deletion_target WHERE operation_id=? ORDER BY job_id""",
            (operation_id,),
        ).fetchall()
        return {
            **dict(operation),
            "targets": [{**dict(row), "snapshot": json.loads(row["snapshot_json"])} for row in targets],
        }

    @staticmethod
    def _assert_open(connection: sqlite3.Connection, session_id: str) -> None:
        if connection.execute(
            "SELECT 1 FROM session_admission WHERE session_id=?", (session_id,)
        ).fetchone() is not None:
            raise ValueError(f"Session admission is closed: {session_id}")

    @staticmethod
    def _admission_state(connection: sqlite3.Connection, session_id: str) -> dict[str, Any]:
        gate = connection.execute(
            """SELECT closed_at,active_at_close_json,occupations_at_close_json
            FROM session_admission WHERE session_id=?""",
            (session_id,),
        ).fetchone()
        occupations = connection.execute(
            """SELECT id,session_id,job_id,claim_token,instance_id,acquired_at
            FROM worker_occupation WHERE session_id=? AND released_at IS NULL ORDER BY acquired_at,id""",
            (session_id,),
        ).fetchall()
        counts = {"queued": 0, "processing": 0}
        counts.update({row["status"]: row["count"] for row in connection.execute(
            """SELECT status,COUNT(*) AS count FROM transcription_job
            WHERE (id=? OR substr(id,1,instr(id,':')-1)=?) AND status IN ('queued','processing')
            GROUP BY status""", (session_id, session_id),
        ).fetchall()})
        return {
            "session_id": session_id,
            "closed": gate is not None,
            "closed_at": gate["closed_at"] if gate is not None else None,
            "pending_jobs": counts["queued"],
            "active_jobs": counts["processing"],
            "active_at_close": json.loads(gate["active_at_close_json"]) if gate is not None else [],
            "active_occupations": [dict(row) for row in occupations],
            "occupations_at_close": json.loads(gate["occupations_at_close_json"]) if gate is not None else [],
            "workers_inactive": None,  # A database row is not a worker-liveness proof.
        }

    def claim_next(self) -> dict[str, Any] | None:
        connection = self._connection()
        connection.execute("BEGIN IMMEDIATE")
        try:
            row = connection.execute(
                """SELECT * FROM transcription_job
                WHERE status='queued' AND attempts < max_attempts
                AND NOT EXISTS (SELECT 1 FROM session_admission AS gate
                  WHERE gate.session_id=CASE WHEN instr(transcription_job.id, ':')=0
                  THEN transcription_job.id ELSE substr(transcription_job.id,1,instr(transcription_job.id,':')-1) END)
                AND NOT EXISTS (SELECT 1 FROM worker_occupation AS occupation
                  WHERE occupation.job_id=transcription_job.id AND occupation.released_at IS NULL)
                ORDER BY created_at LIMIT 1""",
            ).fetchone()
            if row is None:
                connection.execute("COMMIT")
                return None
            now = _now()
            claim_token = uuid.uuid4().hex
            occupation_id = uuid.uuid4().hex
            connection.execute(
                """UPDATE transcription_job SET status='processing', phase='loading', progress=0,
                processed_audio_seconds=0, audio_duration_seconds=NULL, attempts=attempts+1,
                claim_token=?, started_at=?, updated_at=?, error=NULL WHERE id=?""",
                (claim_token, now, now, row["id"]),
            )
            self._record_occupation(
                connection, occupation_id, _session_id(row["id"]),
                row["id"], claim_token, now,
            )
            claimed = connection.execute(
                "SELECT * FROM transcription_job WHERE id=?", (row["id"],)
            ).fetchone()
            if claimed is None:
                raise RuntimeError("Claimed job disappeared before commit")
            result = _serialize(claimed, include_claim_token=True)
            result["occupation_id"] = occupation_id
            result["instance_id"] = self.instance_id
            connection.execute("COMMIT")
            return result
        except BaseException:
            connection.execute("ROLLBACK")
            raise

    def _record_occupation(
        self, connection: sqlite3.Connection, occupation_id: str,
        session_id: str, job_id: str, claim_token: str, acquired_at: str,
    ) -> None:
        connection.execute(
            """INSERT INTO worker_occupation
            (id,session_id,job_id,claim_token,instance_id,acquired_at)
            VALUES (?,?,?,?,?,?)""",
            (occupation_id, session_id, job_id, claim_token, self.instance_id, acquired_at),
        )

    def release_occupation(self, occupation_id: str, job_id: str, claim_token: str) -> bool:
        """Explicit owner-verified release; job status and row existence are irrelevant."""
        connection = self._connection()
        connection.execute("BEGIN IMMEDIATE")
        try:
            updated = connection.execute(
                """UPDATE worker_occupation SET released_at=?
                WHERE id=? AND job_id=? AND claim_token=? AND instance_id=?
                AND released_at IS NULL""",
                (_now(), occupation_id, job_id, claim_token, self.instance_id),
            )
            connection.execute("COMMIT")
            return updated.rowcount == 1
        except BaseException:
            connection.execute("ROLLBACK")
            raise

    def occupations_for_session(self, session_id: str) -> list[dict[str, Any]]:
        """Retain released history and flag older instances for reconciliation."""
        _validate_session_id(session_id)
        rows = self._connection().execute(
            """SELECT * FROM worker_occupation WHERE session_id=? ORDER BY acquired_at,id""",
            (session_id,),
        ).fetchall()
        return [
            {**dict(row), "pending_reconciliation":
             row["released_at"] is None and row["instance_id"] != self.instance_id}
            for row in rows
        ]

    def inventory_for_session(self, session_id: str) -> dict[str, Any]:
        _validate_session_id(session_id)
        lower_job_id = f"{session_id}:"
        upper_job_id = f"{session_id};"
        connection = self._connection()
        current_instance_id = None
        if (
            type(self._instance_lock) is TranscriberInstanceLock
            and self._instance_lock.is_held
            and self._instance_lock.directory == self.path.resolve().parent
        ):
            current_instance_id = self._instance_lock.instance_id

        connection.execute("BEGIN")
        try:
            job_rows = connection.execute(
                """SELECT id,status,claim_token,created_at,updated_at,
                provenance_protocol_version,provenance_instance_id
                FROM transcription_job
                WHERE id COLLATE BINARY=? OR
                  (id COLLATE BINARY>=? AND id COLLATE BINARY<?)
                ORDER BY created_at,id""",
                (session_id, lower_job_id, upper_job_id),
            ).fetchall()
            occupation_rows = connection.execute(
                """SELECT id,session_id,job_id,claim_token,instance_id,acquired_at,released_at
                FROM worker_occupation WHERE session_id=? ORDER BY acquired_at,id""",
                (session_id,),
            ).fetchall()
            connection.execute("COMMIT")
        except BaseException:
            connection.execute("ROLLBACK")
            raise

        jobs_by_id = {row["id"]: row for row in job_rows}
        jobs: list[dict[str, Any]] = []
        counts = {
            "jobs_total": len(job_rows),
            "jobs_protected": 0,
            "jobs_unknown": 0,
            "jobs_malformed_or_unrecognized": 0,
            "occupations_total": len(occupation_rows),
            "occupations_active": 0,
            "occupations_unreconciled": 0,
            "occupations_malformed": 0,
        }
        instance_ids: set[str] = set()
        uncertainty_reasons: set[str] = set()

        for row in job_rows:
            provenance_status = _job_provenance_status(row)
            if provenance_status == "protected":
                counts["jobs_protected"] += 1
                instance_ids.add(row["provenance_instance_id"])
            elif provenance_status == "unknown":
                counts["jobs_unknown"] += 1
            else:
                counts["jobs_malformed_or_unrecognized"] += 1
                uncertainty_reasons.add(
                    "unrecognized_job_protocol"
                    if provenance_status == "unrecognized_version"
                    else "malformed_job_provenance"
                )
            jobs.append({
                "id": row["id"],
                "status": row["status"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "provenance_protocol_version": row["provenance_protocol_version"],
                "provenance_instance_id": row["provenance_instance_id"],
                "provenance_status": provenance_status,
            })

        occupations: list[dict[str, Any]] = []
        for row in occupation_rows:
            active = row["released_at"] is None
            unreconciled = active and (
                current_instance_id is None or row["instance_id"] != current_instance_id
            )
            if active:
                counts["occupations_active"] += 1
            if unreconciled:
                counts["occupations_unreconciled"] += 1
                uncertainty_reasons.add("unreconciled_occupation")

            job_id = row["job_id"]
            belongs_to_session = _job_belongs_to_session(job_id, session_id)
            association_valid = (
                row["session_id"] == session_id
                and belongs_to_session
                and job_id in jobs_by_id
            )
            if not association_valid:
                uncertainty_reasons.add(
                    "occupation_session_mismatch" if not belongs_to_session or row["session_id"] != session_id
                    else "occupation_without_job"
                )
            elif active and row["claim_token"] != jobs_by_id[job_id]["claim_token"]:
                uncertainty_reasons.add("active_occupation_claim_mismatch")

            malformed = (
                not _valid_instance_id(row["id"])
                or not _valid_instance_id(row["instance_id"])
                or not _valid_instance_id(row["claim_token"])
                or not isinstance(row["acquired_at"], str)
                or not row["acquired_at"]
                or (row["released_at"] is not None and not isinstance(row["released_at"], str))
            )
            if malformed:
                counts["occupations_malformed"] += 1
                uncertainty_reasons.add("malformed_occupation")
            if _valid_instance_id(row["instance_id"]):
                instance_ids.add(row["instance_id"])

            occupations.append({
                "id": row["id"],
                "session_id": row["session_id"],
                "job_id": job_id,
                "instance_id": row["instance_id"],
                "acquired_at": row["acquired_at"],
                "released_at": row["released_at"],
                "active": active,
                "unreconciled": unreconciled,
                "association_valid": association_valid,
            })

        if counts["occupations_active"] and current_instance_id is None:
            uncertainty_reasons.add("current_instance_unverified")

        if uncertainty_reasons:
            classification = "uncertain"
        elif not job_rows and not occupation_rows:
            classification = "empty"
        elif counts["jobs_protected"] == counts["jobs_total"]:
            classification = "protected-only"
        elif counts["jobs_unknown"] == counts["jobs_total"]:
            classification = "unknown-only"
        elif counts["jobs_protected"] and counts["jobs_unknown"]:
            classification = "mixed"
        else:
            classification = "uncertain"

        return {
            "session_id": session_id,
            "classification": classification,
            "counts": counts,
            "current_instance_id": current_instance_id,
            "instance_ids": sorted(instance_ids),
            "jobs": jobs,
            "occupations": occupations,
            "uncertainty_reasons": sorted(uncertainty_reasons),
        }

    def complete(self, job_id: str, claim_token: str, result: dict[str, Any]) -> bool:
        now = _now()
        updated = self._connection().execute(
            """UPDATE transcription_job SET status='completed', phase='completed', progress=1,
            processed_audio_seconds=COALESCE(audio_duration_seconds, processed_audio_seconds), result_json=?,
            completed_at=?, updated_at=? WHERE id=? AND status='processing' AND claim_token=?""",
            (json.dumps(result, ensure_ascii=False), now, now, job_id, claim_token),
        )
        return updated.rowcount == 1

    def fail(self, job_id: str, claim_token: str, error: str) -> bool:
        connection = self._connection()
        row = connection.execute(
            """SELECT attempts,max_attempts FROM transcription_job
            WHERE id=? AND status='processing' AND claim_token=?""",
            (job_id, claim_token),
        ).fetchone()
        if row is None:
            return False
        status = "failed" if row["attempts"] >= row["max_attempts"] else "queued"
        updated = connection.execute(
            """UPDATE transcription_job SET status=?, phase=?, claim_token=NULL, error=?, updated_at=?
            WHERE id=? AND status='processing' AND claim_token=?""",
            (status, status, error[:2000], _now(), job_id, claim_token),
        )
        return updated.rowcount == 1

    def update_progress(
        self,
        job_id: str,
        claim_token: str,
        progress: float,
        processed_audio_seconds: float,
        audio_duration_seconds: float,
        phase: str = "transcribing",
    ) -> None:
        self._connection().execute(
            """UPDATE transcription_job SET phase=?, progress=?, processed_audio_seconds=?,
            audio_duration_seconds=?, updated_at=?
            WHERE id=? AND status='processing' AND claim_token=?""",
            (
                phase,
                max(0.0, min(0.99, progress)),
                max(0.0, processed_audio_seconds),
                max(0.0, audio_duration_seconds),
                _now(),
                job_id,
                claim_token,
            ),
        )

    def get(self, job_id: str) -> dict[str, Any] | None:
        row = self._connection().execute(
            "SELECT * FROM transcription_job WHERE id=?", (job_id,)
        ).fetchone()
        return _serialize(row) if row is not None else None

    def retry(self, job_id: str) -> dict[str, Any] | None:
        session_id = _session_id(job_id)
        now = _now()
        connection = self._connection()
        connection.execute("BEGIN IMMEDIATE")
        try:
            self._assert_open(connection, session_id)
            connection.execute(
                """UPDATE transcription_job SET status='queued', phase='queued', progress=0,
                processed_audio_seconds=0, audio_duration_seconds=NULL, attempts=0, error=NULL,
                claim_token=NULL, started_at=NULL, completed_at=NULL, updated_at=?
                WHERE id=? AND status='failed'""", (now, job_id),
            )
            row = connection.execute("SELECT * FROM transcription_job WHERE id=?", (job_id,)).fetchone()
            connection.execute("COMMIT")
            return _serialize(row) if row is not None else None
        except BaseException:
            connection.execute("ROLLBACK")
            raise

    def metrics(self) -> dict[str, int]:
        rows = self._connection().execute(
            "SELECT status,COUNT(*) AS count FROM transcription_job GROUP BY status"
        ).fetchall()
        result = {"queued": 0, "processing": 0, "completed": 0, "failed": 0}
        result.update({row["status"]: row["count"] for row in rows})
        return result

    def current_work(self) -> dict[str, Any] | None:
        row = self._connection().execute(
            """SELECT id,status,phase,progress,processed_audio_seconds,
            audio_duration_seconds,started_at,updated_at FROM transcription_job
            WHERE status IN ('processing','queued')
            ORDER BY CASE status WHEN 'processing' THEN 0 ELSE 1 END, created_at LIMIT 1"""
        ).fetchone()
        if row is None:
            return None
        value = dict(row)
        session_id = str(value["id"]).split(":", 1)[0]
        escaped = session_id.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        counts = {"queued": 0, "processing": 0, "completed": 0, "failed": 0}
        counts.update({
            item["status"]: item["count"]
            for item in self._connection().execute(
                """SELECT status,COUNT(*) AS count FROM transcription_job
                WHERE id LIKE ? ESCAPE '\\' GROUP BY status""",
                (f"{escaped}:%",),
            ).fetchall()
        })
        total = sum(counts.values())
        partial = float(value.get("progress") or 0) if value["status"] == "processing" else 0.0
        value["session_id"] = session_id
        value["session_total_jobs"] = total
        value["session_completed_jobs"] = counts["completed"]
        value["session_failed_jobs"] = counts["failed"]
        value["session_progress"] = min(1.0, (counts["completed"] + partial) / max(1, total))
        queued = self._connection().execute(
            "SELECT COUNT(*) FROM transcription_job WHERE status='queued'"
        ).fetchone()[0]
        value["queued_after"] = max(0, queued - (1 if value["status"] == "queued" else 0))
        return value

    def retry_failed_for_session(self, session_id: str) -> int:
        _validate_session_id(session_id)
        escaped = session_id.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        connection = self._connection()
        connection.execute("BEGIN IMMEDIATE")
        try:
            self._assert_open(connection, session_id)
            result = connection.execute(
                """UPDATE transcription_job SET status='queued', phase='queued', progress=0,
                processed_audio_seconds=0, audio_duration_seconds=NULL, attempts=0, error=NULL,
                claim_token=NULL, started_at=NULL, completed_at=NULL, updated_at=?
                WHERE id LIKE ? ESCAPE '\\' AND status='failed'""",
                (_now(), f"{escaped}:%"),
            )
            connection.execute("COMMIT")
            return result.rowcount
        except BaseException:
            connection.execute("ROLLBACK")
            raise

    def failed_sessions(self) -> list[dict[str, Any]]:
        rows = self._connection().execute(
            """SELECT substr(id,1,instr(id,':')-1) AS session_id,
            COUNT(*) AS failed_jobs, MAX(updated_at) AS updated_at, MAX(error) AS last_error
            FROM transcription_job WHERE status='failed'
            GROUP BY substr(id,1,instr(id,':')-1) ORDER BY updated_at DESC"""
        ).fetchall()
        return [dict(row) for row in rows]

    def list_for_session(self, session_id: str) -> list[dict[str, Any]]:
        escaped = session_id.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = self._connection().execute(
            """SELECT * FROM transcription_job WHERE id LIKE ? ESCAPE '\\'
            ORDER BY start_offset_ms, created_at""",
            (f"{escaped}:%",),
        ).fetchall()
        return [_serialize(row) for row in rows]

    def delete_for_session(self, session_id: str) -> int:
        escaped = session_id.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        result = self._connection().execute(
            "DELETE FROM transcription_job WHERE id LIKE ? ESCAPE '\\'",
            (f"{escaped}:%",),
        )
        return result.rowcount


def _serialize(row: sqlite3.Row, include_claim_token: bool = False) -> dict[str, Any]:
    value = dict(row)
    if not include_claim_token:
        value.pop("claim_token", None)
    value["provenance_status"] = (
        "protected"
        if value.get("provenance_protocol_version") == PROVENANCE_PROTOCOL_VERSION
        and value.get("provenance_instance_id")
        else "unknown"
    )
    value["result"] = json.loads(value.pop("result_json")) if value["result_json"] else None
    return value


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _validate_session_id(session_id: str) -> None:
    if not isinstance(session_id, str) or not session_id or ":" in session_id:
        raise ValueError("Session ID must be a nonempty job ID prefix without a colon")


def _session_id(job_id: str) -> str:
    if not isinstance(job_id, str):
        raise ValueError("Job ID must be a string")
    session_id = job_id.split(":", 1)[0]
    _validate_session_id(session_id)
    return session_id


def _job_belongs_to_session(job_id: Any, session_id: str) -> bool:
    if not isinstance(job_id, str):
        return False
    return job_id == session_id or job_id.partition(":")[0] == session_id and ":" in job_id


def _valid_instance_id(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{32}", value) is not None


def _job_provenance_status(row: sqlite3.Row) -> str:
    version = row["provenance_protocol_version"]
    instance_id = row["provenance_instance_id"]
    if version is None and instance_id is None:
        return "unknown"
    if type(version) is int and version != PROVENANCE_PROTOCOL_VERSION:
        return "unrecognized_version" if _valid_instance_id(instance_id) else "malformed"
    if type(version) is int and version == PROVENANCE_PROTOCOL_VERSION and _valid_instance_id(instance_id):
        return "protected"
    return "malformed"
