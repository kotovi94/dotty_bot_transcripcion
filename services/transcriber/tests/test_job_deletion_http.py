"""HTTP preparation and lookup never delete jobs or claim worker inactivity."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace
import sqlite3
import uuid

from fastapi.testclient import TestClient
import pytest

from dotty_transcriber import main
from dotty_transcriber.storage import JobInput, JobStore


AUTH = {"authorization": "Bearer fixture-secret"}


@pytest.fixture
def service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    store = JobStore(tmp_path / "jobs.db")
    monkeypatch.setattr(main, "store", store, raising=False)
    monkeypatch.setattr(main, "settings", SimpleNamespace(secret="fixture-secret", data_dir=tmp_path), raising=False)
    monkeypatch.setattr(main, "configured_data_dir", lambda: tmp_path)
    return TestClient(main.app), store, tmp_path / "jobs.db"


def payload(operation_id: str | None = None, **changes):
    value = {"operation_id": operation_id or str(uuid.uuid4()),
             "operation_type": "reprocess", "parameters": {}}
    value.update(changes)
    return value


def post(client: TestClient, session_id: str, body: dict):
    return client.post(f"/v1/sessions/{session_id}/job-deletions", json=body, headers=AUTH)


def job(store: JobStore, job_id: str):
    return store.enqueue(JobInput(job_id, "unused.wav", "user", 0, "es",
                                  initial_prompt="private prompt", hotwords="private hotwords"))


def test_post_prepares_without_deleting_or_confirming_inactivity(service):
    client, store, _ = service
    admitted = job(store, "session:chunk")
    claimed = store.claim_next()
    assert claimed is not None
    response = post(client, "session", payload())
    assert response.status_code == 202
    result = response.json()
    assert result["status"] == "pending_drain"
    assert result["workers_inactive"] is None
    assert result["jobs_deleted"] is False
    assert result["targets"][0]["generation_id"] == admitted["generation_id"]
    assert store.get("session:chunk") is not None
    assert store.occupations_for_session("session")[0]["released_at"] is None
    assert store.admission_state("session")["closed"] is True


def test_identical_post_and_get_return_persisted_projection_after_restart(service, monkeypatch):
    client, store, path = service
    job(store, "session:chunk")
    body = payload()
    first = post(client, "session", body)
    second = post(client, "session", body)
    assert first.status_code == second.status_code == 202
    assert first.json() == second.json()
    restarted = JobStore(path)
    monkeypatch.setattr(main, "store", restarted)
    lookup = client.get(f"/v1/job-deletions/{body['operation_id']}", headers=AUTH)
    assert lookup.status_code == 200
    assert lookup.json() == first.json()
    assert restarted.get("session:chunk") is not None


def test_concurrent_identical_posts_return_one_operation(service):
    client, store, _ = service
    job(store, "session:chunk")
    body = payload()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: post(client, "session", body), range(2)))
    assert [result.status_code for result in results] == [202, 202]
    assert results[0].json() == results[1].json()
    assert store._connection().execute("SELECT COUNT(*) FROM job_deletion_operation").fetchone()[0] == 1


@pytest.mark.parametrize("change", [
    {"operation_type": "manual_recovery"},
    {"parameters": {"reason": "changed"}},
])
def test_incompatible_reuse_is_rejected(service, change):
    client, store, _ = service
    body = payload()
    assert post(client, "session", body).status_code == 202
    changed = post(client, "session", {**body, **change})
    assert changed.status_code in (409, 422)
    if changed.status_code == 409:
        assert changed.json()["detail"]["code"] == "OPERATION_ID_CONFLICT"
    assert store.job_deletion_operation(body["operation_id"])["operation_type"] == "reprocess"


def test_second_operation_for_session_and_legacy_closure_are_rejected(service):
    client, store, _ = service
    assert post(client, "session", payload()).status_code == 202
    response = post(client, "session", payload())
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "SESSION_ADMISSION_CLOSED"
    store.close_admission("legacy")
    old = payload()
    response = post(client, "legacy", old)
    assert response.status_code == 409
    assert store.job_deletion_operation(old["operation_id"]) is None


def test_operation_id_cannot_be_reused_for_another_session(service):
    client, store, _ = service
    body = payload()
    assert post(client, "first", body).status_code == 202
    response = post(client, "second", body)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "OPERATION_ID_CONFLICT"
    assert store.admission_state("second")["closed"] is False


def test_other_session_still_progresses(service):
    client, store, _ = service
    job(store, "one:chunk")
    job(store, "two:chunk")
    assert post(client, "one", payload()).status_code == 202
    assert post(client, "two", payload()).status_code == 202
    assert store.get("one:chunk") is not None
    assert store.get("two:chunk") is not None


def test_get_missing_and_invalid_id_are_read_only(service):
    client, store, _ = service
    missing = client.get(f"/v1/job-deletions/{uuid.uuid4()}", headers=AUTH)
    invalid = client.get("/v1/job-deletions/not-a-uuid", headers=AUTH)
    assert missing.status_code == 404
    assert invalid.status_code == 422
    assert store._connection().execute("SELECT COUNT(*) FROM job_deletion_operation").fetchone()[0] == 0


def test_get_during_uncommitted_post_returns_404_then_operation(service, monkeypatch):
    client, store, _ = service
    job(store, "session:chunk")
    entered, resume = Event(), Event()
    original = JobStore._record_deletion_target

    def paused(connection, operation_id, session_id, row):
        entered.set()
        assert resume.wait(5)
        original(connection, operation_id, session_id, row)

    monkeypatch.setattr(JobStore, "_record_deletion_target", staticmethod(paused))
    body = payload()
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(post, client, "session", body)
        try:
            assert entered.wait(5)
            absent = client.get(f"/v1/job-deletions/{body['operation_id']}", headers=AUTH)
            assert absent.status_code == 404
        finally:
            resume.set()
        assert pending.result(timeout=5).status_code == 202
    assert client.get(f"/v1/job-deletions/{body['operation_id']}", headers=AUTH).status_code == 200


@pytest.mark.parametrize("invalid", ["bad", str(uuid.uuid4()).upper(), uuid.uuid4().hex])
def test_post_rejects_noncanonical_uuid(service, invalid):
    client, store, _ = service
    assert post(client, "session", payload(invalid)).status_code == 422
    assert store.admission_state("session")["closed"] is False


@pytest.mark.parametrize("change", [
    {"operation_type": "unknown"},
    {"parameters": {"unknown": True}},
    {"unexpected": True},
])
def test_post_rejects_undefined_contract_fields(service, change):
    client, store, _ = service
    assert post(client, "session", payload(**change)).status_code == 422
    assert store.admission_state("session")["closed"] is False


def test_post_rejects_invalid_session_id(service):
    client, store, _ = service
    assert post(client, "session:other", payload()).status_code == 422
    assert store.admission_state("session")["closed"] is False


def test_post_and_get_require_authentication(service):
    client, store, _ = service
    body = payload()
    assert client.post("/v1/sessions/session/job-deletions", json=body).status_code == 401
    assert client.get(f"/v1/job-deletions/{body['operation_id']}").status_code == 401
    assert store.admission_state("session")["closed"] is False


def test_legacy_delete_is_gone_without_store_or_diagnostic_effects(service, monkeypatch):
    client, store, _ = service
    job(store, "session:chunk")
    monkeypatch.setattr(store, "delete_for_session", lambda _: pytest.fail("unsafe delete called"))
    monkeypatch.setattr(main, "_record_diagnostic", lambda *args, **kwargs: pytest.fail("diagnostic called"))
    response = client.delete("/v1/sessions/session", headers=AUTH)
    assert response.status_code == 410
    assert response.json()["detail"]["code"] == "LEGACY_JOB_DELETE_DISABLED"
    assert store.get("session:chunk") is not None
    assert store.admission_state("session")["closed"] is False
    assert store._connection().execute("SELECT COUNT(*) FROM job_deletion_operation").fetchone()[0] == 0


def test_projections_exclude_sensitive_fields(service):
    client, store, _ = service
    job(store, "session:chunk")
    body = payload()
    prepared = post(client, "session", body)
    looked_up = client.get(f"/v1/job-deletions/{body['operation_id']}", headers=AUTH)
    for response in (prepared, looked_up):
        assert response.status_code in (200, 202)
        text = response.text
        for forbidden in ("unused.wav", "private prompt", "private hotwords", "audio_path",
                          "initial_prompt", "claim_token", "snapshot", "result_json"):
            assert forbidden not in text


def test_sqlite_failure_does_not_report_success(service, monkeypatch):
    client, store, _ = service
    job(store, "session:chunk")
    store._connection().execute(
        "CREATE TRIGGER reject_target BEFORE INSERT ON job_deletion_target "
        "BEGIN SELECT RAISE(ABORT, 'private sqlite error'); END"
    )
    body = payload()
    response = post(client, "session", body)
    assert response.status_code == 503
    assert response.json()["detail"] == {"code": "JOB_DELETION_STATE_UNCERTAIN"}
    assert "private sqlite error" not in response.text
    assert store.get("session:chunk") is not None
    assert store.admission_state("session")["closed"] is False
    assert store.job_deletion_operation(body["operation_id"]) is None
    monkeypatch.setattr(store, "job_deletion_operation", lambda _: (_ for _ in ()).throw(sqlite3.OperationalError("private")))
    failed_get = client.get(f"/v1/job-deletions/{body['operation_id']}", headers=AUTH)
    assert failed_get.status_code == 503
    assert "private" not in failed_get.text
