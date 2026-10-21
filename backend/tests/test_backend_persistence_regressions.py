"""Regressions exercised against real local persistence and serialized Mongo dates."""
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth_api
import personal_mail
from local_docstore import LocalDocStore
from test_auth_api_unit import Database


@pytest.fixture(params=["sqlite", "mongo-naive"])
def auth_db(request, tmp_path):
    if request.param == "sqlite":
        return LocalDocStore(tmp_path / "auth.db")
    return Database()


def auth_client(db):
    app = FastAPI()
    app.include_router(auth_api.make_auth_router(db))
    return TestClient(app)


def mongo_dates(db, collection):
    if isinstance(db, Database):
        for document in getattr(db, collection).documents:
            for field, value in document.items():
                if isinstance(value, datetime):
                    document[field] = value.replace(tzinfo=None)


def test_persisted_login_lockout_returns_429(auth_db):
    client = auth_client(auth_db)
    for _ in range(5):
        assert client.post("/auth/login", json={"email": "missing@example.test", "password": "invalid"}).status_code == 401
    mongo_dates(auth_db, "login_attempts")
    assert client.post("/auth/login", json={"email": "missing@example.test", "password": "invalid"}).status_code == 429


def test_persisted_reset_request_is_rate_limited(auth_db, monkeypatch):
    asyncio.run(auth_db.users.insert_one({"user_id": "u1", "email": "reset@example.test"}))
    monkeypatch.setattr(auth_api, "_send_reset_email", AsyncMock())
    client = auth_client(auth_db)
    assert client.post("/auth/password-reset/request", json={"email": "reset@example.test"}).status_code == 200
    mongo_dates(auth_db, "password_reset_codes")
    assert client.post("/auth/password-reset/request", json={"email": "reset@example.test"}).status_code == 429


@pytest.mark.parametrize("expired", [False, True])
def test_persisted_reset_code_is_checked(auth_db, monkeypatch, expired):
    asyncio.run(auth_db.users.insert_one({"user_id": "u1", "email": "reset@example.test"}))
    sent = AsyncMock()
    monkeypatch.setattr(auth_api, "_send_reset_email", sent)
    client = auth_client(auth_db)
    assert client.post("/auth/password-reset/request", json={"email": "reset@example.test"}).status_code == 200
    if expired:
        asyncio.run(auth_db.password_reset_codes.update_one(
            {"email": "reset@example.test"},
            {"$set": {"expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)}},
        ))
    mongo_dates(auth_db, "password_reset_codes")
    response = client.post("/auth/password-reset/confirm", json={
        "email": "reset@example.test", "code": sent.call_args.args[1], "password": "new-password",
    })
    assert response.status_code == (400 if expired else 200)
    if not expired:
        user = asyncio.run(auth_db.users.find_one({"user_id": "u1"}))
        assert auth_api._password_valid("new-password", user["password_hash"])
        assert asyncio.run(auth_db.password_reset_codes.find_one({"email": "reset@example.test"})) is None


def test_local_explicit_id_survives_insert_update_and_delete(tmp_path):
    db = LocalDocStore(tmp_path / "identity.db")
    document = {"_id": "u1", "value": 1}
    asyncio.run(db.preferences.insert_one(document))
    assert document == {"_id": "u1", "value": 1}
    assert asyncio.run(db.preferences.find_one({"_id": "u1"})) == document
    asyncio.run(db.preferences.update_one({"_id": "u1"}, {"$set": {"value": 2}}, upsert=True))
    assert asyncio.run(db.preferences.count_documents({})) == 1
    assert asyncio.run(db.preferences.find_one({"_id": "u1"}))["value"] == 2
    assert asyncio.run(db.preferences.delete_one({"_id": "u1"})).deleted_count == 1
    saved, created = asyncio.run(db.preferences.insert_once(
        {"_id": "stable", "user_id": "u1", "value": 3}, {"user_id": "u1"},
    ))
    assert created and saved["_id"] == "stable"
    assert asyncio.run(db.preferences.find_one({"_id": "stable"}))["value"] == 3


def test_personal_mail_connection_persists_for_each_local_account(tmp_path, monkeypatch):
    db = LocalDocStore(tmp_path / "mail.db")
    uid = AsyncMock(return_value="u1")
    monkeypatch.setattr(personal_mail, "resolve_user_id", uid)
    monkeypatch.setattr(personal_mail, "_public_host", lambda *args: None)
    monkeypatch.setattr(personal_mail, "_check_login", lambda *args: None)
    monkeypatch.setattr(personal_mail, "_rate_limited", lambda *args: False)
    app = FastAPI()
    app.include_router(personal_mail.make_personal_mail_router(db))
    client = TestClient(app)
    assert client.post("/personal-mail/connect", json={"email": "lea@free.fr", "password": "fake-password"}).status_code == 200
    assert client.get("/personal-mail/status").json()["connected"] is True
    uid.return_value = "u2"
    assert client.get("/personal-mail/status").json() == {"connected": False}
    assert client.post("/personal-mail/connect", json={"email": "paul@orange.fr", "password": "other-fake-password"}).status_code == 200
    uid.return_value = "u1"
    assert client.get("/personal-mail/status").json()["email"] == "lea@free.fr"
    client.post("/personal-mail/disconnect")
    assert client.get("/personal-mail/status").json() == {"connected": False}
    uid.return_value = "u2"
    assert client.get("/personal-mail/status").json()["email"] == "paul@orange.fr"
