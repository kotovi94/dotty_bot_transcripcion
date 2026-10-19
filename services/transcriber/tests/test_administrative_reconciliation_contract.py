"""P0.1 safety evidence available before administrative reconciliation exists.

All database and audio fixtures live under pytest's temporary directory. These
tests deliberately exercise current entry points, never a speculative reconciler.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
import uuid

import pytest

from dotty_transcriber import main
from dotty_transcriber.storage import JobInput, JobStore
from dotty_transcriber.voice_processing import VoiceAnalysis


def _job(job_id: str, wav: Path) -> JobInput:
    return JobInput(job_id, str(wav), "fixture-user", 0, "es")


def _wav(tmp_path: Path) -> Path:
    wav = tmp_path / "fixture.wav"
    wav.write_bytes(b"fixture WAV bytes only")
    return wav


def _operation_id() -> str:
    return str(uuid.uuid4())


def test_prior_instance_occupation_is_not_released_without_liveness_evidence(
    tmp_path: Path,
) -> None:
    wav = _wav(tmp_path)
    path = tmp_path / "jobs.db"
    prior = JobStore(path)
    prior.enqueue(_job("session:chunk", wav))
    claim = prior.claim_next()
    assert claim is not None

    # A new store identity is not evidence that the previous worker has ended.
    current = JobStore(path)
    operation = current.prepare_job_deletion(_operation_id(), "session", "reprocess")
    assert operation["status"] == "pending_drain"
    assert current.admission_state("session")["workers_inactive"] is None
    assert current.occupations_for_session("session")[0]["pending_reconciliation"] is True
    assert not current.release_occupation(
        claim["occupation_id"], claim["id"], claim["claim_token"]
    )
    assert current.occupations_for_session("session")[0]["released_at"] is None
    assert current.claim_next() is None
    assert current.get(claim["id"]) is not None
    assert wav.read_bytes() == b"fixture WAV bytes only"


def test_cuda_interruption_preserves_occupation_and_pending_operation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    wav = _wav(tmp_path)
    path = tmp_path / "jobs.db"
    store = JobStore(path)
    store.enqueue(_job("session:chunk", wav))

    class InterruptedCudaEngine:
        active_device = "cuda"

        def transcribe(self, *_args):
            raise KeyboardInterrupt("fixture CUDA call interrupted")

    class FixtureVoice:
        def analyze(self, *_args):
            return VoiceAnalysis("SPEECH", 1.0, 1.0, 1.0, -20.0, {
                "threshold": 0.5, "min_silence_duration_ms": 500, "speech_pad_ms": 200,
            })

    monkeypatch.setattr(main, "store", store, raising=False)
    monkeypatch.setattr(main, "engine", InterruptedCudaEngine(), raising=False)
    monkeypatch.setattr(main, "voice_processor", FixtureVoice(), raising=False)
    monkeypatch.setattr(main, "settings", SimpleNamespace(
        model="fixture", device="cuda", compute_type="float16",
    ), raising=False)
    monkeypatch.setattr(main, "_record_diagnostic", lambda *args, **kwargs: None)
    main.stop_event.clear()
    try:
        with pytest.raises(KeyboardInterrupt, match="fixture CUDA call interrupted"):
            main._worker_loop()
    finally:
        main.stop_event.set()

    occupation = store.occupations_for_session("session")[0]
    operation = store.prepare_job_deletion(_operation_id(), "session", "reprocess")
    restarted = JobStore(path)
    assert occupation["released_at"] is None
    assert operation["status"] == "pending_drain"
    assert restarted.occupations_for_session("session")[0]["pending_reconciliation"] is True
    assert restarted.admission_state("session")["workers_inactive"] is None
    assert restarted.claim_next() is None
    assert restarted.get("session:chunk") is not None
    assert wav.read_bytes() == b"fixture WAV bytes only"


def test_observed_only_target_remains_pending_and_retains_its_job(
    tmp_path: Path,
) -> None:
    wav = _wav(tmp_path)
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(_job("session:legacy", wav))
    # Simulate a pre-protocol job, only in the temporary fixture database.
    store._connection().execute(
        "UPDATE transcription_job SET generation_id=NULL WHERE id='session:legacy'"
    )
    operation_id = _operation_id()
    operation = store.prepare_job_deletion(operation_id, "session", "manual_recovery")
    assert operation["targets"][0]["identity_status"] == "observed_only"
    assert operation["status"] == "pending_drain"
    assert store.job_deletion_operation(operation_id) == operation
    assert store.get("session:legacy") is not None
    assert wav.read_bytes() == b"fixture WAV bytes only"


def test_substituted_generation_cannot_replace_frozen_target(
    tmp_path: Path,
) -> None:
    wav = _wav(tmp_path)
    store = JobStore(tmp_path / "jobs.db")
    original = store.enqueue(_job("session:chunk", wav))
    operation_id = _operation_id()
    frozen = store.prepare_job_deletion(operation_id, "session", "reprocess")
    replacement_generation = uuid.uuid4().hex
    # Simulate an out-of-band row substitution in the temporary fixture.
    store._connection().execute(
        "UPDATE transcription_job SET generation_id=? WHERE id='session:chunk'",
        (replacement_generation,),
    )

    replay = store.prepare_job_deletion(operation_id, "session", "reprocess")
    assert frozen["targets"][0]["generation_id"] == original["generation_id"]
    assert replay == frozen
    assert store.get("session:chunk")["generation_id"] == replacement_generation
    assert replay["status"] == "pending_drain"
    assert store.get("session:chunk") is not None
    assert wav.read_bytes() == b"fixture WAV bytes only"


def test_concurrent_replay_and_owner_release_have_single_effect(
    tmp_path: Path,
) -> None:
    wav = _wav(tmp_path)
    store = JobStore(tmp_path / "jobs.db")
    store.enqueue(_job("session:chunk", wav))
    claim = store.claim_next()
    assert claim is not None
    operation_id = _operation_id()
    prepared = store.prepare_job_deletion(operation_id, "session", "reprocess")

    with ThreadPoolExecutor(max_workers=4) as pool:
        releases = [pool.submit(
            store.release_occupation, claim["occupation_id"], claim["id"], claim["claim_token"]
        ) for _ in range(2)]
        replays = [pool.submit(
            store.prepare_job_deletion, operation_id, "session", "reprocess"
        ) for _ in range(2)]
        release_results = [future.result(timeout=5) for future in releases]
        replay_results = [future.result(timeout=5) for future in replays]

    assert sorted(release_results) == [False, True]
    assert replay_results == [prepared, prepared]
    assert len(store.occupations_for_session("session")) == 1
    assert store.occupations_for_session("session")[0]["released_at"] is not None
    assert store._connection().execute(
        "SELECT COUNT(*) FROM job_deletion_operation WHERE session_id='session'"
    ).fetchone()[0] == 1
    assert store.claim_next() is None
    assert store.get("session:chunk") is not None
    assert wav.read_bytes() == b"fixture WAV bytes only"
