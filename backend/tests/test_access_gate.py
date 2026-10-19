import asyncio
from datetime import timedelta

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import access_gate
import auth_api
import cloud_link
from local_docstore import LocalDocStore
from provider_access import utc_now


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.delenv("SIRIUS_PACKAGED", raising=False)
    monkeypatch.delenv("SIRIUS_CLOUD_RELAY", raising=False)
    access_gate.reset_cache()
    return LocalDocStore(str(tmp_path / "access.db"))


def account(uid="u-1", days_ago=0, role="user"):
    return {"user_id": uid, "email": f"{uid}@example.test", "role": role,
            "trial_started_at": utc_now() - timedelta(days=days_ago)}


def app_for(db):
    app = FastAPI()

    @app.get("/api/chat/ping")
    async def ping():
        return {"ok": True}

    @app.get("/api/auth/privacy/export")
    async def export():
        return {"ok": True}

    app.include_router(access_gate.make_access_router(db), prefix="/api")
    app.add_middleware(access_gate.AccessGateMiddleware, db=db)
    return TestClient(app)


def client_for(db, user):
    asyncio.run(db.users.insert_one(dict(user)))
    client = app_for(db)
    token = auth_api.create_access_token(user["user_id"], user["email"], user["role"])
    client.headers["Authorization"] = f"Bearer {token}"
    return client


def test_trial_then_lock_after_fifteen_days(db):
    assert client_for(db, account("active", days_ago=3)).get("/api/chat/ping").status_code == 200
    expired = client_for(db, account("expired", days_ago=16))
    blocked = expired.get("/api/chat/ping")
    assert blocked.status_code == 402
    assert "15 jours" in blocked.json()["detail"]
    assert blocked.json()["access"]["state"] == "expired"
    assert expired.get("/api/auth/privacy/export").status_code == 200
    assert expired.get("/api/access/status").json()["state"] == "expired"


def test_admin_is_never_locked(db):
    assert client_for(db, account("boss", days_ago=90, role="admin")).get("/api/chat/ping").status_code == 200


@pytest.mark.parametrize("license_doc,allowed", [
    ({"tier": "lifetime", "status": "active"}, True),
    ({"tier": "standard", "status": "refunded"}, False),
    ({"tier": "monthly", "status": "active", "expires_at": (utc_now() + timedelta(days=20)).isoformat()}, True),
    ({"tier": "monthly", "status": "past_due", "expires_at": (utc_now() - timedelta(days=1)).isoformat()}, True),
    ({"tier": "monthly", "status": "active", "expires_at": (utc_now() - timedelta(days=5)).isoformat()}, False),
    ({"tier": "monthly", "status": "canceled", "expires_at": (utc_now() + timedelta(days=5)).isoformat()}, False),
])
def test_store_license_bought_with_account_email_unlocks(db, license_doc, allowed):
    user = account("buyer", days_ago=30)
    asyncio.run(db.user_licenses.insert_one({"user_id": user["email"], **license_doc}))
    response = client_for(db, user).get("/api/chat/ping")
    assert (response.status_code == 200) is allowed


def test_unauthenticated_requests_are_left_to_routes(db):
    assert app_for(db).get("/api/chat/ping").status_code == 200


@pytest.fixture
def packaged(tmp_path, monkeypatch, db):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIRIUS_PACKAGED", "1")
    monkeypatch.setenv("SIRIUS_CLOUD_URL", "https://cloud.test")
    replies = {"status": 200, "json": {"state": "trial", "trial": {"state": "active"}}}
    calls = []

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(replies["status"], json=replies["json"])

    monkeypatch.setattr(cloud_link, "transport", httpx.MockTransport(handler))
    yield replies, calls
    monkeypatch.setattr(cloud_link, "transport", None)


def test_pc_requires_a_linked_cloud_account(db, packaged):
    client = client_for(db, account("local", role="admin"))
    response = client.get("/api/chat/ping")
    assert response.status_code == 402
    assert response.json()["access"]["state"] == "unlinked"


def test_pc_follows_cloud_status_with_cache_and_offline_grace(db, packaged):
    replies, calls = packaged
    cloud_link._save_state({"email": "lea@example.test", "access_token": "acc"})
    client = client_for(db, account("local", role="admin"))
    assert client.get("/api/chat/ping").status_code == 200
    assert client.get("/api/chat/ping").status_code == 200
    assert calls == ["/api/access/status"]

    replies.update(status=200, json={"state": "expired", "detail": "Essai terminé."})
    expired = client.get("/api/access/status?refresh=true").json()
    assert expired["state"] == "expired" and expired["allowed"] is False
    assert client.get("/api/chat/ping").status_code == 402

    replies.update(status=200, json={"state": "licensed"})
    assert client.get("/api/access/status?refresh=true").json()["allowed"] is True
    replies.update(status=503, json={"detail": "panne"})
    offline = client.get("/api/access/status?refresh=true").json()
    assert offline["allowed"] is True and offline["offline"] is True


def test_pc_without_cache_is_locked_when_cloud_is_unreachable(db, packaged):
    replies, _ = packaged
    cloud_link._save_state({"email": "lea@example.test", "access_token": "acc"})
    replies.update(status=503, json={"detail": "panne"})
    status = client_for(db, account("local", role="admin")).get("/api/access/status").json()
    assert status["state"] == "offline" and status["allowed"] is False
