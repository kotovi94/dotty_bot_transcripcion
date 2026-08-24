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
            """
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
        connection.execute(
            "UPDATE transcription_job SET status='queued', phase='queued', progress=0, "
            "processed_audio_seconds=0, claim_token=NULL, updated_at=? WHERE status='processing'",
            (_now(),),
        )

    def enqueue(self, job: JobInput) -> dict[str, Any]:
        now = _now()
        self._connection().execute(
            """INSERT OR IGNORE INTO transcription_job
            (id,audio_path,speaker_user_id,start_offset_ms,language,initial_prompt,hotwords,status,created_at,updated_at)
            VALUES (:id,:audio_path,:speaker_user_id,:start_offset_ms,:language,:initial_prompt,:hotwords,'queued',:now,:now)""",
            {**asdict(job), "now": now},
        )
        existing = self.get(job.id)
        assert existing is not None
        for key, value in asdict(job).items():
            if existing[key] != value:
                raise ValueError(f"Job id already exists with different {key}.")
        return existing

    def claim_next(self) -> dict[str, Any] | None:
        connection = self._connection()
        connection.execute("BEGIN IMMEDIATE")
        try:
            row = connection.execute(
                """SELECT * FROM transcription_job
                WHERE status='queued' AND attempts < max_attempts
                ORDER BY created_at LIMIT 1"""
            ).fetchone()
            if row is None:
                connection.execute("COMMIT")
                return None
            now = _now()
            claim_token = uuid.uuid4().hex
            connection.execute(
                """UPDATE transcription_job SET status='processing', phase='loading', progress=0,
                processed_audio_seconds=0, audio_duration_seconds=NULL, attempts=attempts+1,
                claim_token=?, started_at=?, updated_at=?, error=NULL WHERE id=?""",
                (claim_token, now, now, row["id"]),
            )
            connection.execute("COMMIT")
            claimed = connection.execute(
                "SELECT * FROM transcription_job WHERE id=?", (row["id"],)
            ).fetchone()
            return _serialize(claimed, include_claim_token=True) if claimed is not None else None
        except BaseException:
            connection.execute("ROLLBACK")
            raise

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
        now = _now()
        result = self._connection().execute(
            """UPDATE transcription_job SET status='queued', phase='queued', progress=0,
            processed_audio_seconds=0, audio_duration_seconds=NULL, attempts=0, error=NULL,
            claim_token=NULL, started_at=NULL, completed_at=NULL, updated_at=?
            WHERE id=? AND status='failed'""",
            (now, job_id),
        )
        if result.rowcount == 0:
            return self.get(job_id)
        return self.get(job_id)

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
        escaped = session_id.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        result = self._connection().execute(
            """UPDATE transcription_job SET status='queued', phase='queued', progress=0,
            processed_audio_seconds=0, audio_duration_seconds=NULL, attempts=0, error=NULL,
            claim_token=NULL, started_at=NULL, completed_at=NULL, updated_at=?
            WHERE id LIKE ? ESCAPE '\\' AND status='failed'""",
            (_now(), f"{escaped}:%"),
        )
        return result.rowcount

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
