"""Iteration 38: THÉMIS authentication/isolation, legacy claiming, admin API, and regressions."""
import io
import os
import re
import uuid
import zipfile
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
RUN_ID = uuid.uuid4().hex[:10]
PREFIX = f"TEST_ITER38_{RUN_ID}"
PASSWORD = "Test#Iter38!"
THEMIS_COLLECTIONS = [
    "themis_clients", "themis_items", "themis_docs", "themis_orders", "themis_payments", "themis_pieces"
]


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
    email = f"test_iter38_{RUN_ID}_{label.lower()}@example.com"
    response = session.post(
        f"{BASE_URL}/api/auth/register",
        json={"email": email, "password": PASSWORD, "name": f"{PREFIX}_{label}"},
        timeout=30,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["email"] == email
    assert data["role"] == "user"
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
    piece_ids = [p["id"] for p in mongo_db.themis_pieces.find({"user_id": {"$in": user_ids}}, {"id": 1, "ext": 1})]
    for item in data.values():
        item["session"].close()
    mongo_db.users.delete_many({"user_id": {"$in": user_ids}})
    mongo_db.login_attempts.delete_many({"identifier": {"$regex": f"test_iter38_{RUN_ID}"}})
    for collection in THEMIS_COLLECTIONS:
        mongo_db[collection].delete_many({"user_id": {"$in": user_ids}})
        mongo_db[collection].delete_many({"id": {"$regex": f"^{PREFIX}"}})
    mongo_db.agora_deals.delete_many({"user_id": {"$in": user_ids}})
    mongo_db.payment_transactions.delete_many({"user_id": {"$in": user_ids}})
    for piece in piece_ids:
        path = Path("/app/backend/themis_files") / f"{piece['id']}.{piece['ext']}"
        path.unlink(missing_ok=True)


@pytest.fixture(scope="module")
def admin_session(mongo_db):
    email, password = load_admin_credentials()
    session = requests.Session()
    response = session.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=30)
    assert response.status_code == 200, response.text
    assert response.json()["role"] == "admin"
    yield session, response.json()
    session.close()
    mongo_db.login_attempts.delete_many({"identifier": f"login:{email.lower()}"})


# Every THÉMIS endpoint except templates must authenticate before accessing user data.
UNAUTH_CASES = [
    ("GET", "/api/themis/clients", None),
    ("POST", "/api/themis/clients", {"name": "blocked"}),
    ("PUT", "/api/themis/clients/missing", {"name": "blocked"}),
    ("DELETE", "/api/themis/clients/missing", None),
    ("GET", "/api/themis/items", None),
    ("POST", "/api/themis/items", {"name": "blocked", "stock": 1}),
    ("PUT", "/api/themis/items/missing/stock", {"delta": 1}),
    ("DELETE", "/api/themis/items/missing", None),
    ("GET", "/api/themis/docs", None),
    ("POST", "/api/themis/docs", {"kind": "devis", "lines": []}),
    ("POST", "/api/themis/from-deal", {"deal_id": "missing", "kind": "devis"}),
    ("PUT", "/api/themis/docs/missing/status", {"status": "envoyé"}),
    ("POST", "/api/themis/docs/missing/convert", None),
    ("GET", "/api/themis/docs/missing/pdf", None),
    ("POST", "/api/themis/docs/missing/email", {
        "to": "qa@example.test", "smtp": {"host": "127.0.0.1", "port": 9}
    }),
    ("DELETE", "/api/themis/docs/missing", None),
    ("GET", "/api/themis/orders", None),
    ("POST", "/api/themis/orders", {"client_name": "blocked", "lines": []}),
    ("PUT", "/api/themis/orders/missing/status", {"status": "en_cours"}),
    ("DELETE", "/api/themis/orders/missing", None),
    ("GET", "/api/themis/payments", None),
    ("POST", "/api/themis/payments", {"amount": 1}),
    ("DELETE", "/api/themis/payments/missing", None),
    ("GET", "/api/themis/pieces", None),
    ("PUT", "/api/themis/pieces/missing", {"status": "payé"}),
    ("GET", "/api/themis/pieces/missing/file", None),
    ("DELETE", "/api/themis/pieces/missing", None),
    ("GET", "/api/themis/export", None),
    ("GET", "/api/themis/bilan", None),
    ("GET", "/api/themis/stats", None),
]


@pytest.mark.parametrize("method,path,body", UNAUTH_CASES, ids=lambda value: str(value)[:60])
def test_themis_route_rejects_unauthenticated_request(method, path, body):
    response = requests.request(method, f"{BASE_URL}{path}", json=body, timeout=30)
    assert response.status_code == 401, f"{method} {path}: {response.status_code} {response.text[:300]}"
    assert "authentifi" in response.json().get("detail", "").lower()


def test_piece_upload_requires_authentication():
    response = requests.post(
        f"{BASE_URL}/api/themis/pieces/upload",
        files={"file": ("blocked.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")},
        timeout=30,
    )
    assert response.status_code == 401, response.text


def test_templates_remain_public():
    response = requests.get(f"{BASE_URL}/api/themis/templates", timeout=30)
    assert response.status_code == 200
    templates = response.json()["templates"]
    assert [item["id"] for item in templates] == ["antique", "moderne", "minimal"]


@pytest.fixture(scope="module")
def themis_data(accounts, mongo_db):
    a = accounts["a"]
    uid_a = a["user"]["user_id"]
    marker = f"{PREFIX}_OWNER_A"

    client_response = a["session"].post(
        f"{BASE_URL}/api/themis/clients",
        json={"name": marker, "company": "TEST_QA", "email": "alpha@example.test"}, timeout=30,
    )
    assert client_response.status_code == 200, client_response.text
    client = client_response.json()["client"]

    item_response = a["session"].post(
        f"{BASE_URL}/api/themis/items", json={"name": marker, "ref": PREFIX, "price": 10, "stock": 3}, timeout=30
    )
    assert item_response.status_code == 200, item_response.text
    item = item_response.json()["item"]

    lines = [{"label": marker, "qty": 2, "unit_price": 50}]
    devis_response = a["session"].post(
        f"{BASE_URL}/api/themis/docs",
        json={"kind": "devis", "client_id": client["id"], "client_name": marker, "lines": lines, "tva": 20},
        timeout=30,
    )
    assert devis_response.status_code == 200, devis_response.text
    devis = devis_response.json()["doc"]

    invoice_response = a["session"].post(
        f"{BASE_URL}/api/themis/docs",
        json={"kind": "facture", "client_id": client["id"], "client_name": marker, "lines": lines, "tva": 20},
        timeout=30,
    )
    assert invoice_response.status_code == 200, invoice_response.text
    invoice = invoice_response.json()["doc"]

    order_response = a["session"].post(
        f"{BASE_URL}/api/themis/orders",
        json={"client_id": client["id"], "client_name": marker, "lines": lines}, timeout=30,
    )
    assert order_response.status_code == 200, order_response.text
    order = order_response.json()["order"]

    payment_response = a["session"].post(
        f"{BASE_URL}/api/themis/payments",
        json={"doc_id": invoice["id"], "amount": 60, "method": "virement", "note": PREFIX}, timeout=30,
    )
    assert payment_response.status_code == 200, payment_response.text
    payment = payment_response.json()["payment"]

    for obj in (client, item, devis, invoice, order, payment):
        assert obj["user_id"] == uid_a
        stored = None
        for collection in THEMIS_COLLECTIONS:
            stored = mongo_db[collection].find_one({"id": obj["id"]})
            if stored:
                break
        assert stored and stored["user_id"] == uid_a

    data = {"marker": marker, "client": client, "item": item, "devis": devis, "invoice": invoice,
            "order": order, "payment": payment}
    yield data


# Newly registered B must see empty THÉMIS lists and zero financial/dashboard aggregates.
def test_account_b_lists_and_aggregates_are_empty(accounts, themis_data):
    b = accounts["b"]["session"]
    for path, key in [
        ("clients", "clients"), ("items", "items"), ("docs", "docs"),
        ("orders", "orders"), ("payments", "payments"), ("pieces", "pieces"),
    ]:
        response = b.get(f"{BASE_URL}/api/themis/{path}", timeout=30)
        assert response.status_code == 200, response.text
        assert response.json()[key] == []

    stats = b.get(f"{BASE_URL}/api/themis/stats", timeout=30).json()
    assert stats["encaisse"] == 0
    assert stats["a_encaisser"] == 0
    assert stats["devis_en_cours"] == 0
    assert stats["factures_impayees"] == 0
    assert stats["nb_clients"] == 0
    assert stats["commandes_actives"] == 0
    assert stats["stock_alerts"] == []
    assert stats["derniers_docs"] == []
    assert all(row["in"] == 0 and row["out"] == 0 for row in stats["monthly"])

    bilan = b.get(f"{BASE_URL}/api/themis/bilan", timeout=30).json()
    assert bilan["encaisse"] == 0 and bilan["a_encaisser"] == 0
    assert bilan["factures_impayees"] == 0 and bilan["pieces_a_payer"] == 0
    assert "Tu as encaissé" in bilan["speech"]
    assert "monsieur" not in bilan["speech"].lower() and "vous avez" not in bilan["speech"].lower()


# Cross-account mutations may return 404 or a no-op success, but must never change A's records.
def test_account_b_cannot_modify_or_delete_a_core_objects(accounts, themis_data, mongo_db):
    b = accounts["b"]["session"]
    d = themis_data
    operations = [
        ("PUT", f"clients/{d['client']['id']}", {"name": f"{PREFIX}_HACK"}),
        ("DELETE", f"clients/{d['client']['id']}", None),
        ("PUT", f"items/{d['item']['id']}/stock", {"delta": 999}),
        ("DELETE", f"items/{d['item']['id']}", None),
        ("PUT", f"docs/{d['devis']['id']}/status", {"status": "payé"}),
        ("POST", f"docs/{d['devis']['id']}/convert", None),
        ("DELETE", f"docs/{d['devis']['id']}", None),
        ("PUT", f"orders/{d['order']['id']}/status", {"status": "livrée"}),
        ("DELETE", f"orders/{d['order']['id']}", None),
        ("DELETE", f"payments/{d['payment']['id']}", None),
    ]
    for method, path, body in operations:
        response = b.request(method, f"{BASE_URL}/api/themis/{path}", json=body, timeout=30)
        assert response.status_code in (200, 404), f"{method} {path}: {response.status_code} {response.text}"

    assert mongo_db.themis_clients.find_one({"id": d["client"]["id"]})["name"] == d["client"]["name"]
    assert mongo_db.themis_items.find_one({"id": d["item"]["id"]})["stock"] == 3
    assert mongo_db.themis_docs.find_one({"id": d["devis"]["id"]})["status"] == "brouillon"
    assert mongo_db.themis_orders.find_one({"id": d["order"]["id"]})["status"] == "en_attente"
    assert mongo_db.themis_payments.find_one({"id": d["payment"]["id"]}) is not None


def test_account_b_cannot_read_a_pdf_or_email_a_doc(accounts, themis_data):
    b = accounts["b"]["session"]
    did = themis_data["devis"]["id"]
    pdf = b.get(f"{BASE_URL}/api/themis/docs/{did}/pdf", timeout=30)
    assert pdf.status_code == 404
    email = b.post(
        f"{BASE_URL}/api/themis/docs/{did}/email",
        json={"to": "qa@example.test", "smtp": {"host": "127.0.0.1", "port": 9}}, timeout=30,
    )
    assert email.status_code == 404


# from-deal must enforce Agora ownership and persist owner on both generated records.
def test_from_deal_enforces_owner_and_persists_user_id(accounts, mongo_db):
    a, b = accounts["a"], accounts["b"]
    create = a["session"].post(
        f"{BASE_URL}/api/agora/deals",
        json={"nom": f"{PREFIX}_DEAL_CLIENT", "entreprise": "TEST_QA", "valeur": 250, "etape": "GAGNÉ"},
        timeout=30,
    )
    assert create.status_code == 200, create.text
    deal = create.json()["deal"]
    try:
        denied = b["session"].post(
            f"{BASE_URL}/api/themis/from-deal", json={"deal_id": deal["id"], "kind": "devis"}, timeout=30
        )
        assert denied.status_code == 404
        generated = a["session"].post(
            f"{BASE_URL}/api/themis/from-deal", json={"deal_id": deal["id"], "kind": "devis"}, timeout=30
        )
        assert generated.status_code == 200, generated.text
        payload = generated.json()
        assert payload["client"]["user_id"] == a["user"]["user_id"]
        assert payload["doc"]["user_id"] == a["user"]["user_id"]
        assert mongo_db.themis_clients.find_one({"id": payload["client"]["id"]})["user_id"] == a["user"]["user_id"]
        assert mongo_db.themis_docs.find_one({"id": payload["doc"]["id"]})["user_id"] == a["user"]["user_id"]
    finally:
        mongo_db.agora_deals.delete_one({"id": deal["id"]})
        mongo_db.themis_clients.delete_many({"name": f"{PREFIX}_DEAL_CLIENT"})
        mongo_db.themis_docs.delete_many({"client_name": f"{PREFIX}_DEAL_CLIENT"})


def create_piece(session, suffix):
    response = session.post(
        f"{BASE_URL}/api/themis/pieces/upload",
        files={"file": (f"{PREFIX}_{suffix}.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")},
        timeout=90,
    )
    assert response.status_code == 200, response.text
    return response.json()["piece"]


# Accounting-piece reads and mutations must enforce owner filtering.
def test_account_b_cannot_download_a_piece(accounts, mongo_db):
    piece = create_piece(accounts["a"]["session"], "FILE")
    try:
        assert piece["user_id"] == accounts["a"]["user"]["user_id"]
        response = accounts["b"]["session"].get(f"{BASE_URL}/api/themis/pieces/{piece['id']}/file", timeout=30)
        assert response.status_code == 404
    finally:
        mongo_db.themis_pieces.delete_one({"id": piece["id"]})
        (Path("/app/backend/themis_files") / f"{piece['id']}.{piece['ext']}").unlink(missing_ok=True)


def test_account_b_cannot_update_a_piece(accounts, mongo_db):
    piece = create_piece(accounts["a"]["session"], "UPDATE")
    try:
        response = accounts["b"]["session"].put(
            f"{BASE_URL}/api/themis/pieces/{piece['id']}", json={"fournisseur": f"{PREFIX}_HACK"}, timeout=30
        )
        assert response.status_code in (200, 404)
        stored = mongo_db.themis_pieces.find_one({"id": piece["id"]})
        assert stored and stored.get("fournisseur", "") != f"{PREFIX}_HACK"
    finally:
        mongo_db.themis_pieces.delete_one({"id": piece["id"]})
        (Path("/app/backend/themis_files") / f"{piece['id']}.{piece['ext']}").unlink(missing_ok=True)


def test_account_b_cannot_delete_a_piece(accounts, mongo_db):
    piece = create_piece(accounts["a"]["session"], "DELETE")
    try:
        response = accounts["b"]["session"].delete(f"{BASE_URL}/api/themis/pieces/{piece['id']}", timeout=30)
        assert response.status_code in (200, 404)
        assert mongo_db.themis_pieces.find_one({"id": piece["id"]}) is not None
    finally:
        mongo_db.themis_pieces.delete_one({"id": piece["id"]})
        (Path("/app/backend/themis_files") / f"{piece['id']}.{piece['ext']}").unlink(missing_ok=True)


# The accounting export must be private and contain only the caller's records.
def test_account_b_export_does_not_contain_account_a_data(accounts, themis_data):
    response = accounts["b"]["session"].get(f"{BASE_URL}/api/themis/export", timeout=30)
    assert response.status_code == 200
    assert response.headers.get("content-type", "").startswith("application/zip")
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        combined = "\n".join(archive.read(name).decode("utf-8", errors="replace") for name in archive.namelist() if name.endswith(".csv"))
    assert themis_data["marker"] not in combined
    assert PREFIX not in combined


# Admin's first THÉMIS request claims legacy records in all six collections.
def test_admin_claims_legacy_themis_records(admin_session, mongo_db):
    session, admin = admin_session
    ids = []
    for index, collection in enumerate(THEMIS_COLLECTIONS):
        record_id = f"{PREFIX}_LEGACY_{index}"
        ids.append(record_id)
        mongo_db[collection].insert_one({"id": record_id, "name": record_id, "kind": "devis", "created_at": "2026-07-01T00:00:00+00:00"})
    try:
        response = session.get(f"{BASE_URL}/api/themis/clients", timeout=30)
        assert response.status_code == 200
        for collection, record_id in zip(THEMIS_COLLECTIONS, ids):
            record = mongo_db[collection].find_one({"id": record_id})
            assert record and record["user_id"] == admin["user_id"]
    finally:
        for collection, record_id in zip(THEMIS_COLLECTIONS, ids):
            mongo_db[collection].delete_one({"id": record_id})


# Admin endpoint and /auth/me expose roles safely and report requested activity counters.
def test_admin_users_authorization_roles_and_safe_activity(accounts, admin_session, themis_data, mongo_db):
    anonymous = requests.get(f"{BASE_URL}/api/admin/users", timeout=30)
    assert anonymous.status_code == 401
    forbidden = accounts["b"]["session"].get(f"{BASE_URL}/api/admin/users", timeout=30)
    assert forbidden.status_code == 403

    session, admin = admin_session
    me_admin = session.get(f"{BASE_URL}/api/auth/me", timeout=30)
    me_user = accounts["a"]["session"].get(f"{BASE_URL}/api/auth/me", timeout=30)
    assert me_admin.status_code == 200 and me_admin.json()["role"] == "admin"
    assert me_user.status_code == 200 and me_user.json()["role"] == "user"

    response = session.get(f"{BASE_URL}/api/admin/users", timeout=60)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["total"] == len(payload["users"])
    assert payload["total"] == mongo_db.users.count_documents({})
    assert all("password_hash" not in user and "_id" not in user for user in payload["users"])
    expected_activity = {"messages", "last_activity", "facts", "deals", "transactions", "themis_docs", "themis_clients"}
    assert all(set(user["activity"]) == expected_activity for user in payload["users"])
    assert all(isinstance(user["activity"][key], int) for user in payload["users"] for key in expected_activity - {"last_activity"})
    alpha = next(user for user in payload["users"] if user["user_id"] == accounts["a"]["user"]["user_id"])
    assert alpha["activity"]["themis_clients"] >= 1
    assert alpha["activity"]["themis_docs"] >= 2
    daniel = next(user for user in payload["users"] if user["user_id"] == admin["user_id"])
    assert daniel["role"] == "admin"


def test_admin_bcrypt_and_cookie_regression(mongo_db):
    email, password = load_admin_credentials()
    admin = mongo_db.users.find_one({"email": email.lower()})
    assert admin and admin["role"] == "admin"
    assert admin["password_hash"].startswith("$2b$")
    assert bcrypt.checkpw(password.encode(), admin["password_hash"].encode())
    response = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=30)
    assert response.status_code == 200 and response.json()["role"] == "admin"
    cookies = response.headers.get("set-cookie", "").lower()
    assert cookies.count("httponly") >= 2
    assert "secure" in cookies and "samesite=none" in cookies


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/agora/deals", None),
    ("GET", "/api/payments/transactions", None),
    ("POST", "/api/chat", {"text": "blocked", "session_id": PREFIX}),
])
def test_security_regression_routes_remain_private(method, path, body):
    response = requests.request(method, f"{BASE_URL}{path}", json=body, timeout=60)
    assert response.status_code == 401, f"{method} {path}: {response.status_code} {response.text[:300]}"



# Rapid A/B regression for Agora and payment transaction ownership.
def test_agora_and_payment_lists_remain_isolated_between_accounts(accounts, mongo_db):
    a, b = accounts["a"], accounts["b"]
    deal_response = a["session"].post(
        f"{BASE_URL}/api/agora/deals",
        json={"nom": f"{PREFIX}_REGRESSION_DEAL", "entreprise": "TEST_QA", "valeur": 10},
        timeout=30,
    )
    assert deal_response.status_code == 200, deal_response.text
    deal = deal_response.json()["deal"]
    transaction_id = f"{PREFIX}_REGRESSION_TX"
    mongo_db.payment_transactions.insert_one({
        "session_id": transaction_id,
        "deal_id": deal["id"],
        "deal_nom": deal["nom"],
        "user_id": a["user"]["user_id"],
        "amount": 100,
        "status": "initiated",
        "payment_status": "pending",
        "created_at": "2026-07-01T00:00:00+00:00",
    })
    try:
        deals_a = a["session"].get(f"{BASE_URL}/api/agora/deals", timeout=30)
        deals_b = b["session"].get(f"{BASE_URL}/api/agora/deals", timeout=30)
        assert deals_a.status_code == 200 and deals_b.status_code == 200
        assert deal["id"] in [item["id"] for item in deals_a.json()["deals"]]
        assert deal["id"] not in [item["id"] for item in deals_b.json()["deals"]]

        payments_a = a["session"].get(f"{BASE_URL}/api/payments/transactions", timeout=30)
        payments_b = b["session"].get(f"{BASE_URL}/api/payments/transactions", timeout=30)
        assert payments_a.status_code == 200 and payments_b.status_code == 200
        assert transaction_id in [item["session_id"] for item in payments_a.json()["transactions"]]
        assert transaction_id not in [item["session_id"] for item in payments_b.json()["transactions"]]
    finally:
        mongo_db.agora_deals.delete_one({"id": deal["id"]})
        mongo_db.payment_transactions.delete_one({"session_id": transaction_id})
