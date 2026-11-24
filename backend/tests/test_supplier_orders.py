import asyncio
import uuid
from concurrent.futures import ThreadPoolExecutor
from email import policy
from email.parser import BytesParser
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

import supplier_orders as orders
from local_docstore import DatabaseRouter, LocalDocStore


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "0")
    db = DatabaseRouter(LocalDocStore(tmp_path / "b2b.sqlite3"))
    for uid in ("one", "two"):
        asyncio.run(db.users.insert_one({"user_id": uid, "email": f"{uid}@example.test"}))
    monkeypatch.setattr(orders, "access_status", AsyncMock(return_value={"allowed": True}))

    async def auth(request: Request, database):
        user = await database.users.find_one({"user_id": request.headers.get("x-test-user", "")})
        if not user:
            raise HTTPException(401, "Connexion requise.")
        return user

    monkeypatch.setattr(orders, "require_user", auth)
    app = FastAPI()
    app.include_router(orders.make_supplier_orders_router(db, lambda *_args, **_kwargs: True), prefix="/api")
    with TestClient(app) as client:
        yield client, db


def manage(user="one"):
    return {"x-test-user": user}


def supplier(client, name="Laiterie", price="0.10", basis="HT", user="one"):
    response = client.post("/api/supplier-orders/suppliers", headers=manage(user),
                           json={"name": name, "email": f"{name.lower()}@example.test", "price_basis": basis})
    assert response.status_code == 200, response.text
    row = response.json()
    saved = client.put(f"/api/supplier-orders/suppliers/{row['id']}/catalog", headers=manage(user),
                      json={"version": row["version"], "products": [
                          {"reference": "REF-1", "name": name, "unit": "kg", "price": price},
                      ]})
    assert saved.status_code == 200, saved.text
    return {**row, **saved.json()}


def invitation(client, user="one"):
    response = client.post("/api/supplier-orders/clients", headers=manage(user),
                           json={"name": "Restaurant essai", "email": "client@example.test"})
    assert response.status_code == 200, response.text
    result = response.json()
    return result, {orders.HEADER: result["url"].split("#k=")[1]}


def cart(client, headers, suppliers):
    catalog = client.get("/api/public/supplier-orders/catalog", headers=headers)
    assert catalog.status_code == 200, catalog.text
    return {
        "request_id": str(uuid.uuid4()), "catalog_version": catalog.json()["version"],
        "contact": "Contact essai", "delivery_address": "Adresse de démonstration", "note": "",
        "lines": [{"supplier_id": row["id"], "product_id": row["products"][0]["id"], "quantity": "3"}
                  for row in suppliers],
    }


def test_one_validation_splits_orders_exactly_without_sending(api):
    client, db = api
    dairy = supplier(client)
    butcher = supplier(client, "Boucherie", "0.3333", "TTC")
    _invite, headers = invitation(client)
    body = cart(client, headers, [dairy, butcher])
    response = client.post("/api/public/supplier-orders/orders", headers=headers, json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "test_not_sent"
    assert result["totals"] == {"HT": "0.30", "TTC": "1.00"}
    assert len(result["supplier_orders"]) == 2
    for part in result["supplier_orders"]:
        assert len(part["lines"]) == 1
        assert part["status"] == "test_not_sent"
        assert "email" not in part
        preview = client.get(
            f"/api/supplier-orders/orders/{result['id']}/suppliers/{part['supplier_id']}/message", headers=manage(),
        ).json()
        assert preview["sent"] is False
        message = BytesParser(policy=policy.default).parsebytes(preview["content"].encode())
        assert message["To"] == f"{part['supplier_name'].lower()}@example.test"
        content = message.get_content()
        other = "Boucherie" if part["supplier_name"] == "Laiterie" else "Laiterie"
        assert other not in content
        assert "SIMULATION" in content
    assert asyncio.run(db.b2b_orders.count_documents({})) == 1


def test_retries_are_atomic_and_payload_cannot_change(api):
    client, db = api
    row = supplier(client)
    _invite, headers = invitation(client)
    body = cart(client, headers, [row])
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: client.post(
            "/api/public/supplier-orders/orders", headers=headers, json=body,
        ), range(4)))
    assert all(response.status_code == 200 for response in responses)
    assert asyncio.run(db.b2b_orders.count_documents({})) == 1
    body["lines"][0]["quantity"] = "9"
    assert client.post("/api/public/supplier-orders/orders", headers=headers, json=body).status_code == 409


def test_scope_and_revocation_protect_catalog_and_orders(api):
    client, db = api
    own = supplier(client)
    other = supplier(client, "Autre", user="two")
    invite, headers = invitation(client)
    catalog = client.get("/api/public/supplier-orders/catalog", headers=headers)
    assert catalog.headers["cache-control"] == "no-store"
    assert [row["id"] for row in catalog.json()["suppliers"]] == [own["id"]]
    assert "email" not in catalog.json()["suppliers"][0]
    body = cart(client, headers, [other])
    assert client.post("/api/public/supplier-orders/orders", headers=headers, json=body).status_code == 422
    assert client.get("/api/supplier-orders", headers=headers).status_code == 401
    assert client.delete(f"/api/supplier-orders/clients/{invite['client']['id']}/link",
                         headers=manage("two")).status_code == 404
    assert client.delete(f"/api/supplier-orders/clients/{invite['client']['id']}/link",
                         headers=manage()).status_code == 200
    assert client.get("/api/public/supplier-orders/catalog", headers=headers).status_code == 401
    assert client.post("/api/public/supplier-orders/orders", headers=headers, json=body).status_code == 401
    stored = asyncio.run(db.b2b_clients.find_one({"id": invite["client"]["id"]}))
    assert "token" not in stored


@pytest.mark.parametrize("quantity", ["0", "-1", True, 1.5, "NaN", "1.00001"])
def test_invalid_quantities_never_create_orders(api, quantity):
    client, db = api
    row = supplier(client)
    _invite, headers = invitation(client)
    body = cart(client, headers, [row])
    body["lines"][0]["quantity"] = quantity
    assert client.post("/api/public/supplier-orders/orders", headers=headers, json=body).status_code == 422
    assert asyncio.run(db.b2b_orders.count_documents({})) == 0


def test_price_change_requires_review_and_existing_receipt_stays_immutable(api):
    client, db = api
    row = supplier(client)
    _invite, headers = invitation(client)
    body = cart(client, headers, [row])
    original = client.post("/api/public/supplier-orders/orders", headers=headers, json=body).json()
    payload = {"version": row["version"], "products": [
        {"reference": "REF-1", "name": "Laiterie", "unit": "kg", "price": "8.00"},
    ]}
    assert client.put(f"/api/supplier-orders/suppliers/{row['id']}/catalog",
                      headers=manage(), json=payload).status_code == 200
    assert client.put(f"/api/supplier-orders/suppliers/{row['id']}/catalog",
                      headers=manage(), json=payload).status_code == 409
    retried = client.post("/api/public/supplier-orders/orders", headers=headers, json=body).json()
    assert retried == original
    body["request_id"] = str(uuid.uuid4())
    assert client.post("/api/public/supplier-orders/orders", headers=headers, json=body).status_code == 409
    body["catalog_version"] = client.get("/api/public/supplier-orders/catalog", headers=headers).json()["version"]
    body["lines"][0]["price"] = "0.01"
    assert client.post("/api/public/supplier-orders/orders", headers=headers, json=body).status_code == 422


def test_csv_preview_handles_quotes_decimals_and_does_not_save(api):
    client, db = api
    row = supplier(client)
    path = f"/api/supplier-orders/suppliers/{row['id']}/catalog/preview"
    text = '\ufeffreference;nom;unite;prix\r\nLAIT;"Lait; entier";litre;1,2345\r\n'
    preview = client.post(path, headers=manage(), json={"csv": text})
    assert preview.status_code == 200, preview.text
    assert preview.json()["products"] == [
        {"reference": "LAIT", "name": "Lait; entier", "unit": "litre", "price": "1.2345"},
    ]
    assert asyncio.run(db.b2b_suppliers.find_one({"id": row["id"]}))["products"][0]["reference"] == "REF-1"
    for invalid in ("\ufeff", '"reference;nom;unite;prix', "nom;prix\nLait;1", "reference;nom;unite;prix\nA;Lait;l;\n",
                    "reference;nom;unite;prix\nA;Lait;l;1\nA;Autre;l;2"):
        assert client.post(path, headers=manage(), json={"csv": invalid}).status_code == 422
    assert client.post(path, headers=manage("two"), json={"csv": text}).status_code == 404


def test_decimal_exponents_are_normalized_for_the_browser(api):
    client, _db = api
    row = supplier(client, price="1E+2")
    assert row["products"][0]["price"] == "100"
    _invite, headers = invitation(client)
    body = cart(client, headers, [row])
    body["lines"][0]["quantity"] = "1E+2"
    saved = client.post("/api/public/supplier-orders/orders", headers=headers, json=body)
    assert saved.status_code == 200
    assert saved.json()["supplier_orders"][0]["lines"][0]["quantity"] == "100"
    assert saved.json()["totals"] == {"HT": "10000.00"}


def test_membership_and_owner_access_are_rechecked(api, monkeypatch):
    client, db = api
    _invite, headers = invitation(client)
    monkeypatch.setattr(orders, "access_status", AsyncMock(return_value={"allowed": False}))
    assert client.get("/api/public/supplier-orders/catalog", headers=headers).status_code == 402
    monkeypatch.setattr(orders, "access_status", AsyncMock(return_value={"allowed": True}))
    asyncio.run(db.enterprise_companies.insert_one({"id": "company"}))
    asyncio.run(db.enterprise_members.insert_one({"company_id": "company", "user_id": "one", "role": "viewer"}))
    assert client.get("/api/supplier-orders", headers=manage()).status_code == 403
    assert client.get("/api/public/supplier-orders/catalog", headers=headers).status_code == 403
    asyncio.run(db.enterprise_members.update_one({"user_id": "one"}, {"$set": {"role": "manager"}}))
    assert client.get("/api/supplier-orders", headers=manage()).status_code == 200
    assert client.get("/api/public/supplier-orders/catalog", headers=headers).status_code == 401


def test_company_catalogs_are_isolated_and_shared_only_with_their_managers(api):
    client, db = api
    for uid in ("one", "two"):
        asyncio.run(db.enterprise_companies.insert_one({"id": f"company-{uid}"}))
        asyncio.run(db.enterprise_members.insert_one({
            "company_id": f"company-{uid}", "user_id": uid, "role": "manager",
        }))
    own = supplier(client)
    other = supplier(client, "Autre", user="two")
    _invite, headers = invitation(client)
    visible = client.get("/api/public/supplier-orders/catalog", headers=headers).json()["suppliers"]
    assert [row["id"] for row in visible] == [own["id"]]
    workspace = client.get("/api/supplier-orders", headers=manage("two")).json()
    assert [row["id"] for row in workspace["suppliers"]] == [other["id"]]
    assert workspace["clients"] == []
    asyncio.run(db.enterprise_members.update_one(
        {"user_id": "two"}, {"$set": {"company_id": "company-one"}},
    ))
    shared = client.get("/api/supplier-orders", headers=manage("two")).json()
    assert [row["id"] for row in shared["suppliers"]] == [own["id"]]
    assert len(shared["clients"]) == 1


def test_packaged_management_proxies_to_same_cloud_portal(api, monkeypatch):
    client, _db = api
    monkeypatch.setattr(orders.cloud_link, "relay_allowed", lambda: True)
    monkeypatch.setattr(orders, "is_direct_local_request", lambda _request: True)
    relay = AsyncMock(return_value={"mode": "test", "suppliers": []})
    monkeypatch.setattr(orders.cloud_link, "relay_supplier_orders", relay)
    assert client.get("/api/supplier-orders", headers=manage()).json()["mode"] == "test"
    relay.assert_awaited_once_with("GET", "")
    monkeypatch.setattr(orders, "is_direct_local_request", lambda _request: False)
    assert client.get("/api/supplier-orders", headers=manage()).status_code == 403
