import asyncio
import io
import json
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from action_initiatives import ActionInitiatives, InitiativeSettings, make_initiative_router
from action_registry import ActionDefinition, ActionInputs, ActionOutput, ActionRegistry
from action_runs import ActionRuns, ConfirmIn, RunIn
from local_docstore import LocalDocStore


def run(operation):
    return asyncio.run(operation)


@pytest.fixture
def harness(tmp_path):
    db = LocalDocStore(tmp_path / "initiatives.db")
    run(db.users.insert_one({"user_id": "one", "role": "admin"}))
    run(db.users.insert_one({"user_id": "two"}))
    handler = AsyncMock(return_value=ActionOutput(data={"done": True}))
    registry = ActionRegistry()
    registry.register(ActionDefinition("test.apply", "TEST", "Action sensible", "1",
                                       ActionInputs, ActionOutput, handler, kind="mutation", risk="sensitive"))
    registry.register(ActionDefinition("test.read", "TEST", "Lecture", "1", ActionInputs, ActionOutput,
                                       handler, max_attempts=1))
    engine = ActionRuns(db, registry)
    return ActionInitiatives(db, engine), handler


def plan(service, uid="one", action="test.apply", now=None):
    saved = run(service.runs.create(uid, RunIn(
        request_id=uuid.uuid4(), objective="À vérifier", steps=[{"id": "step", "action": action}])))
    now = now or datetime.now(timezone.utc)
    run(service.db.sirius_action_runs.update_one({"user_id": uid, "id": saved["id"]}, {"$set": {
        "created_at": (now - timedelta(minutes=20)).isoformat(),
    }}))
    return saved


def test_default_off_then_exact_interval_claim_no_execution_and_scoping(harness):
    service, handler = harness
    now = datetime.now(timezone.utc)
    saved = plan(service)
    plan(service, uid="two")
    run(service.tick(now))
    assert run(service.listing("one"))["items"] == []
    setting = run(service.configure("one", InitiativeSettings(enabled=True), now))
    assert datetime.fromisoformat(setting["next_check_at"]) == now + timedelta(minutes=15)
    run(service.tick(now + timedelta(minutes=15) - timedelta(microseconds=1)))
    assert run(service.listing("one"))["items"] == []
    async def concurrent():
        await asyncio.gather(service.tick(now + timedelta(minutes=15)), service.tick(now + timedelta(minutes=15)))
    run(concurrent())
    items = run(service.listing("one"))["items"]
    assert len(items) == 1 and items[0]["run_id"] == saved["id"]
    assert items[0]["current"] and items[0]["executed"] is False and items[0]["external_calls"] == 0
    handler.assert_not_called()
    assert run(service.listing("two"))["items"] == []
    run(service.tick(now + timedelta(minutes=30)))
    assert len(run(service.listing("one"))["items"]) == 1
    handler.assert_not_called()


def test_dismiss_idempotent_no_duplicate_and_obsolete_after_user_confirmation(harness):
    service, handler = harness
    now = datetime.now(timezone.utc)
    saved = plan(service)
    run(service.configure("one", InitiativeSettings(enabled=True), now))
    run(service.tick(now + timedelta(minutes=15)))
    item = run(service.listing("one"))["items"][0]
    with pytest.raises(HTTPException) as wrong_account:
        run(service.dismiss("two", item["id"]))
    assert wrong_account.value.status_code == 404
    prepared = saved["steps"][0]["prepared"]
    run(service.runs.confirm("one", saved["id"], "step", ConfirmIn(confirm=True, fingerprint=prepared["fingerprint"])))
    assert handler.await_count == 1
    assert run(service.listing("one"))["items"][0]["current"] is False
    run(service.dismiss("one", item["id"]))
    run(service.dismiss("one", item["id"]))
    assert run(service.listing("one"))["items"] == []
    run(service.tick(now + timedelta(minutes=30)))
    assert run(service.listing("one"))["items"] == []
    assert handler.await_count == 1


def test_blocked_errors_only_produce_proposal_never_retry_api(harness):
    service, handler = harness
    now = datetime.now(timezone.utc)
    handler.side_effect = HTTPException(429, "Quota fixture")
    saved = plan(service, action="test.read")
    assert handler.await_count == 1
    assert saved["steps"][0]["reflection"]["category"] == "quota"
    assert saved["steps"][0]["reflection"]["automatic_retry"] is False
    assert saved["events"][-1]["reflection"]["category"] == "quota"
    run(service.configure("one", InitiativeSettings(enabled=True), now))
    run(service.tick(now + timedelta(minutes=15)))
    item = run(service.listing("one"))["items"][0]
    assert item["source_state"] == "BLOCKED"
    assert handler.await_count == 1
    run(service.dismiss("one", item["id"]))
    run(service.tick(now + timedelta(minutes=30)))
    assert run(service.listing("one"))["items"] == []
    assert handler.await_count == 1


def test_stop_disabled_user_cancelled_or_expired_never_proposes(harness):
    service, handler = harness
    now = datetime.now(timezone.utc)
    saved = plan(service)
    run(service.configure("one", InitiativeSettings(enabled=True), now))
    run(service.db.users.update_one({"user_id": "one"}, {"$set": {"disabled": True}}))
    run(service.tick(now + timedelta(minutes=15)))
    assert run(service.listing("one"))["items"] == []
    run(service.db.users.update_one({"user_id": "one"}, {"$set": {"disabled": False}}))
    run(service.configure("one", InitiativeSettings(enabled=False), now + timedelta(minutes=16)))
    run(service.tick(now + timedelta(minutes=30)))
    assert run(service.listing("one"))["items"] == []
    run(service.configure("one", InitiativeSettings(enabled=True), now + timedelta(minutes=30)))
    run(service.runs.cancel("one", saved["id"]))
    expired = plan(service)
    run(service.db.sirius_action_runs.update_one({"id": expired["id"], "user_id": "one"},
                                               {"$set": {"expires_at": now.isoformat()}}))
    run(service.tick(now + timedelta(minutes=45)))
    assert run(service.listing("one"))["items"] == []
    handler.assert_not_called()


def test_missing_user_or_stop_during_status_read_prevents_proposal(harness, monkeypatch):
    service, handler = harness
    now = datetime.now(timezone.utc)
    plan(service)
    run(service.configure("one", InitiativeSettings(enabled=True), now))
    original = service.runs.status
    async def stop(uid, identity):
        await service.configure(uid, InitiativeSettings(enabled=False))
        return await original(uid, identity)
    monkeypatch.setattr(service.runs, "status", stop)
    run(service.tick(now + timedelta(minutes=15)))
    assert run(service.listing("one"))["items"] == []
    assert run(service.settings("one"))["next_check_at"] is None
    run(service.configure("missing", InitiativeSettings(enabled=True), now))
    run(service.tick(now + timedelta(minutes=30)))
    assert run(service.settings("missing"))["last_check_at"] is None
    handler.assert_not_called()


def test_bounded_scan_and_failure_is_visible_with_no_success_default(harness, monkeypatch):
    service, handler = harness
    now = datetime.now(timezone.utc)
    for _ in range(21):
        plan(service)
    run(service.configure("one", InitiativeSettings(enabled=True), now))
    run(service.tick(now + timedelta(minutes=15)))
    assert run(service.db.sirius_action_proposals.count_documents({"user_id": "one"})) == 20
    original = service.runs.status
    monkeypatch.setattr(service.runs, "status", AsyncMock(side_effect=HTTPException(503, "Storage fixture")))
    run(service.tick(now + timedelta(minutes=30)))
    assert "indisponible ou partiel" in run(service.settings("one"))["last_error"]
    handler.assert_not_called()
    monkeypatch.setattr(service.runs, "status", original)


def test_routes_strict_settings_auth_and_export(harness):
    import auth_api
    from test_account_inactivity import request_for
    service, handler = harness
    app = FastAPI()
    async def require_user(request, _db):
        if not request.headers.get("x-test-user"):
            raise HTTPException(401, "Connexion requise.")
        return {"user_id": request.headers["x-test-user"]}
    app.include_router(make_initiative_router(service, require_user), prefix="/api")
    with TestClient(app) as client:
        assert client.get("/api/ariane/initiatives").status_code == 401
        assert client.put("/api/ariane/initiatives/settings", json={"enabled": True}).status_code == 401
        assert client.post("/api/ariane/initiatives/missing/dismiss").status_code == 401
        headers = {"x-test-user": "one"}
        for body in ({"enabled": "true"}, {"enabled": True, "execute": True}):
            assert client.put("/api/ariane/initiatives/settings", headers=headers, json=body).status_code == 422
        assert client.put("/api/ariane/initiatives/settings", headers=headers, json={"enabled": True}).json()["enabled"]
        assert client.post("/api/ariane/initiatives/missing/dismiss", headers=headers).status_code == 404
    for uid in ("one", "two"):
        run(service.db.sirius_action_proposals.insert_one({"user_id": uid, "id": uid, "run_id": uid}))
        run(service.configure(uid, InitiativeSettings(enabled=True)))
    endpoint = next(route.endpoint for route in auth_api.make_auth_router(service.db).routes if route.path == "/auth/privacy/export")
    async def export():
        response = await endpoint(request_for({"user_id": "one", "role": "admin"}))
        return b"".join([chunk async for chunk in response.body_iterator])
    with zipfile.ZipFile(io.BytesIO(run(export()))) as archive:
        data = json.loads(archive.read("sirius-personal-data.json"))
    for name in ("sirius_action_proposals", "sirius_initiative_settings"):
        assert len(data["collections"][name]) == 1
        assert data["collections"][name][0]["user_id"] == "one"
    handler.assert_not_called()
