"""Per-session file coordination shared by Python mutators and Node publishers.

Both callers must agree on the resolved data directory before using it.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import threading
import time
from typing import Iterator
import uuid


class SessionCoordinationError(RuntimeError):
    pass


class SessionLockTimeout(SessionCoordinationError):
    pass


class SessionLockCancelled(SessionCoordinationError):
    pass


class SessionLockConflict(SessionCoordinationError):
    pass


class SessionLockPermissionError(SessionCoordinationError):
    pass


def _same_directory(left: Path, right: Path) -> bool:
    return os.path.normcase(str(left.resolve())) == os.path.normcase(str(right.resolve()))


class SessionFileCoordinator:
    def __init__(self, data_dir: Path, *, node_data_dir: Path) -> None:
        self.data_dir = Path(data_dir).resolve()
        if not _same_directory(self.data_dir, Path(node_data_dir)):
            raise SessionCoordinationError("Python and Node data directories differ")
        self.root = self.data_dir / "session-locks"

    def path_for(self, session_id: str) -> Path:
        if (not isinstance(session_id, str) or not session_id or session_id in (".", "..")
                or len(session_id.encode("utf-16-le", "surrogatepass")) // 2 > 128
                or any(char in "/\\" or ord(char) < 32 for char in session_id)):
            raise SessionCoordinationError("Invalid session ID")
        # Node Buffer.from(string, "utf8") replaces unpaired UTF-16 surrogates.
        node_text = session_id.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")
        return self.root / f"{node_text.encode('utf-8').hex()}.session.lock"

    @contextmanager
    def acquire(
        self, session_id: str, *, timeout_ms: float = 5_000, poll_ms: float = 25,
        cancel: threading.Event | None = None,
    ) -> Iterator[SessionLock]:
        if (not math.isfinite(timeout_ms) or timeout_ms < 0 or
                not math.isfinite(poll_ms) or poll_ms <= 0):
            raise ValueError("Invalid lock timing")
        path = self.path_for(session_id)
        if cancel is not None and cancel.is_set():
            raise SessionLockCancelled(f"Cancelled waiting for session lock: {session_id}")
        try:
            self.root.mkdir(parents=True, exist_ok=True)
        except PermissionError as error:
            raise SessionLockPermissionError(f"Cannot create session lock directory: {self.root}") from error
        deadline = time.monotonic() + timeout_ms / 1_000
        while True:
            if cancel is not None and cancel.is_set():
                raise SessionLockCancelled(f"Cancelled waiting for session lock: {session_id}")
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0), 0o600)
                break
            except FileExistsError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise SessionLockTimeout(f"Timed out waiting for session lock: {session_id}; inspect {path}")
                delay = min(poll_ms / 1_000, remaining)
                if cancel is not None:
                    if cancel.wait(delay):
                        raise SessionLockCancelled(f"Cancelled waiting for session lock: {session_id}")
                else:
                    time.sleep(delay)
            except PermissionError as error:
                raise SessionLockPermissionError(f"Cannot create session lock: {path}") from error
        token = str(uuid.uuid4())
        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        content = json.dumps(
            {"token": token, "pid": os.getpid(), "createdAt": created_at}, separators=(",", ":")
        ).encode("utf-8")
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(content)
                stream.flush()
                os.fsync(fd)
            identity = os.fstat(fd)
        except BaseException:
            # A partial lock is uncertain and must be inspected, never silently removed.
            os.close(fd)
            raise
        lease = SessionLock(path, token, fd, identity.st_dev, identity.st_ino)
        try:
            yield lease
        finally:
            lease.release()


class SessionLock:
    def __init__(self, path: Path, token: str, fd: int, device: int, inode: int) -> None:
        self.path = path
        self.token = token
        self._fd: int | None = fd
        self._identity = (device, inode)

    def _check_owner(self) -> None:
        try:
            stat = self.path.stat()
            content = json.loads(self.path.read_text(encoding="utf-8"))
        except PermissionError as error:
            raise SessionLockPermissionError(f"Cannot inspect session lock: {self.path}") from error
        except (OSError, ValueError, TypeError) as error:
            raise SessionLockConflict(f"Session lock ownership is uncertain: {self.path}") from error
        if not isinstance(content, dict) or content.get("token") != self.token or (stat.st_dev, stat.st_ino) != self._identity:
            raise SessionLockConflict(f"Session lock ownership changed: {self.path}")

    def release(self) -> None:
        if self._fd is None:
            return
        try:
            self._check_owner()
        finally:
            # Python's Windows file handle cannot be unlinked while open.
            os.close(self._fd)
            self._fd = None
        self._check_owner()
        try:
            self.path.unlink()
        except PermissionError as error:
            raise SessionLockPermissionError(f"Cannot release session lock: {self.path}") from error
        except OSError as error:
            raise SessionLockConflict(f"Cannot release session lock: {self.path}") from error
