"""Iteration 37: authenticated chat, Agora, payments, CORS, and auth isolation regression."""
import os
import re
import sqlite3
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
DIRECT_URL = "http://localhost:8001"
if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL is missing")

CREDENTIALS_PATH = Path("/app/memory/test_credentials.md")
SQLITE_PATH = Path("/app/backend/sirius_local.db")
RUN_ID = uuid.uuid4().hex[:10]
PREFIX = f"TEST_ITER37_{RUN_ID}"
PASSWORD = "Test#Iter37!"


def load_admin_credentials():
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
    email = f"test_iter37_{RUN_ID}_{label.lower()}@example.com"
    response = session.post(
        f"{BASE_URL}/api/auth/register",
        json={"email": email, "password": PASSWORD, "name": f"{PREFIX}_{label}"},
        timeout=30,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["email"] == email and data["name"] == f"{PREFIX}_{label}"
    assert isinstance(data["user_id"], str) and data["user_id"].startswith("user_")
    return {"session": session, "email": email, "password": PASSWORD, "user": data}


@pytest.fixture(scope="module")
def mongo_db():
    client = MongoClient(BACKEND_ENV["MONGO_URL"], serverSelectionTimeoutMS=5000)
    database = client[BACKEND_ENV["DB_NAME"]]
    yield database
    client.close()


@pytest.fixture(scope="module")
def accounts(mongo_db):
    data = {"a": register_account("Alpha"), "b": register_account("Beta")}
    yield data
    user_ids = [item["user"]["user_id"] for item in data.values()]
    for item in data.values():
        item["session"].close()
    mongo_db.users.delete_many({"user_id": {"$in": user_ids}})
    mongo_db.login_attempts.delete_many({"identifier": {"$regex": f"test_iter37_{RUN_ID}"}})
    mongo_db.sirius_chats.delete_many({"session_id": {"$regex": RUN_ID}})
    mongo_db.agora_deals.delete_many({"$or": [{"nom": {"$regex": f"^{PREFIX}"}}, {"id": {"$regex": f"^{PREFIX}"}}]})
    mongo_db.agora_settings.delete_many({"user_id": {"$in": user_ids}})
    mongo_db.agora_coach_history.delete_many({"id": {"$regex": f"^{PREFIX}"}})
    mongo_db.payment_transactions.delete_many({"$or": [
        {"session_id": {"$regex": f"^{PREFIX}"}},
        {"deal_id": {"$regex": f"^{PREFIX}"}},
        {"deal_nom": {"$regex": f"^{PREFIX}"}},
    ]})
    if SQLITE_PATH.exists():
        with sqlite3.connect(SQLITE_PATH) as connection:
            connection.execute("DELETE FROM facts WHERE user_id IN (?, ?)", tuple(user_ids))


@pytest.fixture(scope="module")
def admin_session(mongo_db):
    email, password = load_admin_credentials()
    session = requests.Session()
    response = session.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=30)
    assert response.status_code == 200, response.text
    user = response.json()
    yield session, user
    session.close()
    mongo_db.login_attempts.delete_many({"identifier": f"login:{email.lower()}"})


# Core authentication, cookies, bcrypt, logout/login, and normalized-email lockout.
class TestAuthRegression:
    def test_admin_login_hash_and_httponly_cookies(self, mongo_db):
        email, password = load_admin_credentials()
        admin = mongo_db.users.find_one({"email": email.lower()})
        assert admin and admin.get("role") == "admin"
        assert isinstance(admin.get("password_hash"), str) and admin["password_hash"].startswith("$2b$")
        assert bcrypt.checkpw(password.encode(), admin["password_hash"].encode())
        response = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=30)
        assert response.status_code == 200 and response.json()["email"] == email.lower()
        cookie_header = response.headers.get("set-cookie", "").lower()
        assert "access_token=" in cookie_header and "refresh_token=" in cookie_header
        assert cookie_header.count("httponly") >= 2

    def test_register_me_logout_login_me(self, accounts):
        item = accounts["b"]
        first_me = item["session"].get(f"{BASE_URL}/api/auth/me", timeout=30)
        assert first_me.status_code == 200 and first_me.json()["user_id"] == item["user"]["user_id"]
        logout = item["session"].post(f"{BASE_URL}/api/auth/logout", timeout=30)
        assert logout.status_code == 200 and logout.json() == {"ok": True}
        assert item["session"].get(f"{BASE_URL}/api/auth/me", timeout=30).status_code == 401
        login = item["session"].post(
            f"{BASE_URL}/api/auth/login", json={"email": item["email"], "password": item["password"]}, timeout=30
        )
        assert login.status_code == 200 and login.json()["user_id"] == item["user"]["user_id"]
        assert item["session"].get(f"{BASE_URL}/api/auth/me", timeout=30).json()["email"] == item["email"]

    def test_lockout_after_five_failures_is_email_only(self, mongo_db):
        raw_email = f"TEST_ITER37_{RUN_ID}_LOCK@EXAMPLE.COM"
        normalized = raw_email.lower()
        identifier = f"login:{normalized}"
        mongo_db.login_attempts.delete_many({"identifier": identifier})
        try:
            statuses = []
            for index in range(6):
                response = requests.post(
                    f"{BASE_URL}/api/auth/login",
                    json={"email": raw_email if index % 2 == 0 else normalized, "password": "wrong"},
                    timeout=30,
                )
                statuses.append(response.status_code)
            assert statuses == [401, 401, 401, 401, 401, 429]
            record = mongo_db.login_attempts.find_one({"identifier": identifier})
            assert record and record["count"] == 5
        finally:
            mongo_db.login_attempts.delete_many({"identifier": identifier})


# Chat endpoints must reject anonymous use and namespace both standard and SSE histories by owner.
class TestChatSecurity:
    @pytest.mark.parametrize(
        "path,body",
        [
            ("/api/chat", {"text": "anonymous blocked", "session_id": f"anon-{RUN_ID}"}),
            ("/api/chat/stream", {"text": "anonymous blocked", "session_id": f"anon-stream-{RUN_ID}"}),
            ("/api/chat/reset", {"session_id": f"anon-reset-{RUN_ID}"}),
        ],
    )
    def test_all_chat_writes_require_cookie(self, path, body):
        response = requests.post(f"{BASE_URL}{path}", json=body, timeout=60)
        assert response.status_code == 401, f"{path}: {response.status_code} {response.text[:300]}"
        assert "authentifi" in response.json().get("detail", "").lower()

    @pytest.mark.parametrize("path", ["/api/chat", "/api/chat/stream"])
    def test_anonymous_chat_auth_precedes_content_validation(self, path):
        response = requests.post(
            f"{BASE_URL}{path}", json={"text": "", "session_id": f"anon-empty-{RUN_ID}"}, timeout=30
        )
        assert response.status_code == 401, (
            f"{path} validates anonymous content before authentication: "
            f"{response.status_code} {response.text[:300]}"
        )

    def test_standard_and_stream_chat_isolation_and_reset(self, accounts, mongo_db):
        uid_a = accounts["a"]["user"]["user_id"]
        uid_b = accounts["b"]["user"]["user_id"]
        for route, suffix in (("/api/chat", "standard"), ("/api/chat/stream", "stream")):
            session_id = f"iter37-{suffix}-{RUN_ID}"
            text_a = f"{PREFIX} {suffix} alpha"
            text_b = f"{PREFIX} {suffix} beta"
            response_a = accounts["a"]["session"].post(
                f"{BASE_URL}{route}", json={"text": text_a, "session_id": session_id, "ia_mode": "rapide"}, timeout=180
            )
            response_b = accounts["b"]["session"].post(
                f"{BASE_URL}{route}", json={"text": text_b, "session_id": session_id, "ia_mode": "rapide"}, timeout=180
            )
            assert response_a.status_code == 200, response_a.text[:500]
            assert response_b.status_code == 200, response_b.text[:500]
            if route.endswith("stream"):
                assert response_a.headers.get("content-type", "").startswith("text/event-stream")
                assert '"type": "done"' in response_a.text and '"type": "done"' in response_b.text
            else:
                assert isinstance(response_a.json().get("answer"), str) and response_a.json()["answer"]
                assert isinstance(response_b.json().get("answer"), str) and response_b.json()["answer"]
            doc_a = mongo_db.sirius_chats.find_one({"session_id": f"{uid_a}:{session_id}"})
            doc_b = mongo_db.sirius_chats.find_one({"session_id": f"{uid_b}:{session_id}"})
            assert doc_a and doc_b
            contents_a = [entry.get("content") for entry in doc_a["history"]]
            contents_b = [entry.get("content") for entry in doc_b["history"]]
            assert text_a in contents_a and text_b not in contents_a
            assert text_b in contents_b and text_a not in contents_b
            reset_b = accounts["b"]["session"].post(
                f"{BASE_URL}/api/chat/reset", json={"session_id": session_id}, timeout=30
            )
            assert reset_b.status_code == 200 and reset_b.json() == {"ok": True}
            assert mongo_db.sirius_chats.find_one({"session_id": f"{uid_b}:{session_id}"}) is None
            assert mongo_db.sirius_chats.find_one({"session_id": f"{uid_a}:{session_id}"}) is not None


# Local-memory remains auth-gated and owner-filtered after the security changes.
class TestLocalMemoryRegression:
    def test_get_requires_cookie(self):
        response = requests.get(f"{BASE_URL}/api/local-memory", timeout=30)
        assert response.status_code == 401
        assert "authentifi" in response.json().get("detail", "").lower()

    def test_local_memory_a_b_isolation(self, accounts):
        text = f"{PREFIX}_FACT_A"
        created = accounts["a"]["session"].post(
            f"{BASE_URL}/api/local-memory", json={"category": "souvenir", "text": text}, timeout=30
        )
        assert created.status_code == 200 and created.json()["text"] == text
        fact_id = created.json()["id"]
        try:
            list_b = accounts["b"]["session"].get(f"{BASE_URL}/api/local-memory", timeout=30)
            assert list_b.status_code == 200
            assert all(item["id"] != fact_id for item in list_b.json()["facts"])
            assert accounts["b"]["session"].put(
                f"{BASE_URL}/api/local-memory/{fact_id}", json={"text": f"{PREFIX}_HACK"}, timeout=30
            ).status_code == 404
            assert accounts["b"]["session"].delete(
                f"{BASE_URL}/api/local-memory/{fact_id}", timeout=30
            ).status_code == 404
            list_a = accounts["a"]["session"].get(f"{BASE_URL}/api/local-memory", timeout=30).json()["facts"]
            assert any(item["id"] == fact_id and item["text"] == text for item in list_a)
        finally:
            accounts["a"]["session"].delete(f"{BASE_URL}/api/local-memory/{fact_id}", timeout=30)


# Every requested Agora route must authenticate before reading, validating, or mutating data.
class TestAgoraAuthentication:
    @pytest.mark.parametrize(
        "method,path,body",
        [
            ("GET", "/api/agora/deals", None),
            ("POST", "/api/agora/deals", {"nom": "blocked"}),
            ("PUT", "/api/agora/deals/missing", {"nom": "blocked"}),
            ("DELETE", "/api/agora/deals/missing", None),
            ("GET", "/api/agora/objectif", None),
            ("PUT", "/api/agora/objectif", {"montant": 1000}),
            ("POST", "/api/agora/deals/missing/relance", {"smtp": {}}),
            ("GET", "/api/agora/coach/history", None),
            ("GET", "/api/agora/deals/export.csv", None),
            ("POST", "/api/agora/coach", {"history": [], "scenario": "blocked", "mode": "play"}),
        ],
    )
    def test_agora_routes_reject_anonymous_clients(self, method, path, body):
        response = requests.request(method, f"{BASE_URL}{path}", json=body, timeout=30)
        assert response.status_code == 401, f"{method} {path}: {response.status_code} {response.text[:300]}"


# Agora CRUD, objective, export, coach history, ownership, and admin legacy claiming.
class TestAgoraIsolation:
    def test_created_deal_persists_owner_and_is_visible_only_to_owner(self, accounts, mongo_db):
        uid_a = accounts["a"]["user"]["user_id"]
        name = f"{PREFIX}_CREATED_OWNER"
        response = accounts["a"]["session"].post(
            f"{BASE_URL}/api/agora/deals",
            json={"nom": name, "entreprise": "TEST_QA", "email": "owner@example.test", "valeur": 1250},
            timeout=30,
        )
        assert response.status_code == 200, response.text
        deal = response.json()["deal"]
        try:
            assert deal["nom"] == name and deal["user_id"] == uid_a
            stored = mongo_db.agora_deals.find_one({"id": deal["id"]})
            assert stored and stored["user_id"] == uid_a
            list_a = accounts["a"]["session"].get(f"{BASE_URL}/api/agora/deals", timeout=30).json()["deals"]
            list_b = accounts["b"]["session"].get(f"{BASE_URL}/api/agora/deals", timeout=30).json()["deals"]
            assert any(item["id"] == deal["id"] for item in list_a)
            assert all(item["id"] != deal["id"] for item in list_b)
        finally:
            mongo_db.agora_deals.delete_many({"nom": name})

    def test_seeded_deals_crud_export_and_objective_are_isolated(self, accounts, mongo_db):
        uid_a = accounts["a"]["user"]["user_id"]
        uid_b = accounts["b"]["user"]["user_id"]
        deal_a = f"{PREFIX}_DEAL_A"
        deal_b = f"{PREFIX}_DEAL_B"
        common = {"entreprise": "TEST_QA", "email": "", "valeur": 100, "etape": "GAGNÉ", "note": "", "relance": "",
                  "created_at": "2026-07-01T00:00:00+00:00", "updated_at": "2026-07-01T00:00:00+00:00"}
        mongo_db.agora_deals.insert_many([
            {**common, "id": deal_a, "nom": f"{PREFIX}_ALPHA", "user_id": uid_a},
            {**common, "id": deal_b, "nom": f"{PREFIX}_BETA", "user_id": uid_b},
        ])
        try:
            list_a = accounts["a"]["session"].get(f"{BASE_URL}/api/agora/deals", timeout=30)
            list_b = accounts["b"]["session"].get(f"{BASE_URL}/api/agora/deals", timeout=30)
            assert list_a.status_code == 200 and list_b.status_code == 200
            assert deal_a in [item["id"] for item in list_a.json()["deals"]]
            assert deal_b not in [item["id"] for item in list_a.json()["deals"]]
            assert deal_b in [item["id"] for item in list_b.json()["deals"]]
            assert accounts["b"]["session"].put(
                f"{BASE_URL}/api/agora/deals/{deal_a}", json={"nom": f"{PREFIX}_HACK"}, timeout=30
            ).status_code == 404
            assert accounts["b"]["session"].delete(f"{BASE_URL}/api/agora/deals/{deal_a}", timeout=30).status_code == 404
            updated = accounts["a"]["session"].put(
                f"{BASE_URL}/api/agora/deals/{deal_a}", json={"note": "owner-update"}, timeout=30
            )
            assert updated.status_code == 200 and updated.json()["deal"]["note"] == "owner-update"
            assert mongo_db.agora_deals.find_one({"id": deal_a})["note"] == "owner-update"
            export_a = accounts["a"]["session"].get(f"{BASE_URL}/api/agora/deals/export.csv", timeout=30)
            assert export_a.status_code == 200 and "text/csv" in export_a.headers.get("content-type", "")
            assert f"{PREFIX}_ALPHA" in export_a.text and f"{PREFIX}_BETA" not in export_a.text
            objective_a = accounts["a"]["session"].put(
                f"{BASE_URL}/api/agora/objectif", json={"montant": 4321}, timeout=30
            )
            objective_b = accounts["b"]["session"].put(
                f"{BASE_URL}/api/agora/objectif", json={"montant": 9876}, timeout=30
            )
            assert objective_a.status_code == 200 and objective_a.json()["montant"] == 4321
            assert objective_b.status_code == 200 and objective_b.json()["montant"] == 9876
            assert accounts["a"]["session"].get(f"{BASE_URL}/api/agora/objectif", timeout=30).json()["montant"] == 4321
            assert accounts["b"]["session"].get(f"{BASE_URL}/api/agora/objectif", timeout=30).json()["montant"] == 9876
            assert accounts["b"]["session"].post(
                f"{BASE_URL}/api/agora/deals/{deal_a}/relance", json={"smtp": {}}, timeout=30
            ).status_code == 404
            owner_relance = accounts["a"]["session"].post(
                f"{BASE_URL}/api/agora/deals/{deal_a}/relance", json={"smtp": {}}, timeout=30
            )
            assert owner_relance.status_code == 400
            assert "adresse" in owner_relance.json().get("detail", "").lower()
            deleted = accounts["a"]["session"].delete(f"{BASE_URL}/api/agora/deals/{deal_a}", timeout=30)
            assert deleted.status_code == 200 and deleted.json() == {"ok": True}
            assert mongo_db.agora_deals.find_one({"id": deal_a}) is None
        finally:
            mongo_db.agora_deals.delete_many({"id": {"$in": [deal_a, deal_b]}})
            mongo_db.agora_settings.delete_many({"user_id": {"$in": [uid_a, uid_b]}})

    def test_coach_history_is_filtered_by_user(self, accounts, mongo_db):
        uid_a = accounts["a"]["user"]["user_id"]
        uid_b = accounts["b"]["user"]["user_id"]
        id_a = f"{PREFIX}_COACH_A"
        id_b = f"{PREFIX}_COACH_B"
        mongo_db.agora_coach_history.insert_many([
            {"id": id_a, "user_id": uid_a, "scenario": "alpha", "created_at": "2026-07-01T00:00:00+00:00"},
            {"id": id_b, "user_id": uid_b, "scenario": "beta", "created_at": "2026-07-01T00:00:01+00:00"},
        ])
        try:
            response_a = accounts["a"]["session"].get(f"{BASE_URL}/api/agora/coach/history", timeout=30)
            response_b = accounts["b"]["session"].get(f"{BASE_URL}/api/agora/coach/history", timeout=30)
            assert response_a.status_code == 200 and response_b.status_code == 200
            ids_a = [item["id"] for item in response_a.json()["sessions"]]
            ids_b = [item["id"] for item in response_b.json()["sessions"]]
            assert id_a in ids_a and id_b not in ids_a
            assert id_b in ids_b and id_a not in ids_b
        finally:
            mongo_db.agora_coach_history.delete_many({"id": {"$in": [id_a, id_b]}})

    def test_authenticated_coach_debrief_persists_owner(self, accounts, mongo_db):
        uid_a = accounts["a"]["user"]["user_id"]
        scenario = f"{PREFIX}_COACH_DEBRIEF"
        try:
            response = accounts["a"]["session"].post(
                f"{BASE_URL}/api/agora/coach",
                json={
                    "history": [
                        {"role": "assistant", "content": "Votre offre est trop chère."},
                        {"role": "user", "content": "Le retour sur investissement est mesurable en trois mois."},
                    ],
                    "scenario": scenario,
                    "mode": "debrief",
                },
                timeout=180,
            )
            assert response.status_code == 200, response.text[:500]
            assert response.json().get("ok") is True and response.json().get("reponse")
            stored = mongo_db.agora_coach_history.find_one({"scenario": scenario})
            assert stored and stored["user_id"] == uid_a
            history_a = accounts["a"]["session"].get(f"{BASE_URL}/api/agora/coach/history", timeout=30)
            history_b = accounts["b"]["session"].get(f"{BASE_URL}/api/agora/coach/history", timeout=30)
            assert any(item["id"] == stored["id"] for item in history_a.json()["sessions"])
            assert all(item["id"] != stored["id"] for item in history_b.json()["sessions"])
        finally:
            mongo_db.agora_coach_history.delete_many({"scenario": scenario})

    def test_admin_claims_all_legacy_agora_records_on_first_request(self, admin_session, mongo_db):
        session, admin = admin_session
        legacy_id = f"{PREFIX}_LEGACY"
        legacy_setting_key = f"{PREFIX}_LEGACY_SETTING"
        legacy_history_id = f"{PREFIX}_LEGACY_HISTORY"
        mongo_db.agora_deals.insert_one({
            "id": legacy_id, "nom": f"{PREFIX}_LEGACY", "valeur": 1, "etape": "PROSPECTION",
            "created_at": "2026-07-01T00:00:00+00:00", "updated_at": "2026-07-01T00:00:00+00:00",
        })
        mongo_db.agora_settings.insert_one({"key": legacy_setting_key, "montant": 1})
        mongo_db.agora_coach_history.insert_one({
            "id": legacy_history_id, "scenario": "legacy", "created_at": "2026-07-01T00:00:00+00:00"
        })
        try:
            response = session.get(f"{BASE_URL}/api/agora/deals", timeout=30)
            assert response.status_code == 200
            stored = mongo_db.agora_deals.find_one({"id": legacy_id})
            setting = mongo_db.agora_settings.find_one({"key": legacy_setting_key})
            history = mongo_db.agora_coach_history.find_one({"id": legacy_history_id})
            assert stored and stored["user_id"] == admin["user_id"]
            assert setting and setting["user_id"] == admin["user_id"]
            assert history and history["user_id"] == admin["user_id"]
            assert any(item["id"] == legacy_id for item in response.json()["deals"])
        finally:
            mongo_db.agora_deals.delete_one({"id": legacy_id})
            mongo_db.agora_settings.delete_one({"key": legacy_setting_key})
            mongo_db.agora_coach_history.delete_one({"id": legacy_history_id})


# Payment APIs are private; webhook remains public but requires a valid Stripe signature.
class TestPaymentsAuthentication:
    @pytest.mark.parametrize(
        "method,path,body",
        [
            ("GET", "/api/payments/transactions", None),
            ("GET", "/api/payments/deals-status", None),
            ("POST", "/api/payments/deal-checkout", {"deal_id": "missing", "percent": 30, "origin_url": BASE_URL}),
            ("GET", "/api/payments/status/missing", None),
            ("GET", "/api/payments/receipt/missing", None),
            ("POST", "/api/payments/remind", {"session_id": "missing", "smtp": {}}),
        ],
    )
    def test_payment_routes_reject_anonymous_clients(self, method, path, body):
        response = requests.request(method, f"{BASE_URL}{path}", json=body, timeout=30)
        assert response.status_code == 401, f"{method} {path}: {response.status_code} {response.text[:300]}"

    def test_webhook_remains_public_and_rejects_invalid_signature(self):
        response = requests.post(
            f"{BASE_URL}/api/stripe/webhook", data=b"{}", headers={"stripe-signature": "invalid"}, timeout=30
        )
        assert response.status_code == 400
        assert "signature" in response.json().get("detail", "").lower()


# Checkout ownership and all transaction reads/actions must retain user ownership.
class TestPaymentsIsolation:
    def test_checkout_only_accepts_owned_deal_and_transaction_is_private(self, accounts, mongo_db):
        uid_a = accounts["a"]["user"]["user_id"]
        deal_id = f"{PREFIX}_CHECKOUT_DEAL"
        mongo_db.agora_deals.insert_one({
            "id": deal_id, "user_id": uid_a, "nom": f"{PREFIX}_CHECKOUT", "entreprise": "TEST_QA",
            "email": "checkout@example.test", "valeur": 12.34, "etape": "GAGNÉ", "note": "", "relance": "",
            "created_at": "2026-07-01T00:00:00+00:00", "updated_at": "2026-07-01T00:00:00+00:00",
        })
        session_id = None
        try:
            cross = accounts["b"]["session"].post(
                f"{BASE_URL}/api/payments/deal-checkout",
                json={"deal_id": deal_id, "percent": 30, "origin_url": BASE_URL}, timeout=60,
            )
            assert cross.status_code == 404
            checkout = accounts["a"]["session"].post(
                f"{BASE_URL}/api/payments/deal-checkout",
                json={"deal_id": deal_id, "percent": 30, "origin_url": BASE_URL}, timeout=90,
            )
            assert checkout.status_code == 200, checkout.text
            payload = checkout.json()
            session_id = payload["session_id"]
            assert session_id.startswith("cs_test_") and payload["checkout_url"].startswith("https://checkout.stripe.com/")
            assert payload["amount"] == 370
            stored = mongo_db.payment_transactions.find_one({"session_id": session_id})
            assert stored and stored["user_id"] == uid_a and stored["deal_id"] == deal_id
            tx_a = accounts["a"]["session"].get(f"{BASE_URL}/api/payments/transactions", timeout=60)
            tx_b = accounts["b"]["session"].get(f"{BASE_URL}/api/payments/transactions", timeout=60)
            assert tx_a.status_code == 200 and tx_b.status_code == 200
            assert session_id in [item["session_id"] for item in tx_a.json()["transactions"]]
            assert session_id not in [item["session_id"] for item in tx_b.json()["transactions"]]
            assert accounts["b"]["session"].get(f"{BASE_URL}/api/payments/status/{session_id}", timeout=30).status_code == 404
            assert accounts["b"]["session"].get(f"{BASE_URL}/api/payments/receipt/{session_id}", timeout=30).status_code == 404
            assert accounts["b"]["session"].post(
                f"{BASE_URL}/api/payments/remind", json={"session_id": session_id, "smtp": {}}, timeout=30
            ).status_code == 404
        finally:
            mongo_db.agora_deals.delete_one({"id": deal_id})
            if session_id:
                mongo_db.payment_transactions.delete_one({"session_id": session_id})

    def test_seeded_transactions_status_receipt_remind_and_deal_status_are_filtered(self, accounts, mongo_db):
        uid_a = accounts["a"]["user"]["user_id"]
        uid_b = accounts["b"]["user"]["user_id"]
        sid_a = f"{PREFIX}_TX_A"
        sid_b = f"{PREFIX}_TX_B"
        deal_a = f"{PREFIX}_TX_DEAL_A"
        deal_b = f"{PREFIX}_TX_DEAL_B"
        base = {"deal_nom": PREFIX, "deal_entreprise": "TEST_QA", "deal_email": "client@example.test",
                "checkout_url": "https://checkout.stripe.com/test-placeholder", "percent": 100, "amount": 1234,
                "currency": "eur", "status": "completed", "payment_status": "paid",
                "created_at": "2026-07-01T00:00:00+00:00", "updated_at": "2026-07-01T00:00:00+00:00"}
        mongo_db.payment_transactions.insert_many([
            {**base, "session_id": sid_a, "deal_id": deal_a, "user_id": uid_a},
            {**base, "session_id": sid_b, "deal_id": deal_b, "user_id": uid_b},
        ])
        try:
            list_a = accounts["a"]["session"].get(f"{BASE_URL}/api/payments/transactions", timeout=30)
            assert list_a.status_code == 200
            ids_a = [item["session_id"] for item in list_a.json()["transactions"]]
            assert sid_a in ids_a and sid_b not in ids_a
            deals_a = accounts["a"]["session"].get(f"{BASE_URL}/api/payments/deals-status", timeout=30)
            assert deals_a.status_code == 200
            assert deal_a in deals_a.json()["deals"] and deal_b not in deals_a.json()["deals"]
            status_a = accounts["a"]["session"].get(f"{BASE_URL}/api/payments/status/{sid_a}", timeout=30)
            assert status_a.status_code == 200 and status_a.json()["deal_id"] == deal_a
            assert accounts["b"]["session"].get(f"{BASE_URL}/api/payments/status/{sid_a}", timeout=30).status_code == 404
            receipt_a = accounts["a"]["session"].get(f"{BASE_URL}/api/payments/receipt/{sid_a}", timeout=30)
            assert receipt_a.status_code == 200 and receipt_a.content.startswith(b"%PDF-")
            assert accounts["b"]["session"].get(f"{BASE_URL}/api/payments/receipt/{sid_a}", timeout=30).status_code == 404
            remind_paid = accounts["a"]["session"].post(
                f"{BASE_URL}/api/payments/remind", json={"session_id": sid_a, "smtp": {}}, timeout=30
            )
            assert remind_paid.status_code == 400 and "déjà encaissé" in remind_paid.json().get("detail", "")
            assert accounts["b"]["session"].post(
                f"{BASE_URL}/api/payments/remind", json={"session_id": sid_a, "smtp": {}}, timeout=30
            ).status_code == 404
        finally:
            mongo_db.payment_transactions.delete_many({"session_id": {"$in": [sid_a, sid_b]}})


# Direct backend CORS is the source of truth; public ingress headers are intentionally out of scope.
def test_direct_backend_cors_allows_preview_origin_with_credentials():
    origin = "https://cybertech-panel.preview.emergentagent.com"
    response = requests.get(f"{DIRECT_URL}/api/auth/me", headers={"Origin": origin}, timeout=30)
    assert response.status_code == 401
    assert response.headers.get("access-control-allow-origin") == origin
    assert response.headers.get("access-control-allow-credentials") == "true"

    preflight = requests.options(
        f"{DIRECT_URL}/api/chat",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
        timeout=30,
    )
    assert preflight.status_code == 200
    assert preflight.headers.get("access-control-allow-origin") == origin
    assert preflight.headers.get("access-control-allow-credentials") == "true"
