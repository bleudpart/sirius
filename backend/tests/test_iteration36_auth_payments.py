"""Iteration 36: auth fixes, user isolation, chat isolation, and Stripe/PDF/email regressions."""
import asyncio
import os
import re
import socket
import sqlite3
import sys
import uuid
from pathlib import Path

import bcrypt
import pytest
import requests
from aiosmtpd.controller import Controller
from dotenv import dotenv_values
from pymongo import MongoClient

FRONTEND_ENV = dotenv_values("/app/frontend/.env")
BACKEND_ENV = dotenv_values("/app/backend/.env")
BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or FRONTEND_ENV.get("REACT_APP_BACKEND_URL", "")).rstrip("/")
if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL is missing")

CREDENTIALS_PATH = Path("/app/memory/test_credentials.md")
SQLITE_PATH = Path("/app/backend/sirius_local.db")
RUN_ID = uuid.uuid4().hex[:10]
TEST_PREFIX = f"TEST_ITER36_{RUN_ID}"


def admin_credentials():
    if not CREDENTIALS_PATH.exists():
        pytest.skip("Missing /app/memory/test_credentials.md")
    text = CREDENTIALS_PATH.read_text(encoding="utf-8")
    email = re.search(r"(?im)^- Email\s*:\s*(\S+)", text)
    password = re.search(r"(?im)^- Mot de passe\s*:\s*(\S+)", text)
    if not email or not password:
        pytest.skip("Admin credentials missing from test_credentials.md")
    return email.group(1), password.group(1)


def register_account(label):
    session = requests.Session()
    email = f"test_iter36_{RUN_ID}_{label.lower()}@example.com"
    password = "Test#Iter36!"
    response = session.post(
        f"{BASE_URL}/api/auth/register",
        json={"email": email, "password": password, "name": f"{TEST_PREFIX}_{label}"},
        timeout=30,
    )
    assert response.status_code == 200, response.text
    return {
        "session": session,
        "email": email,
        "password": password,
        "user": response.json(),
        "register_response": response,
    }


@pytest.fixture(scope="module")
def mongo_db():
    client = MongoClient(BACKEND_ENV["MONGO_URL"], serverSelectionTimeoutMS=5000)
    db = client[BACKEND_ENV["DB_NAME"]]
    yield db
    client.close()


@pytest.fixture(scope="module")
def accounts(mongo_db):
    data = {"a": register_account("Alpha"), "b": register_account("Beta"), "auth": register_account("Auth")}
    yield data
    for item in data.values():
        item["session"].close()

    # Remove only records created by this suite.
    user_ids = [item["user"]["user_id"] for item in data.values()]
    mongo_db.users.delete_many({"user_id": {"$in": user_ids}})
    mongo_db.login_attempts.delete_many({"identifier": {"$regex": f"test_iter36_{RUN_ID}"}})
    mongo_db.sirius_chats.delete_many({"session_id": {"$regex": f"{RUN_ID}"}})
    mongo_db.agora_deals.delete_many({"nom": {"$regex": f"^{TEST_PREFIX}"}})
    mongo_db.payment_transactions.delete_many({"$or": [
        {"deal_nom": {"$regex": f"^{TEST_PREFIX}"}},
        {"session_id": {"$regex": f"^{TEST_PREFIX}"}},
    ]})
    if SQLITE_PATH.exists():
        with sqlite3.connect(SQLITE_PATH) as connection:
            connection.execute("DELETE FROM facts WHERE text LIKE ?", (f"{TEST_PREFIX}%",))


@pytest.fixture(scope="module", autouse=True)
def cleanup_lockout_records(mongo_db):
    yield
    mongo_db.login_attempts.delete_many({"identifier": {"$regex": f"test_iter36_{RUN_ID}"}})


# Authentication basics, cookies, refresh, normalized-email lockout, and CORS on a real response.
class TestAuthenticationAndCors:
    def test_admin_hash_format_and_login(self, mongo_db):
        email, password = admin_credentials()
        admin = mongo_db.users.find_one({"email": email.lower()})
        assert admin is not None
        assert isinstance(admin.get("password_hash"), str)
        assert admin["password_hash"].startswith("$2b$")
        response = requests.post(
            f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=30
        )
        assert response.status_code == 200, response.text
        assert response.json()["email"] == email.lower()
        cookies = response.headers.get("set-cookie", "").lower()
        assert "access_token=" in cookies and "refresh_token=" in cookies
        assert cookies.count("httponly") >= 2

    def test_wrong_password_is_401(self, accounts):
        item = accounts["auth"]
        response = requests.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": item["email"], "password": "definitely-wrong"},
            timeout=30,
        )
        assert response.status_code == 401
        assert "incorrect" in response.json().get("detail", "").lower()

    def test_profile_me_refresh_logout_flow(self, accounts):
        item = accounts["auth"]
        session = item["session"]
        me = session.get(f"{BASE_URL}/api/auth/me", timeout=30)
        assert me.status_code == 200
        assert me.json()["user_id"] == item["user"]["user_id"]

        profile = session.put(
            f"{BASE_URL}/api/auth/profile",
            json={"name": f"{TEST_PREFIX}_Updated", "preferences": {"qa": RUN_ID}},
            timeout=30,
        )
        assert profile.status_code == 200, profile.text
        assert profile.json()["name"] == f"{TEST_PREFIX}_Updated"
        assert profile.json()["preferences"] == {"qa": RUN_ID}

        # Remove only the access cookie; refresh must issue a new access cookie.
        for cookie in list(session.cookies):
            if cookie.name == "access_token":
                session.cookies.clear(cookie.domain, cookie.path, cookie.name)
        assert session.get(f"{BASE_URL}/api/auth/me", timeout=30).status_code == 401
        refreshed = session.post(f"{BASE_URL}/api/auth/refresh", timeout=30)
        assert refreshed.status_code == 200, refreshed.text
        assert refreshed.json()["user_id"] == item["user"]["user_id"]
        assert session.get(f"{BASE_URL}/api/auth/me", timeout=30).status_code == 200

        logout = session.post(f"{BASE_URL}/api/auth/logout", timeout=30)
        assert logout.status_code == 200 and logout.json() == {"ok": True}
        assert session.get(f"{BASE_URL}/api/auth/me", timeout=30).status_code == 401
        login = session.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": item["email"], "password": item["password"]},
            timeout=30,
        )
        assert login.status_code == 200, login.text

    def test_five_failures_lock_sixth_attempt_by_normalized_email(self, mongo_db):
        raw_email = f"TEST_ITER36_{RUN_ID}_LOCK@EXAMPLE.COM"
        normalized = raw_email.lower()
        mongo_db.login_attempts.delete_many({"identifier": f"login:{normalized}"})
        statuses = []
        try:
            for index in range(6):
                # Alternate clients/casing to ensure ingress IP and email casing cannot fragment the counter.
                session = requests.Session()
                email = raw_email if index % 2 == 0 else normalized
                response = session.post(
                    f"{BASE_URL}/api/auth/login", json={"email": email, "password": "wrong"}, timeout=30
                )
                statuses.append(response.status_code)
                session.close()
            assert statuses[:5] == [401, 401, 401, 401, 401]
            assert statuses[5] == 429
            record = mongo_db.login_attempts.find_one({"identifier": f"login:{normalized}"})
            assert record and record["count"] == 5
        finally:
            mongo_db.login_attempts.delete_many({"identifier": f"login:{normalized}"})

    def test_real_get_response_has_credentialed_cors_headers(self):
        origin = f"https://{RUN_ID}.qa.example.test"
        response = requests.get(f"{BASE_URL}/api/auth/me", headers={"Origin": origin}, timeout=30)
        assert response.status_code == 401
        assert response.headers.get("access-control-allow-origin") == origin
        assert response.headers.get("access-control-allow-credentials") == "true"


# Local-memory requires authentication for every method and enforces owner filtering on reads/writes/deletes.
class TestLocalMemoryIsolation:
    @pytest.mark.parametrize(
        "method,path,json_body",
        [
            ("GET", "/api/local-memory", None),
            ("POST", "/api/local-memory", {"category": "souvenir", "text": "blocked"}),
            ("PUT", "/api/local-memory/nonexistent", {"text": "blocked"}),
            ("DELETE", "/api/local-memory/nonexistent", None),
        ],
    )
    def test_all_memory_methods_require_auth(self, method, path, json_body):
        response = requests.request(method, f"{BASE_URL}{path}", json=json_body, timeout=30)
        assert response.status_code == 401, response.text
        assert "authentifi" in response.json().get("detail", "").lower()

    def test_user_b_cannot_read_update_or_delete_user_a_fact(self, accounts):
        text = f"{TEST_PREFIX}_OWNER_A"
        created = accounts["a"]["session"].post(
            f"{BASE_URL}/api/local-memory", json={"category": "souvenir", "text": text}, timeout=30
        )
        assert created.status_code == 200, created.text
        fact = created.json()
        assert fact["text"] == text and isinstance(fact["id"], str)

        b_listing = accounts["b"]["session"].get(f"{BASE_URL}/api/local-memory", timeout=30)
        assert b_listing.status_code == 200
        assert all(entry.get("id") != fact["id"] for entry in b_listing.json()["facts"])

        cross_update = accounts["b"]["session"].put(
            f"{BASE_URL}/api/local-memory/{fact['id']}", json={"text": f"{TEST_PREFIX}_HACKED"}, timeout=30
        )
        assert cross_update.status_code == 404
        cross_delete = accounts["b"]["session"].delete(
            f"{BASE_URL}/api/local-memory/{fact['id']}", timeout=30
        )
        assert cross_delete.status_code == 404

        owner_listing = accounts["a"]["session"].get(f"{BASE_URL}/api/local-memory", timeout=30)
        persisted = next(entry for entry in owner_listing.json()["facts"] if entry["id"] == fact["id"])
        assert persisted["text"] == text
        owner_update = accounts["a"]["session"].put(
            f"{BASE_URL}/api/local-memory/{fact['id']}", json={"text": f"{TEST_PREFIX}_UPDATED"}, timeout=30
        )
        assert owner_update.status_code == 200 and owner_update.json() == {"ok": True}
        assert accounts["a"]["session"].delete(f"{BASE_URL}/api/local-memory/{fact['id']}", timeout=30).status_code == 200
        final = accounts["a"]["session"].get(f"{BASE_URL}/api/local-memory", timeout=30).json()["facts"]
        assert all(entry.get("id") != fact["id"] for entry in final)


# Startup seeding must reconcile a stale admin password without changing the real admin during this method test.
class _FakeCollection:
    def __init__(self, document=None):
        self.document = document

    async def create_index(self, *args, **kwargs):
        return None

    async def find_one(self, query, *args, **kwargs):
        return dict(self.document) if self.document else None

    async def update_one(self, query, update, **kwargs):
        if self.document and "$set" in update:
            self.document.update(update["$set"])

    async def insert_one(self, document):
        self.document = dict(document)


class _FakeDB:
    def __init__(self, user):
        self.users = _FakeCollection(user)
        self.login_attempts = _FakeCollection()


def test_seed_admin_updates_existing_stale_password(monkeypatch):
    sys.path.insert(0, "/app/backend")
    from auth_api import seed_admin_and_indexes

    old_hash = bcrypt.hashpw(b"old-password", bcrypt.gensalt()).decode()
    fake_db = _FakeDB({"user_id": "user_test_admin", "email": "seed-admin@example.test", "password_hash": old_hash})
    monkeypatch.setenv("ADMIN_EMAIL", "seed-admin@example.test")
    monkeypatch.setenv("ADMIN_PASSWORD", "new-password")
    asyncio.run(seed_admin_and_indexes(fake_db))
    assert bcrypt.checkpw(b"new-password", fake_db.users.document["password_hash"].encode())
    assert fake_db.users.document["password_hash"].startswith("$2b$")


# Standard and SSE chat routes namespace identical client session IDs by user; reset only affects its owner.
class TestChatIsolation:
    def test_standard_chat_and_reset_are_isolated(self, accounts, mongo_db):
        session_id = f"iter36-standard-{RUN_ID}"
        uid_a = accounts["a"]["user"]["user_id"]
        uid_b = accounts["b"]["user"]["user_id"]
        text_a = f"{TEST_PREFIX} message alpha"
        text_b = f"{TEST_PREFIX} message beta"

        response_a = accounts["a"]["session"].post(
            f"{BASE_URL}/api/chat", json={"text": text_a, "session_id": session_id, "ia_mode": "rapide"}, timeout=150
        )
        response_b = accounts["b"]["session"].post(
            f"{BASE_URL}/api/chat", json={"text": text_b, "session_id": session_id, "ia_mode": "rapide"}, timeout=150
        )
        assert response_a.status_code == 200, response_a.text
        assert response_b.status_code == 200, response_b.text
        assert isinstance(response_a.json().get("answer"), str) and response_a.json()["answer"]
        assert isinstance(response_b.json().get("answer"), str) and response_b.json()["answer"]

        doc_a = mongo_db.sirius_chats.find_one({"session_id": f"{uid_a}:{session_id}"})
        doc_b = mongo_db.sirius_chats.find_one({"session_id": f"{uid_b}:{session_id}"})
        assert doc_a and doc_b
        assert text_a in [item.get("content") for item in doc_a["history"]]
        assert text_b not in [item.get("content") for item in doc_a["history"]]
        assert text_b in [item.get("content") for item in doc_b["history"]]
        assert text_a not in [item.get("content") for item in doc_b["history"]]

        reset_b = accounts["b"]["session"].post(
            f"{BASE_URL}/api/chat/reset", json={"session_id": session_id}, timeout=30
        )
        assert reset_b.status_code == 200 and reset_b.json() == {"ok": True}
        assert mongo_db.sirius_chats.find_one({"session_id": f"{uid_b}:{session_id}"}) is None
        assert mongo_db.sirius_chats.find_one({"session_id": f"{uid_a}:{session_id}"}) is not None

    def test_stream_chat_and_reset_are_isolated(self, accounts, mongo_db):
        session_id = f"iter36-stream-{RUN_ID}"
        uid_a = accounts["a"]["user"]["user_id"]
        uid_b = accounts["b"]["user"]["user_id"]
        text_a = f"{TEST_PREFIX} stream alpha"
        text_b = f"{TEST_PREFIX} stream beta"

        response_a = accounts["a"]["session"].post(
            f"{BASE_URL}/api/chat/stream",
            json={"text": text_a, "session_id": session_id, "ia_mode": "rapide"},
            timeout=150,
        )
        response_b = accounts["b"]["session"].post(
            f"{BASE_URL}/api/chat/stream",
            json={"text": text_b, "session_id": session_id, "ia_mode": "rapide"},
            timeout=150,
        )
        assert response_a.status_code == 200 and response_a.headers.get("content-type", "").startswith("text/event-stream")
        assert response_b.status_code == 200 and response_b.headers.get("content-type", "").startswith("text/event-stream")
        assert '"type": "done"' in response_a.text
        assert '"type": "done"' in response_b.text

        doc_a = mongo_db.sirius_chats.find_one({"session_id": f"{uid_a}:{session_id}"})
        doc_b = mongo_db.sirius_chats.find_one({"session_id": f"{uid_b}:{session_id}"})
        assert doc_a and doc_b
        assert text_a in [item.get("content") for item in doc_a["history"]]
        assert text_b not in [item.get("content") for item in doc_a["history"]]
        assert text_b in [item.get("content") for item in doc_b["history"]]

        assert accounts["b"]["session"].post(
            f"{BASE_URL}/api/chat/reset", json={"session_id": session_id}, timeout=30
        ).status_code == 200
        assert mongo_db.sirius_chats.find_one({"session_id": f"{uid_b}:{session_id}"}) is None
        assert mongo_db.sirius_chats.find_one({"session_id": f"{uid_a}:{session_id}"}) is not None


class _CaptureEmailHandler:
    def __init__(self):
        self.messages = []

    async def handle_DATA(self, server, session, envelope):
        self.messages.append({"mail_from": envelope.mail_from, "rcpt_tos": envelope.rcpt_tos, "content": envelope.content})
        return "250 Message accepted"


@pytest.fixture(scope="module")
def smtp_server():
    handler = _CaptureEmailHandler()
    # aiosmtpd's Controller cannot self-probe port=0; reserve an ephemeral port first.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    controller = Controller(handler, hostname="127.0.0.1", port=port)
    controller.start()
    try:
        yield handler, port
    finally:
        controller.stop()


# Sensitive chat, CRM, and payment APIs must not expose or mutate user data without authentication.
class TestSensitiveApiAuthentication:
    @pytest.mark.parametrize(
        "method,path,json_body",
        [
            ("POST", "/api/chat/reset", {"session_id": f"unauth-{RUN_ID}"}),
            ("GET", "/api/agora/deals", None),
            ("GET", "/api/payments/transactions", None),
        ],
    )
    def test_sensitive_routes_reject_unauthenticated_clients(self, method, path, json_body):
        response = requests.request(method, f"{BASE_URL}{path}", json=json_body, timeout=60)
        assert response.status_code == 401, (
            f"{method} {path} exposed a user-scoped resource without authentication: "
            f"{response.status_code} {response.text[:300]}"
        )


# Test-mode Stripe checkout, persistence/status, paid receipt PDF, and successful reminder delivery to a local SMTP sink.
class TestStripePdfAndReminderRegression:
    def test_checkout_status_lists_and_pending_receipt(self, accounts, mongo_db):
        deal_name = f"{TEST_PREFIX}_STRIPE"
        create = requests.post(
            f"{BASE_URL}/api/agora/deals",
            json={
                "nom": deal_name,
                "entreprise": "TEST_QA",
                "email": f"qa-{RUN_ID}@example.com",
                "valeur": 12.34,
                "etape": "GAGNÉ",
            },
            timeout=30,
        )
        assert create.status_code == 200, create.text
        deal = create.json()["deal"]
        try:
            checkout = requests.post(
                f"{BASE_URL}/api/payments/deal-checkout",
                json={"deal_id": deal["id"], "percent": 30, "origin_url": BASE_URL},
                timeout=90,
            )
            assert checkout.status_code == 200, checkout.text
            payload = checkout.json()
            assert payload["checkout_url"].startswith("https://checkout.stripe.com/")
            assert payload["session_id"].startswith("cs_test_")
            assert payload["amount"] == 370

            status = requests.get(f"{BASE_URL}/api/payments/status/{payload['session_id']}", timeout=60)
            assert status.status_code == 200, status.text
            assert status.json() == {
                "session_id": payload["session_id"],
                "status": "initiated",
                "payment_status": "pending",
                "deal_id": deal["id"],
                "amount": 370,
                "percent": 30,
            }
            transactions = requests.get(f"{BASE_URL}/api/payments/transactions", timeout=60)
            assert transactions.status_code == 200
            assert any(item.get("session_id") == payload["session_id"] for item in transactions.json()["transactions"])
            deal_status = requests.get(f"{BASE_URL}/api/payments/deals-status", timeout=60)
            assert deal_status.status_code == 200
            assert deal_status.json()["deals"][deal["id"]]["pending"] >= 1
            receipt = requests.get(f"{BASE_URL}/api/payments/receipt/{payload['session_id']}", timeout=60)
            assert receipt.status_code == 400
            assert "pas encore confirmé" in receipt.json().get("detail", "")
        finally:
            requests.delete(f"{BASE_URL}/api/agora/deals/{deal['id']}", timeout=30)
            mongo_db.payment_transactions.delete_many({"deal_id": deal["id"]})

    def test_paid_receipt_is_valid_pdf(self, mongo_db):
        session_id = f"{TEST_PREFIX}_PAID_RECEIPT"
        mongo_db.payment_transactions.insert_one({
            "session_id": session_id,
            "deal_id": f"{TEST_PREFIX}_DEAL",
            "deal_nom": f"{TEST_PREFIX}_CLIENT",
            "deal_entreprise": "TEST_QA",
            "deal_email": f"qa-{RUN_ID}@example.com",
            "checkout_url": "https://checkout.stripe.com/test-placeholder",
            "percent": 100,
            "amount": 1234,
            "currency": "eur",
            "status": "completed",
            "payment_status": "paid",
            "created_at": "2026-07-01T12:00:00+00:00",
            "updated_at": "2026-07-01T12:00:00+00:00",
        })
        try:
            response = requests.get(f"{BASE_URL}/api/payments/receipt/{session_id}", timeout=60)
            assert response.status_code == 200, response.text
            assert response.headers.get("content-type", "").startswith("application/pdf")
            assert "recu-paiement.pdf" in response.headers.get("content-disposition", "")
            assert response.content.startswith(b"%PDF-")
            assert len(response.content) > 1000
        finally:
            mongo_db.payment_transactions.delete_one({"session_id": session_id})

    def test_pending_payment_reminder_sends_email(self, mongo_db, smtp_server):
        handler, port = smtp_server
        session_id = f"{TEST_PREFIX}_REMINDER"
        recipient = f"recipient-{RUN_ID}@example.com"
        mongo_db.payment_transactions.insert_one({
            "session_id": session_id,
            "deal_id": f"{TEST_PREFIX}_DEAL_REMIND",
            "deal_nom": f"{TEST_PREFIX}_REMINDER_CLIENT",
            "deal_email": recipient,
            "checkout_url": "https://checkout.stripe.com/test-reminder-link",
            "percent": 30,
            "amount": 999,
            "currency": "eur",
            "status": "initiated",
            "payment_status": "pending",
            "created_at": "2026-07-01T12:00:00+00:00",
            "updated_at": "2026-07-01T12:00:00+00:00",
        })
        try:
            response = requests.post(
                f"{BASE_URL}/api/payments/remind",
                json={
                    "session_id": session_id,
                    "smtp": {
                        "host": "127.0.0.1",
                        "port": port,
                        "user": "",
                        "password": "",
                        "from_email": "qa-sirius@example.com",
                        "from_name": "SIRIUS QA",
                    },
                },
                timeout=60,
            )
            assert response.status_code == 200, response.text
            assert response.json() == {"ok": True, "to": recipient}
            assert len(handler.messages) == 1
            captured = handler.messages[0]
            assert recipient in captured["rcpt_tos"]
            decoded = captured["content"].decode("utf-8", errors="replace")
            assert "Rappel" in decoded and "checkout.stripe.com/test-reminder-link" in decoded
            persisted = mongo_db.payment_transactions.find_one({"session_id": session_id})
            assert isinstance(persisted.get("reminded_at"), str) and persisted["reminded_at"]
        finally:
            mongo_db.payment_transactions.delete_one({"session_id": session_id})

    def test_payment_error_contracts(self):
        missing = f"{TEST_PREFIX}_MISSING"
        assert requests.get(f"{BASE_URL}/api/payments/status/{missing}", timeout=30).status_code == 404
        assert requests.get(f"{BASE_URL}/api/payments/receipt/{missing}", timeout=30).status_code == 404
        reminder = requests.post(
            f"{BASE_URL}/api/payments/remind", json={"session_id": missing, "smtp": {}}, timeout=30
        )
        assert reminder.status_code == 404
        webhook = requests.post(
            f"{BASE_URL}/api/stripe/webhook", data=b"{}", headers={"stripe-signature": "invalid"}, timeout=30
        )
        assert webhook.status_code == 400
        assert "signature" in webhook.json().get("detail", "").lower()
