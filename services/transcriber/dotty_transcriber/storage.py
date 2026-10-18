from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


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
    def __init__(self, path: Path) -> None:
        self.path = path
        # One identity per store lifetime. A restarted process never inherits
        # ownership of occupations left by an earlier instance.
        self.instance_id = uuid.uuid4().hex
        self._local = threading.local()
        self._initialize()

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
              occupations_at_close_json TEXT NOT NULL DEFAULT '[]'
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
            """
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
        connection.execute("BEGIN IMMEDIATE")
        try:
            self._assert_open(connection, session_id)
            connection.execute(
                """INSERT OR IGNORE INTO transcription_job
                (id,audio_path,speaker_user_id,start_offset_ms,language,initial_prompt,hotwords,status,created_at,updated_at)
                VALUES (:id,:audio_path,:speaker_user_id,:start_offset_ms,:language,:initial_prompt,:hotwords,'queued',:now,:now)""",
                {**asdict(job), "now": now},
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
