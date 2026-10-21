"""Offline payment reconciliation regressions; Stripe calls are always stubbed."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth_api
import payments_api
from local_docstore import LocalDocStore


def client_for(db):
    app = FastAPI()
    app.include_router(payments_api.make_payments_router(db), prefix="/api")
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize("payment_status,expected", [("unpaid", "pending"), ("paid", "paid")])
def test_checkout_complete_does_not_mean_payment_received(tmp_path, monkeypatch, payment_status, expected):
    db = LocalDocStore(tmp_path / "payment.db")
    asyncio.run(db.payment_transactions.insert_one({
        "session_id": "cs_test", "user_id": "u1", "payment_status": "pending", "status": "initiated",
    }))
    monkeypatch.setattr(auth_api, "require_user", AsyncMock(return_value={"user_id": "u1"}))
    monkeypatch.setattr(payments_api.stripe.checkout.Session, "retrieve", lambda *args: SimpleNamespace(
        payment_status=payment_status, status="complete", payment_intent="pi_test",
    ))
    response = client_for(db).get("/api/payments/status/cs_test")
    assert response.status_code == 200
    assert response.json()["payment_status"] == expected
    assert asyncio.run(db.payment_transactions.find_one({"session_id": "cs_test"}))["payment_status"] == expected


def test_failed_webhook_can_be_retried(tmp_path, monkeypatch):
    db = LocalDocStore(tmp_path / "webhook.db")
    event = {"id": "evt_retry", "type": "customer.subscription.updated", "data": {"object": {
        "id": "sub_test", "status": "active", "current_period_end": 1794441600,
        "metadata": {"user_id": "u1", "tier": "monthly"},
    }}}
    monkeypatch.setattr(payments_api.stripe.Webhook, "construct_event", lambda *args: event)
    licenses = db.user_licenses
    original_update = licenses.update_one
    update = AsyncMock(side_effect=RuntimeError("simulated database outage"))
    monkeypatch.setattr(licenses, "update_one", update)
    wrapped = SimpleNamespace(stripe_events=db.stripe_events, user_licenses=licenses)
    client = client_for(wrapped)
    assert client.post("/api/stripe/webhook", content="{}").status_code == 500
    assert asyncio.run(db.stripe_events.find_one({"event_id": "evt_retry"})) is None
    update.side_effect = original_update
    response = client.post("/api/stripe/webhook", content="{}")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert asyncio.run(db.user_licenses.find_one({"user_id": "u1"}))["status"] == "active"
    assert client.post("/api/stripe/webhook", content="{}").json() == {"status": "already_processed"}
    assert update.await_count == 2


def test_unpaid_checkout_does_not_grant_license(tmp_path, monkeypatch):
    db = LocalDocStore(tmp_path / "unpaid.db")
    asyncio.run(db.payment_transactions.insert_one({
        "session_id": "cs_unpaid", "user_id": "u1", "kind": "license", "tier": "standard",
        "payment_status": "pending", "status": "initiated",
    }))
    event = {"id": "evt_unpaid", "type": "checkout.session.completed", "data": {"object": {
        "id": "cs_unpaid", "payment_status": "unpaid", "payment_intent": "pi_unpaid",
    }}}
    monkeypatch.setattr(payments_api.stripe.Webhook, "construct_event", lambda *args: event)
    client = client_for(db)
    assert client.post("/api/stripe/webhook", content="{}").status_code == 200
    assert asyncio.run(db.user_licenses.find_one({"user_id": "u1"})) is None

    event.update(id="evt_paid", type="checkout.session.async_payment_succeeded")
    assert client.post("/api/stripe/webhook", content="{}").status_code == 200
    license_doc = asyncio.run(db.user_licenses.find_one({"user_id": "u1"}))
    assert (license_doc["tier"], license_doc["status"]) == ("standard", "active")
    transaction = asyncio.run(db.payment_transactions.find_one({"session_id": "cs_unpaid"}))
    assert (transaction["status"], transaction["payment_status"]) == ("completed", "paid")
