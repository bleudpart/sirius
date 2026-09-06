import time

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import auth_api
import server


def test_local_session_sets_hardened_cookies():
    client = TestClient(server.app)

    response = client.post("/api/auth/local-session")

    assert response.status_code == 200
    cookies = response.headers.get("set-cookie", "").lower()
    assert cookies.count("httponly") == 2
    assert cookies.count("samesite=strict") == 2
    assert client.cookies.get("access_token")
    assert client.cookies.get("refresh_token")


def test_local_session_rejects_forwarded_requests():
    client = TestClient(server.app)

    response = client.post(
        "/api/auth/local-session",
        headers={"x-forwarded-for": "127.0.0.1"},
    )

    assert response.status_code == 403


def test_me_requires_a_signed_session():
    response = TestClient(server.app).get("/api/auth/me")

    assert response.status_code == 401


def test_local_session_returns_bearer_token_in_body():
    client = TestClient(server.app)

    response = client.post("/api/auth/local-session")

    assert response.status_code == 200
    assert response.json().get("access_token")


def test_me_accepts_bearer_token_without_cookie():
    # Simule le navigateur qui ne rejoue pas le cookie SameSite cross-site :
    # le header Authorization doit suffire.
    client = TestClient(server.app)
    token = client.post("/api/auth/local-session").json()["access_token"]
    client.cookies.clear()

    response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json()["role"] == "admin"


def test_signed_access_token_rejects_tampering():
    token = auth_api.create_access_token("user", "user@example.test")
    encoded, signature = token.split(".", 1)

    with pytest.raises(HTTPException) as raised:
        auth_api._decode_token(f"{encoded}.{signature[:-1]}x")

    assert raised.value.status_code == 401


def test_signed_access_token_rejects_expiry(monkeypatch):
    token = auth_api.create_access_token("user", "user@example.test")
    monkeypatch.setattr(time, "time", lambda: 10**12)

    with pytest.raises(HTTPException) as raised:
        auth_api._decode_token(token)

    assert raised.value.status_code == 401
