"""Process-lifetime ownership of one transcriber data directory."""

from __future__ import annotations

from contextlib import contextmanager
import errno
import os
import threading
import uuid
from pathlib import Path
from typing import BinaryIO, Iterator


_ACQUIRED_LOCK_TOKEN = object()


class InstanceLockError(RuntimeError):
    pass


class InstanceAlreadyRunningError(InstanceLockError):
    pass


class TranscriberInstanceLock:
    """An OS byte-range/flock lock; the file's existence is not the lock."""

    def __init__(
        self, directory: Path, handle: BinaryIO, *, acquisition_token: object | None = None,
    ) -> None:
        if acquisition_token is not _ACQUIRED_LOCK_TOKEN:
            raise InstanceLockError("Transcriber instance locks must be acquired from the operating system")
        self.directory = directory
        self._handle = handle
        self._instance_id = uuid.uuid4().hex
        self._held = True
        self._state_lock = threading.RLock()

    @property
    def instance_id(self) -> str:
        return self._instance_id

    @property
    def is_held(self) -> bool:
        with self._state_lock:
            return self._held and not self._handle.closed

    @contextmanager
    def hold_identity(self) -> Iterator[str]:
        with self._state_lock:
            if not self._held or self._handle.closed:
                raise RuntimeError("A held transcriber instance lock is required")
            yield self._instance_id

    @classmethod
    def acquire(cls, directory: Path) -> "TranscriberInstanceLock":
        directory = directory.resolve()
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / ".transcriber-instance.lock"
        handle = path.open("a+b", buffering=0)
        try:
            # Windows locks a byte range from the current file position. Keep
            # byte zero allocated and seek back before locking or unlocking.
            if handle.seek(0, os.SEEK_END) == 0:
                handle.write(b"\0")
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            handle.close()
            if error.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise InstanceAlreadyRunningError(
                    f"Another transcriber owns data directory {directory}"
                ) from error
            raise InstanceLockError(f"Cannot lock transcriber data directory {directory}") from error
        return cls(directory, handle, acquisition_token=_ACQUIRED_LOCK_TOKEN)

    def release(self) -> None:
        with self._state_lock:
            if not self._held or self._handle.closed:
                return
            self._handle.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(self._handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
            finally:
                self._handle.close()
                self._held = False


def reject_unsupported_process_mode(argv: list[str], environment: dict[str, str]) -> None:
    """Avoid Uvicorn supervisors repeatedly spawning workers that cannot own the lock."""
    for index, argument in enumerate(argv):
        if argument == "--reload" or argument.startswith("--reload="):
            raise InstanceLockError("Uvicorn --reload is unsupported for the transcriber")
        if argument == "--workers":
            value = argv[index + 1] if index + 1 < len(argv) else ""
        elif argument.startswith("--workers="):
            value = argument.split("=", 1)[1]
        else:
            continue
        if not value.isdigit() or int(value) != 1:
            raise InstanceLockError("Uvicorn must use exactly one process")
    configured = environment.get("WEB_CONCURRENCY", "1")
    if not configured.isdigit() or int(configured) != 1:
        raise InstanceLockError("WEB_CONCURRENCY must be 1 for the transcriber")
