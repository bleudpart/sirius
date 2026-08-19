"""Authentication, cookie, per-user isolation, and requested regression API tests."""
import asyncio
import os
import re
import sqlite3
import sys
import uuid
from pathlib import Path

import bcrypt
import pytest
import requests
from dotenv import dotenv_values
from pymongo import MongoClient

FRONTEND_ENV = dotenv_values("/app/frontend/.env")
BACKEND_ENV = dotenv_values("/app/backend/.env")
BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or FRONTEND_ENV.get("REACT_APP_BACKEND_URL", "")).rstrip("/")
if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL is missing")

CREDENTIALS_PATH = Path("/app/memory/test_credentials.md")
SQLITE_PATH = Path("/app/backend/sirius_local.db")


def _credentials():
    if not CREDENTIALS_PATH.exists():
        pytest.skip("Missing /app/memory/test_credentials.md")
    text = CREDENTIALS_PATH.read_text(encoding="utf-8")
    email = re.search(r"(?im)^- Email\s*:\s*(\S+)", text)
    password = re.search(r"(?im)^- Mot de passe\s*:\s*(\S+)", text)
    if not email or not password:
        pytest.skip("Admin email/password missing from test_credentials.md")
    return email.group(1), password.group(1)


def _register(label):
    session = requests.Session()
    email = f"test_auth_{label.lower()}_{uuid.uuid4().hex[:10]}@example.com"
    payload = {"email": email, "password": "Test#2026!", "name": f"TEST {label}"}
    response = session.post(f"{BASE_URL}/api/auth/register", json=payload, timeout=30)
    assert response.status_code == 200, response.text
    return {"session": session, "email": email, "password": payload["password"], "name": payload["name"], "response": response, "user": response.json()}


@pytest.fixture(scope="module")
def accounts():
    created = {"a": _register("Alpha"), "b": _register("Beta"), "logout": _register("Logout")}
    yield created

    # Remove only this suite's TEST data from local persistence after API checks.
    mongo_url = BACKEND_ENV.get("MONGO_URL")
    db_name = BACKEND_ENV.get("DB_NAME")
    if mongo_url and db_name:
        client = MongoClient(mongo_url, serverSelectionTimeoutMS=3000)
        db = client[db_name]
        db.users.delete_many({"email": {"$regex": "^test_auth_"}})
        db.login_attempts.delete_many({"identifier": {"$regex": "test_auth_"}})
        client.close()
    if SQLITE_PATH.exists():
        with sqlite3.connect(SQLITE_PATH) as connection:
            connection.execute("DELETE FROM facts WHERE text LIKE 'TEST_AUTH_%'")


class TestAuthenticationAPI:
    """Email/password registration, login, profile, cookies, and logout."""

    def test_register_returns_public_profile_and_http_only_cookies(self, accounts):
        item = accounts["a"]
        response = item["response"]
        data = response.json()
        assert data["email"] == item["email"]
        assert data["name"] == item["name"]
        assert data["provider"] == "email"
        assert isinstance(data["user_id"], str) and data["user_id"].startswith("user_")
        assert data["preferences"] == {}
        assert "password" not in data and "password_hash" not in data and "_id" not in data
        cookies = response.headers.get("set-cookie", "").lower()
        assert "access_token=" in cookies and "refresh_token=" in cookies
        assert cookies.count("httponly") >= 2
        assert cookies.count("secure") >= 2
        assert cookies.count("samesite=none") >= 2

    def test_register_rejects_short_password_and_duplicate_email(self, accounts):
        short = requests.post(
            f"{BASE_URL}/api/auth/register",
            json={"email": f"test_short_{uuid.uuid4().hex[:8]}@example.com", "password": "12345", "name": "TEST short"},
            timeout=20,
        )
        assert short.status_code == 400
        assert "6" in short.json().get("detail", "")
        duplicate = requests.post(
            f"{BASE_URL}/api/auth/register",
            json={"email": accounts["a"]["email"], "password": "Another#2026", "name": "Duplicate"},
            timeout=20,
        )
        assert duplicate.status_code == 409
        assert "existe" in duplicate.json().get("detail", "").lower()

    def test_admin_login_and_wrong_password(self):
        email, password = _credentials()
        session = requests.Session()
        good = session.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=30)
        assert good.status_code == 200, good.text
        assert good.json()["email"] == email
        assert good.json()["name"] == "Daniel"
        assert session.cookies.get("access_token")
        assert session.cookies.get("refresh_token")
        bad = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": "wrong-TEST-once"}, timeout=30)
        assert bad.status_code == 401
        assert "incorrect" in bad.json().get("detail", "").lower()

    def test_five_failures_trigger_lockout_for_disposable_email(self):
        email = f"test_auth_lock_{uuid.uuid4().hex[:10]}@example.com"
        session = requests.Session()
        statuses = []
        for _ in range(5):
            response = session.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": "wrong"}, timeout=20)
            statuses.append(response.status_code)
        assert statuses == [401, 401, 401, 401, 401]
        locked = session.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": "wrong"}, timeout=20)
        assert locked.status_code == 429, locked.text
        assert "15 minutes" in locked.json().get("detail", "")

    def test_me_requires_cookie_and_returns_profile_with_cookie(self, accounts):
        unauthenticated = requests.get(f"{BASE_URL}/api/auth/me", timeout=20)
        assert unauthenticated.status_code == 401
        assert "authentifi" in unauthenticated.json().get("detail", "").lower()
        authenticated = accounts["a"]["session"].get(f"{BASE_URL}/api/auth/me", timeout=20)
        assert authenticated.status_code == 200
        assert authenticated.json()["user_id"] == accounts["a"]["user"]["user_id"]
        assert authenticated.json()["email"] == accounts["a"]["email"]

    def test_profile_update_persists_name_and_preferences(self, accounts):
        item = accounts["a"]
        payload = {"name": "TEST Alpha Modifié", "preferences": {"notes": "TEST notes persistantes", "concise": True}}
        updated = item["session"].put(f"{BASE_URL}/api/auth/profile", json=payload, timeout=20)
        assert updated.status_code == 200, updated.text
        assert updated.json()["name"] == payload["name"]
        assert updated.json()["preferences"] == payload["preferences"]
        fetched = item["session"].get(f"{BASE_URL}/api/auth/me", timeout=20)
        assert fetched.status_code == 200
        assert fetched.json()["name"] == payload["name"]
        assert fetched.json()["preferences"] == payload["preferences"]

    def test_logout_deletes_cookies_and_session_is_rejected(self, accounts):
        session = accounts["logout"]["session"]
        logout = session.post(f"{BASE_URL}/api/auth/logout", timeout=20)
        assert logout.status_code == 200 and logout.json() == {"ok": True}
        cookie_headers = logout.headers.get("set-cookie", "").lower()
        assert "access_token=" in cookie_headers and "refresh_token=" in cookie_headers
        assert "max-age=0" in cookie_headers
        assert session.get(f"{BASE_URL}/api/auth/me", timeout=20).status_code == 401


class TestPerUserIsolation:
    """SQLite local-memory and Google Calendar token isolation by authenticated user."""

    def test_local_memory_fact_is_visible_only_to_owner(self, accounts):
        text = f"TEST_AUTH_fact_owner_A_{uuid.uuid4().hex[:8]}"
        created = accounts["a"]["session"].post(
            f"{BASE_URL}/api/local-memory", json={"category": "souvenir", "text": text}, timeout=20
        )
        assert created.status_code == 200, created.text
        fact = created.json()
        assert fact["text"] == text and fact["category"] == "souvenir"
        b_facts = accounts["b"]["session"].get(f"{BASE_URL}/api/local-memory", timeout=20)
        assert b_facts.status_code == 200
        assert all(entry.get("text") != text for entry in b_facts.json()["facts"])
        a_facts = accounts["a"]["session"].get(f"{BASE_URL}/api/local-memory", timeout=20)
        assert a_facts.status_code == 200
        assert any(entry.get("id") == fact["id"] and entry.get("text") == text for entry in a_facts.json()["facts"])

    def test_unauthenticated_local_memory_access_is_rejected(self):
        response = requests.get(f"{BASE_URL}/api/local-memory", timeout=20)
        assert response.status_code == 401, "User memory is exposed through the legacy fallback without authentication"

    def test_user_b_cannot_delete_user_a_fact(self, accounts):
        text = f"TEST_AUTH_cross_delete_{uuid.uuid4().hex[:8]}"
        created = accounts["a"]["session"].post(
            f"{BASE_URL}/api/local-memory", json={"category": "souvenir", "text": text}, timeout=20
        )
        assert created.status_code == 200
        fact_id = created.json()["id"]
        cross_delete = accounts["b"]["session"].delete(f"{BASE_URL}/api/local-memory/{fact_id}", timeout=20)
        assert cross_delete.status_code in (403, 404), "A different authenticated user deleted the owner's fact"
        owner_facts = accounts["a"]["session"].get(f"{BASE_URL}/api/local-memory", timeout=20).json()["facts"]
        assert any(fact.get("id") == fact_id for fact in owner_facts)

    def test_new_account_calendar_status_is_disconnected(self, accounts):
        response = accounts["b"]["session"].get(f"{BASE_URL}/api/calendar/status", timeout=20)
        assert response.status_code == 200
        assert response.json() == {"connected": False}


class TestRequestedRegressions:
    """Health, cortex totals, connectivity, and credentialed CORS regression checks."""

    def test_health(self):
        response = requests.get(f"{BASE_URL}/health", timeout=20)
        assert response.status_code == 200
        assert response.text.strip()

    def test_cortex_stats_has_typed_totals(self):
        response = requests.get(f"{BASE_URL}/api/cortex/stats", timeout=30)
        assert response.status_code == 200, response.text
        totals = response.json().get("totaux")
        assert isinstance(totals, dict)
        assert set(totals) == {"commandes", "aujourdhui", "souvenirs", "conversations", "consultations"}
        assert all(isinstance(value, int) and value >= 0 for value in totals.values())

    def test_pantheon_connectivity_contract(self):
        response = requests.get(f"{BASE_URL}/api/pantheon/connectivity", timeout=30)
        assert response.status_code == 200, response.text
        services = response.json().get("services")
        assert isinstance(services, list) and services
        assert all(isinstance(item.get("name"), str) and item.get("status") in {"CONNECTÉ", "DÉCONNECTÉ"} for item in services)

    def test_credentialed_cors_preflight_uses_request_origin(self):
        origin = "https://qa-auth.example.test"
        response = requests.options(
            f"{BASE_URL}/api/auth/me",
            headers={"Origin": origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "content-type"},
            timeout=20,
        )
        assert response.status_code in (200, 204)
        assert response.headers.get("access-control-allow-origin") == origin
        assert response.headers.get("access-control-allow-credentials") == "true"


class _FakeCollection:
    def __init__(self, document=None):
        self.document = document
        self.updated = []

    async def create_index(self, *args, **kwargs):
        return None

    async def find_one(self, query, *args, **kwargs):
        return dict(self.document) if self.document else None

    async def update_one(self, query, update, **kwargs):
        self.updated.append((query, update))
        if self.document and "$set" in update:
            self.document.update(update["$set"])

    async def insert_one(self, document):
        self.document = dict(document)


class _FakeDB:
    def __init__(self, user):
        self.users = _FakeCollection(user)
        self.login_attempts = _FakeCollection()


def test_seed_admin_updates_existing_stale_password(monkeypatch):
    """Startup seeding must reconcile an existing admin when ADMIN_PASSWORD changes."""
    sys.path.insert(0, "/app/backend")
    from auth_api import seed_admin_and_indexes

    old_hash = bcrypt.hashpw(b"old-password", bcrypt.gensalt()).decode()
    db = _FakeDB({"user_id": "user_existing_admin", "email": "seed-admin@example.test", "password_hash": old_hash})
    monkeypatch.setenv("ADMIN_EMAIL", "seed-admin@example.test")
    monkeypatch.setenv("ADMIN_PASSWORD", "new-password")
    asyncio.run(seed_admin_and_indexes(db))
    assert bcrypt.checkpw(b"new-password", db.users.document["password_hash"].encode()), "Existing admin password hash was not reconciled"
