import asyncio
from datetime import datetime, timezone

import bcrypt
import pytest
from fastapi import HTTPException

import auth_api


class Result:
    def __init__(self, modified=0, deleted=0):
        self.modified_count = modified
        self.deleted_count = deleted


class Collection:
    def __init__(self):
        self.documents = []

    async def create_index(self, *args, **kwargs):
        return None

    async def find_one(self, query, *args, **kwargs):
        for document in self.documents:
            if matches(document, query):
                return dict(document)
        return None

    async def insert_one(self, document):
        self.documents.append(dict(document))
        return Result(modified=1)

    async def update_one(self, query, update, upsert=False):
        for document in self.documents:
            if matches(document, query):
                apply_update(document, update)
                return Result(modified=1)
        if upsert:
            document = {key: value for key, value in query.items() if not isinstance(value, dict)}
            apply_update(document, update)
            self.documents.append(document)
            return Result(modified=1)
        return Result()

    async def delete_one(self, query):
        for index, document in enumerate(self.documents):
            if matches(document, query):
                self.documents.pop(index)
                return Result(deleted=1)
        return Result()


class Database:
    def __init__(self):
        self.users = Collection()
        self.login_attempts = Collection()
        self.password_reset_codes = Collection()


def matches(document, query):
    for key, expected in query.items():
        actual = document.get(key)
        if isinstance(expected, dict) and "$ne" in expected:
            if actual == expected["$ne"]:
                return False
        elif actual != expected:
            return False
    return True


def apply_update(document, update):
    document.update(update.get("$set", {}))
    for key, amount in update.get("$inc", {}).items():
        document[key] = int(document.get(key) or 0) + amount


def endpoint(router, path):
    return next(route.endpoint for route in router.routes if route.path == path)


def test_seed_admin_hashes_and_reconciles_password(monkeypatch):
    db = Database()
    monkeypatch.setenv("ADMIN_EMAIL", "admin@example.test")
    monkeypatch.setenv("ADMIN_PASSWORD", "first-password")
    asyncio.run(auth_api.seed_admin_and_indexes(db))
    admin = db.users.documents[0]
    assert admin["role"] == "admin"
    assert bcrypt.checkpw(b"first-password", admin["password_hash"].encode())

    monkeypatch.setenv("ADMIN_PASSWORD", "second-password")
    asyncio.run(auth_api.seed_admin_and_indexes(db))
    assert len(db.users.documents) == 1
    assert bcrypt.checkpw(b"second-password", db.users.documents[0]["password_hash"].encode())


def test_register_login_and_lockout():
    db = Database()
    router = auth_api.make_auth_router(db)
    register = endpoint(router, "/auth/register")
    login = endpoint(router, "/auth/login")

    from starlette.responses import Response

    created = asyncio.run(register(
        auth_api.RegisterRequest(email="Client@Example.test", password="Secret#2026", name="Client"),
        Response(),
    ))
    assert created["email"] == "client@example.test"
    assert created["user_id"].startswith("user_")
    assert "password_hash" not in created

    logged_in = asyncio.run(login(
        auth_api.LoginRequest(email="client@example.test", password="Secret#2026"),
        Response(),
    ))
    assert logged_in["email"] == "client@example.test"
    assert logged_in["access_token"]

    for _ in range(5):
        with pytest.raises(HTTPException) as failure:
            asyncio.run(login(auth_api.LoginRequest(email="other@example.test", password="wrong"), Response()))
        assert failure.value.status_code == 401
    with pytest.raises(HTTPException) as locked:
        asyncio.run(login(auth_api.LoginRequest(email="other@example.test", password="wrong"), Response()))
    assert locked.value.status_code == 429


def test_password_reset_code_is_hashed_and_changes_password(monkeypatch):
    db = Database()
    router = auth_api.make_auth_router(db)
    register = endpoint(router, "/auth/register")
    request_reset = endpoint(router, "/auth/password-reset/request")
    confirm_reset = endpoint(router, "/auth/password-reset/confirm")
    login = endpoint(router, "/auth/login")

    from starlette.responses import Response

    asyncio.run(register(
        auth_api.RegisterRequest(email="reset@example.test", password="OldSecret1", name="Reset"),
        Response(),
    ))
    delivered = {}

    async def fake_send(email, code):
        delivered.update(email=email, code=code)

    monkeypatch.setattr(auth_api, "_send_reset_email", fake_send)
    response = asyncio.run(request_reset(auth_api.PasswordResetRequest(email="reset@example.test")))
    assert response["ok"] is True
    assert delivered["email"] == "reset@example.test"
    record = db.password_reset_codes.documents[0]
    assert delivered["code"] not in record["code_hash"]
    assert record["expires_at"] > datetime.now(timezone.utc)

    asyncio.run(confirm_reset(auth_api.PasswordResetConfirm(
        email="reset@example.test", code=delivered["code"], password="NewSecret1",
    )))
    logged_in = asyncio.run(login(
        auth_api.LoginRequest(email="reset@example.test", password="NewSecret1"),
        Response(),
    ))
    assert logged_in["email"] == "reset@example.test"
