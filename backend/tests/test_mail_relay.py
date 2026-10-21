import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import cloud_link
import mail_relay

OAUTH_ENV = (
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
    "MICROSOFT_CLIENT_ID", "MICROSOFT_REDIRECT_URI", "MS_TOKEN_KEY", "SIRIUS_MAIL_RELAY",
)


@pytest.fixture
def pc(monkeypatch, tmp_path):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIRIUS_PACKAGED", "1")
    monkeypatch.setenv("SIRIUS_CLOUD_URL", "https://cloud.test")
    for name in OAUTH_ENV:
        monkeypatch.delenv(name, raising=False)
    calls = []

    def reply(request: httpx.Request):
        calls.append(request)
        if request.url.path == "/api/oauth/calendar/login":
            return httpx.Response(200, json={"authorization_url": "https://accounts.google.com/o?x=1"})
        if request.url.path == "/api/microsoft/status":
            return httpx.Response(200, json={"connected": True, "email": "lea@outlook.fr"})
        if request.url.path == "/api/gmail/send":
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(404, json={"detail": "inconnu"})

    monkeypatch.setattr(cloud_link, "transport", httpx.MockTransport(reply))
    app = FastAPI()

    @app.get("/api/calendar/status")
    async def local_status():
        return {"connected": False, "source": "local"}

    @app.get("/api/other")
    async def other():
        return {"source": "local"}

    local = {"value": True}
    app.add_middleware(mail_relay.MailRelayMiddleware, is_direct_local_request=lambda request: local["value"])
    yield TestClient(app), calls, local
    monkeypatch.setattr(cloud_link, "transport", None)


def test_google_login_is_relayed_with_cloud_session_only(pc):
    client, calls, _ = pc
    cloud_link._save_state({"access_token": "cloud-acc"})
    response = client.get("/api/oauth/calendar/login?external=true", headers={"Authorization": "Bearer local-token", "Cookie": "access_token=local"})
    assert response.status_code == 200
    assert response.json()["authorization_url"].startswith("https://accounts.google.com/")
    sent = calls[0]
    assert str(sent.url) == "https://cloud.test/api/oauth/calendar/login?external=true"
    assert sent.headers["authorization"] == "Bearer cloud-acc"
    assert "cookie" not in sent.headers


def test_send_body_and_microsoft_status_are_relayed(pc):
    client, calls, _ = pc
    cloud_link._save_state({"access_token": "cloud-acc"})
    assert client.post("/api/gmail/send", json={"to": "a@b.fr", "subject": "S", "body": "B"}).json() == {"ok": True}
    assert calls[0].method == "POST" and b'"to":"a@b.fr"' in calls[0].content.replace(b" ", b"")
    assert client.get("/api/microsoft/status").json()["email"] == "lea@outlook.fr"


def test_pc_with_own_oauth_apps_stays_local(pc, monkeypatch):
    client, calls, _ = pc
    cloud_link._save_state({"access_token": "cloud-acc"})
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "id")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "secret")
    assert client.get("/api/calendar/status").json()["source"] == "local"
    assert calls == []
    assert mail_relay.status()["google"] == "local"
    assert mail_relay.status()["microsoft"] == "cloud"


def test_cloud_server_and_disabled_flag_never_relay(pc, monkeypatch):
    client, calls, _ = pc
    cloud_link._save_state({"access_token": "cloud-acc"})
    monkeypatch.setenv("SIRIUS_MAIL_RELAY", "0")
    assert client.get("/api/calendar/status").json()["source"] == "local"
    monkeypatch.delenv("SIRIUS_MAIL_RELAY")
    monkeypatch.delenv("SIRIUS_PACKAGED")
    assert client.get("/api/calendar/status").json()["source"] == "local"
    assert calls == []


def test_unlinked_pc_gets_clear_french_message(pc):
    client, calls, _ = pc
    response = client.get("/api/oauth/calendar/login")
    assert response.status_code == 401
    assert "Reliez d'abord votre compte ΣIRIUS" in response.json()["detail"]
    assert calls == []


def test_network_requests_and_unrelated_routes_are_not_relayed(pc):
    client, calls, local = pc
    cloud_link._save_state({"access_token": "cloud-acc"})
    assert client.get("/api/other").json()["source"] == "local"
    local["value"] = False
    assert client.get("/api/microsoft/status").status_code == 403
    assert calls == []


def test_callbacks_never_match_relay_routes():
    assert mail_relay.provider_for("/api/oauth/calendar/callback") == ""
    assert mail_relay.provider_for("/api/auth/callback/microsoft-entra-id") == ""
    assert mail_relay.provider_for("/api/gmail/messages") == "google"
    assert mail_relay.provider_for("/api/auth/microsoft/authorize") == "microsoft"
