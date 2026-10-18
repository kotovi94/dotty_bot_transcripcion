import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from dotty_transcriber.instance_lock import (
    InstanceLockError,
    TranscriberInstanceLock,
    reject_unsupported_process_mode,
)
from dotty_transcriber.storage import JobInput, JobStore


SERVICE_ROOT = Path(__file__).resolve().parents[1]
HOLDER = """
import sys
from pathlib import Path
from dotty_transcriber.instance_lock import TranscriberInstanceLock
lock = TranscriberInstanceLock.acquire(Path(sys.argv[1]))
Path(sys.argv[2]).write_text('ready', encoding='utf-8')
sys.stdin.readline()
lock.release()
"""


def _environment(directory: Path) -> dict[str, str]:
    return {**os.environ, "PYTHONPATH": str(SERVICE_ROOT), "PYTHONDONTWRITEBYTECODE": "1",
            "DOTTY_DATA_DIR": str(directory), "WEB_CONCURRENCY": "1"}


def _holder(directory: Path) -> subprocess.Popen[str]:
    ready = directory.parent / f"{directory.name}.ready"
    process = subprocess.Popen(
        [sys.executable, "-c", HOLDER, str(directory), str(ready)],
        cwd=SERVICE_ROOT, env=_environment(directory), stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    deadline = time.monotonic() + 5
    while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.02)
    if not ready.exists():
        process.kill()
        _, stderr = process.communicate(timeout=5)
        pytest.fail(f"Lock holder did not start: {stderr}")
    return process


def _stop(process: subprocess.Popen[str], *, kill: bool = False) -> None:
    if process.poll() is not None:
        return
    if kill:
        process.kill()
    else:
        assert process.stdin is not None
        process.stdin.write("\n")
        process.stdin.flush()
    process.communicate(timeout=5)


def _probe(directory: Path) -> subprocess.CompletedProcess[str]:
    code = """
import sys
from pathlib import Path
from dotty_transcriber.instance_lock import TranscriberInstanceLock
lock = TranscriberInstanceLock.acquire(Path(sys.argv[1]))
lock.release()
"""
    return subprocess.run(
        [sys.executable, "-c", code, str(directory)], cwd=SERVICE_ROOT,
        env=_environment(directory), capture_output=True, text=True, timeout=5,
    )


def _drive(coroutine):
    """The lifespan currently has no await points; avoid Windows test sockets."""
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    raise AssertionError("The lifespan acquired an unexpected asynchronous wait")


def test_excludes_second_process_without_touching_sqlite(tmp_path: Path) -> None:
    directory = tmp_path / "shared"
    directory.mkdir()
    store = JobStore(directory / "transcriber.db")
    store.enqueue(JobInput("session:chunk", "unused.wav", "user", 0, "es"))
    claimed = store.claim_next()
    assert claimed is not None
    owner = _holder(directory)
    try:
        second = _probe(directory)
        assert second.returncode != 0
        assert "Another transcriber owns data directory" in second.stderr
        assert store.get("session:chunk")["status"] == "processing"
        assert store.close_admission("session")["active_at_close"] == [
            {"id": claimed["id"], "claim_token": claimed["claim_token"]}
        ]
    finally:
        _stop(owner)
    assert _probe(directory).returncode == 0


def test_different_directories_and_os_release_after_kill(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    owner_a = _holder(first)
    owner_b = _holder(second)
    try:
        assert _probe(first).returncode != 0
        assert _probe(second).returncode != 0
        _stop(owner_a, kill=True)
        assert _probe(first).returncode == 0
        assert _probe(second).returncode != 0
    finally:
        _stop(owner_a)
        _stop(owner_b)
    assert _probe(second).returncode == 0


def test_main_import_has_no_jobstore_or_data_directory_effect(tmp_path: Path) -> None:
    directory = tmp_path / "import-only"
    result = subprocess.run(
        [sys.executable, "-c", "import dotty_transcriber.main; print('imported')"],
        cwd=SERVICE_ROOT, env=_environment(directory), capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert "imported" in result.stdout
    assert not directory.exists()


def test_failed_startup_releases_lock_before_jobstore_initialization(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from dotty_transcriber import main

    directory = tmp_path / "failed-startup"
    monkeypatch.setenv("DOTTY_DATA_DIR", str(directory))
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    called = False

    def broken_store(_path):
        nonlocal called
        called = True
        raise RuntimeError("fixture startup failure")

    monkeypatch.setattr(main, "JobStore", broken_store)

    with pytest.raises(RuntimeError, match="fixture startup failure"):
        _drive(main.lifespan(main.app).__aenter__())
    assert called
    assert not (directory / "transcriber.db").exists()
    assert _probe(directory).returncode == 0


def test_existing_owner_rejects_lifespan_before_jobstore(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from dotty_transcriber import main

    directory = tmp_path / "owned"
    owner = _holder(directory)
    monkeypatch.setenv("DOTTY_DATA_DIR", str(directory))
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    called = False

    def unexpected_store(_path):
        nonlocal called
        called = True
        raise AssertionError("JobStore must not initialize")

    monkeypatch.setattr(main, "JobStore", unexpected_store)

    try:
        with pytest.raises(InstanceLockError, match="Another transcriber owns"):
            _drive(main.lifespan(main.app).__aenter__())
        assert not called
        assert not (directory / "transcriber.db").exists()
    finally:
        _stop(owner)


def test_restart_keeps_closed_admission(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from dotty_transcriber import main

    directory = tmp_path / "restart"
    monkeypatch.setenv("DOTTY_DATA_DIR", str(directory))
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    monkeypatch.setattr(main, "_worker_loop", lambda: None)

    def cycle(close: bool) -> None:
        context = main.lifespan(main.app)
        _drive(context.__aenter__())
        try:
            if close:
                main.store.close_admission("session")
            else:
                assert main.store.admission_state("session")["closed"] is True
        finally:
            _drive(context.__aexit__(None, None, None))

    cycle(True)
    assert _probe(directory).returncode == 0
    cycle(False)


def test_shutdown_retains_lock_while_worker_is_alive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from dotty_transcriber import main

    directory = tmp_path / "blocked-worker"
    release_worker = threading.Event()
    worker_started = threading.Event()

    def blocked_worker() -> None:
        worker_started.set()
        release_worker.wait()

    monkeypatch.setenv("DOTTY_DATA_DIR", str(directory))
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    monkeypatch.setenv("WHISPER_GPU_WORKERS", "1")
    monkeypatch.setattr(main, "_worker_loop", blocked_worker)
    context = main.lifespan(main.app)
    _drive(context.__aenter__())
    try:
        assert worker_started.wait(5)
        _drive(context.__aexit__(None, None, None))
        assert main._active_lock is not None
        assert _probe(directory).returncode != 0
    finally:
        release_worker.set()
        for worker in threading.enumerate():
            if worker.name == "transcriber-worker-1":
                worker.join(timeout=5)
        if main._active_lock is not None:
            main._active_lock.release()
            main._active_lock = None


def test_rejects_unsupported_uvicorn_process_modes() -> None:
    reject_unsupported_process_mode(["uvicorn", "--workers", "1"], {"WEB_CONCURRENCY": "1"})
    for argv, environment in [
        (["uvicorn", "--workers", "2"], {}),
        (["uvicorn", "--workers=2"], {}),
        (["uvicorn", "--reload"], {}),
        (["uvicorn"], {"WEB_CONCURRENCY": "2"}),
    ]:
        with pytest.raises(InstanceLockError):
            reject_unsupported_process_mode(argv, environment)


def test_lock_object_releases_normally(tmp_path: Path) -> None:
    lock = TranscriberInstanceLock.acquire(tmp_path / "normal")
    assert _probe(lock.directory).returncode != 0
    lock.release()
    lock.release()
    assert _probe(lock.directory).returncode == 0
