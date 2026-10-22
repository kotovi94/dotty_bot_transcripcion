"""Synthetic interoperability checks; no Dotty service or production data is used."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import threading
import time

import pytest

from dotty_transcriber.session_file_coordinator import (
    SessionCoordinationError,
    SessionFileCoordinator,
    SessionLockCancelled,
    SessionLockConflict,
    SessionLockPermissionError,
    SessionLockTimeout,
)


PROJECT_ROOT = Path(__file__).resolve().parents[3]
NODE_MODULE = (PROJECT_ROOT / "apps/bot/src/sessions/session-file-coordinator.ts").as_uri()


def coordinator(data_dir: Path) -> SessionFileCoordinator:
    return SessionFileCoordinator(data_dir, node_data_dir=data_dir)


def node_script(tmp_path: Path) -> Path:
    script = tmp_path / "node-lock-probe.mjs"
    script.write_text(
        f"""import {{ SessionFileCoordinator }} from {json.dumps(NODE_MODULE)};
const owner = new SessionFileCoordinator(process.argv[2]);
const session = process.argv[3];
const mode = process.argv[4];
if (mode === 'path') {{ console.log(owner.pathFor(session)); }}
else {{
  try {{
    await owner.runExclusive(session, async () => {{
      if (mode === 'hold') {{
        console.log('READY');
        await new Promise(resolve => process.stdin.once('data', resolve));
      }}
    }}, {{ timeoutMs: 100, pollMs: 5 }});
  }} catch (error) {{
    if (String(error).includes('Timed out')) process.exitCode = 7;
    else {{ console.error(error); process.exitCode = 8; }}
  }}
}}
""",
        encoding="utf-8",
    )
    return script


def node_call(script: Path, data_dir: Path, session: str, mode: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", "--import", "tsx", str(script), str(data_dir / "session-locks"), session, mode],
        cwd=PROJECT_ROOT, text=True, encoding="utf-8", capture_output=True, timeout=15, check=False,
    )


def test_node_and_python_compute_same_path_including_unicode(tmp_path: Path) -> None:
    data_dir = tmp_path / "espacios y ñ 🎲"
    owner = coordinator(data_dir)
    script = node_script(tmp_path)
    for session in ("sesion-1", "Case", "case", "sala ñ 🎲"):
        result = node_call(script, data_dir, session, "path")
        assert result.returncode == 0, result.stderr
        assert Path(result.stdout.strip()) == owner.path_for(session)
    assert owner.path_for("Case") != owner.path_for("case")
    with pytest.raises(SessionCoordinationError):
        owner.path_for("../bad")


def test_python_acquires_releases_and_writes_node_identity(tmp_path: Path) -> None:
    owner = coordinator(tmp_path)
    path = owner.path_for("one")
    with owner.acquire("one") as lease:
        identity = json.loads(path.read_text(encoding="utf-8"))
        assert set(identity) == {"token", "pid", "createdAt"}
        assert identity["token"] == lease.token
        assert identity["pid"] == os.getpid()
        assert identity["createdAt"].endswith("Z")
        with pytest.raises(SessionLockTimeout):
            with owner.acquire("one", timeout_ms=0):
                pass
        with owner.acquire("two"):
            assert owner.path_for("two").exists()
    assert not path.exists()
    with owner.acquire("one"):
        assert path.exists()


def test_python_cannot_acquire_node_held_lock(tmp_path: Path) -> None:
    owner = coordinator(tmp_path)
    script = node_script(tmp_path)
    process = subprocess.Popen(
        ["node", "--import", "tsx", str(script), str(tmp_path / "session-locks"), "one", "hold"],
        cwd=PROJECT_ROOT, text=True, encoding="utf-8", stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        assert process.stdout is not None
        assert process.stdout.readline().strip() == "READY"
        with pytest.raises(SessionLockTimeout):
            with owner.acquire("one", timeout_ms=50, poll_ms=5):
                pass
    finally:
        assert process.stdin is not None
        process.stdin.write("release\n")
        process.stdin.flush()
        stdout, stderr = process.communicate(timeout=15)
        assert process.returncode == 0, (stdout, stderr)
    with owner.acquire("one"):
        pass


def test_node_cannot_acquire_python_held_lock(tmp_path: Path) -> None:
    owner = coordinator(tmp_path)
    script = node_script(tmp_path)
    with owner.acquire("one"):
        result = node_call(script, tmp_path, "one", "probe")
        assert result.returncode == 7, result.stderr
    result = node_call(script, tmp_path, "one", "probe")
    assert result.returncode == 0, result.stderr


def test_exception_and_cancellation_release_safely(tmp_path: Path) -> None:
    owner = coordinator(tmp_path)
    with pytest.raises(ValueError, match="synthetic"):
        with owner.acquire("one"):
            raise ValueError("synthetic")
    assert not owner.path_for("one").exists()
    cancel = threading.Event()
    with owner.acquire("one"):
        timer = threading.Timer(0.04, cancel.set)
        timer.start()
        try:
            start = time.monotonic()
            with pytest.raises(SessionLockCancelled):
                with owner.acquire("one", timeout_ms=2_000, cancel=cancel):
                    pass
            assert time.monotonic() - start < 1
        finally:
            timer.join()


def test_surviving_or_foreign_lock_is_never_removed(tmp_path: Path) -> None:
    owner = coordinator(tmp_path)
    path = owner.path_for("one")
    path.parent.mkdir(parents=True)
    path.write_text("abandoned", encoding="utf-8")
    with pytest.raises(SessionLockTimeout):
        with owner.acquire("one", timeout_ms=30, poll_ms=5):
            pass
    assert path.read_text(encoding="utf-8") == "abandoned"
    path.unlink()
    with pytest.raises(SessionLockConflict):
        with owner.acquire("one"):
            path.write_text("foreign", encoding="utf-8")
    assert path.read_text(encoding="utf-8") == "foreign"


def test_permission_errors_and_data_directory_mismatch_fail_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(SessionCoordinationError, match="differ"):
        SessionFileCoordinator(tmp_path / "python", node_data_dir=tmp_path / "node")
    assert not (tmp_path / "python" / "session-locks").exists()
    owner = coordinator(tmp_path)
    original_open = os.open

    def denied(path: os.PathLike[str] | str, *args: object, **kwargs: object) -> int:
        if str(path).endswith(".session.lock"):
            raise PermissionError("synthetic denial")
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(os, "open", denied)
    with pytest.raises(SessionLockPermissionError):
        with owner.acquire("one", timeout_ms=0):
            pass
