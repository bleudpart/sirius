import asyncio
import io
import json
import uuid
import zipfile
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from account_deletion import PERSONAL_COLLECTIONS
from local_docstore import LocalDocStore
from zapier_integrations import HookIn, KeyIn, NoteIn, ZapierIntegrations, hook_url, make_zapier_router, now


def run(value):
    return asyncio.run(value)


@pytest.fixture
def setup(tmp_path):
    db = LocalDocStore(tmp_path / "zapier.db")
    run(db.users.insert_one({"user_id": "one", "role": "admin"}))
    run(db.users.insert_one({"user_id": "other"}))
    service = ZapierIntegrations(db)
    key = run(service.create_key("one", KeyIn(label="Zap",
        scopes=["dossiers:read", "notes:write", "meetings:read", "hooks:write"])))
    async def owner(request, database):
        if request.headers.get("authorization") != "Bearer session":
            raise HTTPException(401, "Session requise")
        return {"user_id": "one"}
    app = FastAPI()
    app.include_router(make_zapier_router(service, owner), prefix="/api")
    client = TestClient(app)
    return service, client, key


def headers(key):
    return {"X-Sirius-Api-Key": key["api_key"]}


def dossier(service, identity="d1", uid="one", **extra):
    run(service.db.sirius_work_dossiers.insert_one({
        "id": identity, "user_id": uid, "title": "Projet", "category": "general",
        "created_at": now(), "notes": [], "sources": [{"private": True}], **extra,
    }))


def subscribe(service, key, event="dossier.created"):
    saved = run(service.db.sirius_zapier_keys.find_one({"id": key["id"]}))
    return run(service.subscribe(saved, HookIn(event=event, target_url="https://hooks.zapier.com/hooks/standard/test")))


def test_keys_are_hashed_scoped_and_management_requires_session(setup):
    service, client, key = setup
    row = run(service.db.sirius_zapier_keys.find_one({"id": key["id"]}))
    assert "api_key" not in row and key["api_key"] not in str(row)
    response = client.get("/api/integrations/zapier/me", headers=headers(key))
    assert response.status_code == 200 and "token_hash" not in response.text
    assert client.get("/api/integrations/zapier/keys", headers=headers(key)).status_code == 401
    listed = client.get("/api/integrations/zapier/keys", headers={"Authorization": "Bearer session"}).json()
    assert "token_hash" not in str(listed) and "api_key" not in str(listed)
    assert client.get("/api/integrations/zapier/me", headers={"Authorization": "Bearer session"}).status_code == 401


@pytest.mark.parametrize("change", [{"active": False}, {"expires_at": "2000-01-01T00:00:00+00:00"}])
def test_revoked_or_expired_keys_fail(setup, change):
    service, client, key = setup
    run(service.db.sirius_zapier_keys.update_one({"id": key["id"]}, {"$set": change}))
    assert client.get("/api/integrations/zapier/me", headers=headers(key)).status_code == 401


def test_disabled_account_and_missing_scopes_fail(setup):
    service, client, key = setup
    run(service.db.sirius_zapier_keys.update_one({"id": key["id"]}, {"$set": {"scopes": ["hooks:write"]}}))
    assert client.get("/api/integrations/zapier/dossiers?title=Projet", headers=headers(key)).status_code == 403
    assert client.post("/api/integrations/zapier/hooks", headers=headers(key), json={
        "event": "meeting.ready", "target_url": "https://hooks.zapier.com/hooks/standard/test",
    }).status_code == 403
    run(service.db.users.update_one({"user_id": "one"}, {"$set": {"disabled": True}}))
    assert client.get("/api/integrations/zapier/me", headers=headers(key)).status_code == 401


@pytest.mark.parametrize("url", [
    "http://hooks.zapier.com/hooks/test", "https://127.0.0.1/hooks/test",
    "https://hooks.zapier.com.evil.example/hooks/test", "https://evil@hooks.zapier.com/hooks/test",
    "https://hooks.zapier.com:444/hooks/test", "https://hooks.zapier.com/hooks/test#secret",
    "https://hooks.zapier.com/hooks/test?secret=x", "https://hooks.zapier.com/other",
    "https://hooks.zapier.com\\@127.0.0.1/hooks/test", "https://hooks.zapier.com/hooks/\ntest",
])
def test_targets_cannot_be_arbitrary_or_redirected(url):
    with pytest.raises(HTTPException):
        hook_url(url)


def test_search_is_owner_only_minimal_and_exact(setup):
    service, client, key = setup
    dossier(service)
    dossier(service, "foreign", "other")
    dossier(service, "different", title="Projet voisin")
    result = client.get("/api/integrations/zapier/dossiers?title=Projet", headers=headers(key))
    assert [item["id"] for item in result.json()] == ["d1"]
    assert "sources" not in result.text and "user_id" not in result.text
    assert client.get("/api/integrations/zapier/dossiers?id=foreign", headers=headers(key)).json() == []
    assert client.get("/api/integrations/zapier/dossiers", headers=headers(key)).status_code == 422


def test_note_is_visible_in_existing_dossier_and_retry_does_not_duplicate(setup):
    service, client, key = setup
    dossier(service)
    body = {"dossier_id": "d1", "text": "Verifier", "request_id": str(uuid.uuid4())}
    first = client.post("/api/integrations/zapier/notes", headers=headers(key), json=body)
    second = client.post("/api/integrations/zapier/notes", headers=headers(key), json=body)
    assert first.status_code == 200 and first.json() == second.json()
    assert len(run(service.db.sirius_work_dossiers.find_one({"id": "d1"}))["notes"]) == 1
    assert client.post("/api/integrations/zapier/notes", headers=headers(key),
                       json={**body, "text": "Different"}).status_code == 409
    assert client.post("/api/integrations/zapier/notes", headers=headers(key),
                       json={**body, "text": " "}).status_code == 422
    dossier(service, "foreign", "other")
    assert client.post("/api/integrations/zapier/notes", headers=headers(key),
                       json={**body, "dossier_id": "foreign"}).status_code == 404


def test_note_concurrent_updates_never_drop_notes_or_duplicate_ids(setup):
    service, _, key = setup
    dossier(service)
    saved = run(service.db.sirius_zapier_keys.find_one({"id": key["id"]}))
    body = NoteIn(dossier_id="d1", text="same", request_id=uuid.uuid4())
    async def race():
        return await asyncio.gather(service.note(saved, body), service.note(saved, body))
    assert run(race())[0]["id"] == str(body.request_id)
    assert len(run(service.db.sirius_work_dossiers.find_one({"id": "d1"}))["notes"]) == 1


def test_delivery_is_durable_deduplicated_and_minimal(setup):
    service, _, key = setup
    dossier(service, "before")
    hook = subscribe(service, key)
    assert subscribe(service, key) == hook
    dossier(service)
    dossier(service, "foreign", "other")
    seen = []
    def transport(request):
        seen.append(request)
        return httpx.Response(200)
    service.transport = httpx.MockTransport(transport)
    run(service.tick())
    run(service.tick())
    assert len(seen) == 1
    payload = json.loads(seen[0].content)
    assert payload["id"] == "dossier.created:d1"
    assert set(payload) == {"id", "event", "resource_id", "title", "created_at"}
    assert seen[0].headers["X-Sirius-Hook-Secret"] == hook["secret"]
    assert key["api_key"] not in str(seen[0].headers)
    assert run(service.db.sirius_zapier_deliveries.find_one({}))["state"] == "SENT"


def test_meeting_ready_delivers_summary_not_transcript_or_proposed_tasks(setup):
    service, client, key = setup
    subscribe(service, key, "meeting.ready")
    run(service.db.sirius_meetings.insert_one({
        "user_id": "one", "id": "m1", "title": "Point", "state": "READY", "ready_at": now(),
        "capture_complete": False, "result": {"summary": "Resume", "tasks": [{"text": "private"}]},
        "fragments": {"0": {"text": "private transcription"}}, "participants": ["private"],
    }))
    seen = []
    service.transport = httpx.MockTransport(lambda request: (seen.append(request), httpx.Response(200))[1])
    run(service.tick())
    payload = json.loads(seen[0].content)
    assert payload["summary"] == "Resume" and payload["capture_complete"] is False
    assert "private" not in seen[0].content.decode()
    assert client.get("/api/integrations/zapier/samples/meeting.ready", headers=headers(key)).json() == [payload]


@pytest.mark.parametrize("status,expected", [(302, "PENDING"), (429, "PENDING"), (500, "PENDING"),
                                                    (400, "FAILED"), (410, "FAILED")])
def test_http_failures_are_visible_and_retries_bounded(setup, status, expected):
    service, _, key = setup
    subscribe(service, key)
    dossier(service)
    seen = []
    service.transport = httpx.MockTransport(lambda request: (seen.append(request), httpx.Response(status))[1])
    run(service.tick())
    delivery = run(service.db.sirius_zapier_deliveries.find_one({}))
    assert delivery["state"] == expected and delivery["attempts"] == 1
    run(service.tick())
    assert len(seen) == 1
    if expected == "PENDING":
        for _ in range(4):
            run(service.db.sirius_zapier_deliveries.update_one(
                {"id": delivery["id"]}, {"$set": {"next_at": "2000-01-01"}}))
            run(service.tick())
        assert len(seen) == 5
        assert run(service.db.sirius_zapier_deliveries.find_one({}))["state"] == "FAILED"
    if status == 410:
        assert run(service.db.sirius_zapier_hooks.find_one({}))["active"] is False


def test_revoke_stops_pending_dispatch_and_unsubscribe_is_key_isolated(setup):
    service, client, key = setup
    hook = subscribe(service, key)
    other = run(service.create_key("one", KeyIn(label="other", scopes=["hooks:write"])))
    assert client.delete("/api/integrations/zapier/hooks/" + hook["id"], headers=headers(other)).status_code == 404
    dossier(service)
    assert client.delete("/api/integrations/zapier/keys/" + key["id"],
                         headers={"Authorization": "Bearer session"}).status_code == 200
    seen = []
    service.transport = httpx.MockTransport(lambda request: (seen.append(request), httpx.Response(200))[1])
    run(service.tick())
    assert seen == []

def test_unsubscribe_resubscribe_rotates_secret_and_does_not_replay_old_sources(setup):
    service, client, key = setup
    first = subscribe(service, key)
    dossier(service, "before")
    saved_hook = run(service.db.sirius_zapier_hooks.find_one({"id": first["id"]}))
    run(service.discover(saved_hook))
    assert client.delete("/api/integrations/zapier/hooks/" + first["id"], headers=headers(key)).status_code == 200
    second = subscribe(service, key)
    assert second["id"] == first["id"] and second["secret"] != first["secret"]
    dossier(service, "after")
    seen = []
    service.transport = httpx.MockTransport(lambda request: (seen.append(request), httpx.Response(200))[1])
    run(service.tick())
    assert [json.loads(request.content)["resource_id"] for request in seen] == ["after"]
    assert run(service.db.sirius_zapier_deliveries.find_one({"resource_id": "before"}))["state"] == "CANCELLED"
    listed = client.get("/api/integrations/zapier/hooks", headers={"Authorization": "Bearer session"})
    assert listed.status_code == 200 and "secret" not in listed.text and "target_url" not in listed.text


def test_transient_network_error_and_deleted_source_are_not_silent(setup):
    service, _, key = setup
    subscribe(service, key)
    dossier(service)
    def fail(request):
        raise httpx.ReadTimeout("uncertain", request=request)
    service.transport = httpx.MockTransport(fail)
    run(service.tick())
    delivery = run(service.db.sirius_zapier_deliveries.find_one({}))
    assert delivery["state"] == "PENDING" and delivery["error"] == "ReadTimeout"
    run(service.db.sirius_work_dossiers.delete_one({"id": "d1"}))
    run(service.db.sirius_zapier_deliveries.update_one({"id": delivery["id"]},
                                                      {"$set": {"next_at": "2000-01-01"}}))
    run(service.tick())
    assert run(service.db.sirius_zapier_deliveries.find_one({}))["state"] == "CANCELLED"



def test_expired_worker_lease_recovers_without_unbounded_replay(setup):
    service, _, key = setup
    hook = subscribe(service, key)
    dossier(service)
    saved_hook = run(service.db.sirius_zapier_hooks.find_one({"id": hook["id"]}))
    run(service.discover(saved_hook))
    run(service.db.sirius_zapier_deliveries.update_one({}, {"$set": {
        "state": "SENDING", "attempts": 5, "next_at": "2000-01-01",
    }}))
    seen = []
    service.transport = httpx.MockTransport(lambda request: (seen.append(request), httpx.Response(200))[1])
    run(service.tick())
    assert not seen
    exhausted = run(service.db.sirius_zapier_deliveries.find_one({}))
    assert exhausted["state"] == "FAILED" and exhausted["attempts"] == 5


def test_sweeps_paginate_and_late_commits_are_not_lost(setup):
    service, _, key = setup
    hook = subscribe(service, key)
    for index in range(55):
        dossier(service, str(index))
    run(service.discover(run(service.db.sirius_zapier_hooks.find_one({"id": hook["id"]}))))
    assert run(service.db.sirius_zapier_deliveries.count_documents({})) == 50
    run(service.discover(run(service.db.sirius_zapier_hooks.find_one({"id": hook["id"]}))))
    assert run(service.db.sirius_zapier_deliveries.count_documents({})) == 55
    dossier(service, "late", created_at=run(service.db.sirius_work_dossiers.find_one({"id": "0"}))["created_at"])
    run(service.discover(run(service.db.sirius_zapier_hooks.find_one({"id": hook["id"]}))))
    run(service.discover(run(service.db.sirius_zapier_hooks.find_one({"id": hook["id"]}))))
    assert run(service.db.sirius_zapier_deliveries.count_documents({})) == 56


def test_rate_limit_and_privacy_collections(setup):
    service, client, key = setup
    for _ in range(60):
        assert client.get("/api/integrations/zapier/me", headers=headers(key)).status_code == 200
    response = client.get("/api/integrations/zapier/me", headers=headers(key))
    assert response.status_code == 429 and response.headers["Retry-After"] == "60"
    assert {"sirius_zapier_keys", "sirius_zapier_hooks", "sirius_zapier_deliveries",
            "sirius_zapier_limits"}.issubset(PERSONAL_COLLECTIONS)


def test_expired_license_blocks_key_usage_and_dispatch_but_not_revocation(setup):
    import access_gate
    from provider_access import utc_now
    service, client, key = setup
    subscribe(service, key)
    dossier(service)
    run(service.db.users.update_one({"user_id": "one"}, {"$set": {
        "role": "user", "trial_started_at": utc_now() - timedelta(days=30),
    }}))
    access_gate.reset_cache()
    assert client.get("/api/integrations/zapier/me", headers=headers(key)).status_code == 402
    seen = []
    service.transport = httpx.MockTransport(lambda request: (seen.append(request), httpx.Response(200))[1])
    run(service.tick())
    assert not seen
    assert run(service.db.sirius_zapier_hooks.find_one({}))["active"] is True
    assert run(service.db.sirius_zapier_hooks.find_one({}))["paused_reason"]
    assert client.delete("/api/integrations/zapier/keys/" + key["id"],
                         headers={"Authorization": "Bearer session"}).status_code == 200
    assert access_gate.is_open_path("/api/integrations/zapier/keys/" + key["id"])


def test_export_redacts_credentials_targets_and_other_accounts(setup, monkeypatch):
    import auth_api
    service, _, key = setup
    hook = subscribe(service, key)
    run(service.db.sirius_zapier_keys.insert_one({"user_id": "other", "id": "foreign", "label": "hidden"}))
    monkeypatch.setattr(auth_api, "require_user", AsyncMock(return_value={"user_id": "one"}))
    endpoint = next(route.endpoint for route in auth_api.make_auth_router(service.db).routes
                    if route.path == "/auth/privacy/export")
    async def export():
        response = await endpoint(SimpleNamespace())
        return b"".join([chunk async for chunk in response.body_iterator])
    with zipfile.ZipFile(io.BytesIO(run(export()))) as archive:
        data = archive.read("sirius-personal-data.json").decode()
    assert key["api_key"] not in data and hook["secret"] not in data
    assert "token_hash" not in data and "target_url" not in data and "hidden" not in data
    assert "sirius_zapier_keys" in data and "sirius_zapier_hooks" in data
