from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import payments_api
import paypal_api


CASES = [
    ("standard", "STRIPE_PRICE_STANDARD_69", 6900),
    ("pro", "STRIPE_PRICE_PRO_135", 13500),
    ("lifetime", "STRIPE_PRICE_LIFETIME_269", 26900),
    ("monthly", "STRIPE_PRICE_MONTHLY_32", 3200),
]


def price_record(tier, amount):
    return {"active": True, "currency": "eur", "unit_amount": amount,
            "recurring": {"interval": "month", "interval_count": 1} if tier == "monthly" else None}


def coupon_record(**changes):
    return {"valid": True, "duration": "once", "currency": "eur",
            "amount_off": 2200, "percent_off": None, **changes}


@pytest.mark.parametrize("change", [
    {"amount_off": 2100}, {"currency": "usd"}, {"duration": "forever"},
    {"duration": "repeating", "duration_in_months": 1}, {"valid": False},
    {"percent_off": 50}, {"applies_to": {"products": ["prod_other"]}},
])
def test_invalid_intro_discount_is_blocked(monkeypatch, change):
    monkeypatch.setenv("STRIPE_COUPON_MONTHLY_FIRST_10", "intro10")
    monkeypatch.setattr(payments_api.stripe.Coupon, "retrieve", lambda coupon_id: coupon_record(**change))
    with pytest.raises(HTTPException) as failure:
        payments_api._monthly_intro_coupon()
    assert failure.value.status_code == 503


def test_missing_intro_discount_is_explicit_error(monkeypatch):
    monkeypatch.delenv("STRIPE_COUPON_MONTHLY_FIRST_10", raising=False)
    with pytest.raises(HTTPException) as failure:
        payments_api._monthly_intro_coupon()
    assert failure.value.status_code == 503


def test_unavailable_discount_is_not_a_full_price_fallback(monkeypatch):
    monkeypatch.setenv("STRIPE_COUPON_MONTHLY_FIRST_10", "intro10")

    def unavailable(coupon_id):
        raise payments_api.stripe.error.APIConnectionError("unavailable")

    monkeypatch.setattr(payments_api.stripe.Coupon, "retrieve", unavailable)
    with pytest.raises(HTTPException) as failure:
        payments_api._monthly_intro_coupon()
    assert failure.value.status_code == 502


@pytest.mark.parametrize("tier,env,amount", CASES)
def test_stripe_uses_new_price_and_checks_amount_and_period(monkeypatch, tier, env, amount):
    monkeypatch.setenv(env, "price_reduced")
    monkeypatch.setattr(payments_api.stripe.Price, "retrieve", lambda price_id: price_record(tier, amount))
    assert payments_api._license_price(tier) == (tier, "price_reduced")


@pytest.mark.parametrize("tier,env,amount", CASES)
def test_old_environment_variables_are_not_a_fallback(monkeypatch, tier, env, amount):
    monkeypatch.delenv(env, raising=False)
    for old in ("STANDARD_79", "PRO_149", "LIFETIME_299", "MONTHLY_35"):
        monkeypatch.setenv(f"STRIPE_PRICE_{old}", "price_old")
    with pytest.raises(HTTPException) as failure:
        payments_api._license_price(tier)
    assert failure.value.status_code == 503


@pytest.mark.parametrize("change", [
    {"unit_amount": 7900}, {"currency": "usd"}, {"active": False},
    {"recurring": {"interval": "month", "interval_count": 1}},
])
def test_mismatched_price_is_blocked(monkeypatch, change):
    monkeypatch.setenv("STRIPE_PRICE_STANDARD_69", "price_reduced")
    monkeypatch.setattr(payments_api.stripe.Price, "retrieve",
                        lambda price_id: {**price_record("standard", 6900), **change})
    with pytest.raises(HTTPException) as failure:
        payments_api._license_price("standard")
    assert failure.value.status_code == 503


@pytest.mark.parametrize("recurring", [None, {"interval": "year", "interval_count": 1},
                                      {"interval": "month", "interval_count": 2}])
def test_monthly_price_requires_one_month_period(monkeypatch, recurring):
    monkeypatch.setenv("STRIPE_PRICE_MONTHLY_32", "price_reduced")
    monkeypatch.setattr(payments_api.stripe.Price, "retrieve",
                        lambda price_id: {**price_record("monthly", 3200), "recurring": recurring})
    with pytest.raises(HTTPException) as failure:
        payments_api._license_price("monthly")
    assert failure.value.status_code == 503


@pytest.mark.parametrize("tier,env,amount", CASES)
def test_public_checkout_uses_verified_price_and_correct_mode(monkeypatch, tier, env, amount):
    monkeypatch.setenv(env, "price_reduced")
    monkeypatch.setenv("SIRIUS_PUBLIC_ORIGINS", "https://sirius-assistant.fr")
    monkeypatch.setattr(payments_api.stripe.Price, "retrieve", lambda price_id: price_record(tier, amount))
    requests = []
    monkeypatch.setenv("STRIPE_COUPON_MONTHLY_FIRST_10", "intro10")
    monkeypatch.setenv("STRIPE_TRIAL_DAYS", "15")
    monkeypatch.setattr(payments_api.stripe.Coupon, "retrieve", lambda coupon_id: {
        "valid": True, "duration": "once", "currency": "eur", "amount_off": 2200, "percent_off": None,
    })

    def create(**kwargs):
        requests.append(kwargs)
        return SimpleNamespace(id="cs_test", url="https://checkout.stripe.com/test")

    monkeypatch.setattr(payments_api.stripe.checkout.Session, "create", create)
    db = SimpleNamespace(payment_transactions=SimpleNamespace(insert_one=AsyncMock(), find_one=AsyncMock(return_value=None)))
    app = FastAPI()
    app.include_router(payments_api.make_payments_router(db), prefix="/api")
    response = TestClient(app).post("/api/public/license-checkout", json={
        "email": "buyer@example.com", "tier": tier, "origin_url": "https://sirius-assistant.fr", "subscription_accepted": True,
    })
    assert response.status_code == 200, response.text
    assert requests[0]["line_items"] == [{"price": "price_reduced", "quantity": 1}]
    assert requests[0]["mode"] == ("subscription" if tier == "monthly" else "payment")
    if tier == "monthly":
        assert requests[0]["discounts"] == [{"coupon": "intro10"}]
        assert requests[0]["subscription_data"] == {"metadata": {"tier": tier, "user_id": "buyer@example.com"}}
        assert "trial_period_days" not in requests[0]["subscription_data"]
        assert amount - 2200 == 1000
    else:
        assert "discounts" not in requests[0]
        assert "subscription_data" not in requests[0]


def test_wrong_stripe_price_never_creates_a_session(monkeypatch):
    monkeypatch.setenv("STRIPE_PRICE_STANDARD_69", "price_old")
    monkeypatch.setenv("SIRIUS_PUBLIC_ORIGINS", "https://sirius-assistant.fr")
    monkeypatch.setattr(payments_api.stripe.Price, "retrieve", lambda price_id: price_record("standard", 7900))
    create = AsyncMock()
    monkeypatch.setattr(payments_api.stripe.checkout.Session, "create", create)
    db = SimpleNamespace(payment_transactions=SimpleNamespace(insert_one=AsyncMock()))
    app = FastAPI()
    app.include_router(payments_api.make_payments_router(db), prefix="/api")
    response = TestClient(app).post("/api/public/license-checkout", json={
        "email": "buyer@example.com", "tier": "standard", "origin_url": "https://sirius-assistant.fr",
    })
    assert response.status_code == 503
    create.assert_not_called()
    db.payment_transactions.insert_one.assert_not_called()


@pytest.mark.parametrize("authenticated", [False, True])
@pytest.mark.parametrize("previous", [None, {"status": "completed"}, {"status": "refunded"}])
def test_monthly_intro_once_across_public_and_account_checkout(monkeypatch, authenticated, previous):
    import auth_api

    monkeypatch.setenv("STRIPE_PRICE_MONTHLY_32", "price_monthly")
    monkeypatch.setenv("STRIPE_COUPON_MONTHLY_FIRST_10", "intro10")
    monkeypatch.setattr(payments_api.stripe.Price, "retrieve", lambda price_id: price_record("monthly", 3200))
    coupon_calls = []

    def retrieve(coupon_id):
        coupon_calls.append(coupon_id)
        return coupon_record()

    monkeypatch.setattr(payments_api.stripe.Coupon, "retrieve", retrieve)
    requests = []

    def create(**kwargs):
        requests.append(kwargs)
        return SimpleNamespace(id="cs_test", url="https://checkout.stripe.com/test")

    monkeypatch.setattr(payments_api.stripe.checkout.Session, "create", create)
    monkeypatch.setattr(auth_api, "require_user", AsyncMock(return_value={"user_id": "account-1"}))
    transactions = SimpleNamespace(insert_one=AsyncMock(), find_one=AsyncMock(return_value=previous))
    db = SimpleNamespace(payment_transactions=transactions, users=SimpleNamespace(
        find_one=AsyncMock(return_value={"email": "Buyer@Example.com"}),
    ))
    app = FastAPI()
    app.include_router(payments_api.make_payments_router(db), prefix="/api")
    path = "/api/licenses/checkout" if authenticated else "/api/public/license-checkout"
    body = {"email": "Buyer@Example.com", "tier": "monthly",
            "origin_url": "https://sirius-assistant.fr", "subscription_accepted": True}
    response = TestClient(app).post(path, json=body)
    assert response.status_code == 200, response.text
    if previous is None:
        assert requests[0]["discounts"] == [{"coupon": "intro10"}]
        assert coupon_calls == ["intro10"]
    else:
        assert "discounts" not in requests[0]
        assert not coupon_calls
    assert requests[0]["customer_email"] == "buyer@example.com"
    assert "trial_period_days" not in requests[0]["subscription_data"]
    query = transactions.find_one.call_args.args[0]
    assert {"buyer_email": "buyer@example.com"} in query["$or"]
    assert query["status"] == {"$in": ["completed", "refunded"]}
    assert transactions.insert_one.call_args.args[0]["intro_offer"] == (previous is None)


@pytest.mark.parametrize("consent", [False, "false", None])
def test_monthly_checkout_cannot_start_without_explicit_consent(monkeypatch, consent):
    monkeypatch.setenv("STRIPE_PRICE_MONTHLY_32", "price_monthly")
    monkeypatch.setattr(payments_api.stripe.Price, "retrieve", lambda price_id: price_record("monthly", 3200))
    create = AsyncMock()
    monkeypatch.setattr(payments_api.stripe.checkout.Session, "create", create)
    db = SimpleNamespace(payment_transactions=SimpleNamespace(insert_one=AsyncMock()))
    app = FastAPI()
    app.include_router(payments_api.make_payments_router(db), prefix="/api")
    response = TestClient(app).post("/api/public/license-checkout", json={
        "email": "buyer@example.com", "tier": "monthly", "origin_url": "https://sirius-assistant.fr",
        "subscription_accepted": consent,
    })
    assert response.status_code == 422
    create.assert_not_called()
    db.payment_transactions.insert_one.assert_not_called()


@pytest.mark.parametrize("subscription", [
    {"current_period_end": 1794441600},
    {"items": {"data": [{"current_period_end": 1794441600}]}},
])
def test_webhook_uses_stripe_billing_period_not_account_trial(monkeypatch, subscription):
    event = {"id": "evt_test", "type": "customer.subscription.updated", "data": {"object": {
        **subscription, "id": "sub_test", "status": "active", "cancel_at_period_end": True,
        "metadata": {"user_id": "buyer@example.com", "tier": "monthly"},
    }}}
    monkeypatch.setattr(payments_api.stripe.Webhook, "construct_event", lambda *args: event)
    db = SimpleNamespace(
        stripe_events=SimpleNamespace(find_one=AsyncMock(return_value=None), insert_one=AsyncMock()),
        user_licenses=SimpleNamespace(update_one=AsyncMock()),
    )
    app = FastAPI()
    app.include_router(payments_api.make_payments_router(db), prefix="/api")
    assert TestClient(app).post("/api/stripe/webhook", content="{}").status_code == 200
    stored = db.user_licenses.update_one.call_args.args[1]["$set"]
    assert stored["expires_at"] == "2026-11-12T00:00:00+00:00"
    assert stored["cancel_at_period_end"] is True


def test_checkout_completion_preserves_subscription_period(monkeypatch):
    event = {"id": "evt_checkout", "type": "checkout.session.completed", "data": {"object": {
        "id": "cs_test", "subscription": "sub_test", "payment_status": "paid",
    }}}
    monkeypatch.setattr(payments_api.stripe.Webhook, "construct_event", lambda *args: event)
    db = SimpleNamespace(
        stripe_events=SimpleNamespace(find_one=AsyncMock(return_value=None), insert_one=AsyncMock()),
        payment_transactions=SimpleNamespace(update_one=AsyncMock(), find_one=AsyncMock(
            return_value={"tier": "monthly", "user_id": "buyer@example.com"})),
        user_licenses=SimpleNamespace(update_one=AsyncMock()),
    )
    app = FastAPI()
    app.include_router(payments_api.make_payments_router(db), prefix="/api")
    assert TestClient(app).post("/api/stripe/webhook", content="{}").status_code == 200
    assert "expires_at" not in db.user_licenses.update_one.call_args.args[1]["$set"]


@pytest.mark.parametrize("tier,amount", [("standard", "69.00"), ("pro", "135.00"), ("lifetime", "269.00")])
def test_paypal_checkout_sends_reduced_amount(monkeypatch, tier, amount):
    monkeypatch.setenv("SIRIUS_PUBLIC_ORIGINS", "https://sirius-assistant.fr")
    monkeypatch.setattr(paypal_api, "_access_token", AsyncMock(return_value="test-token"))
    requests = []

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, **kwargs):
            requests.append(kwargs["json"])
            return SimpleNamespace(status_code=201, json=lambda: {
                "id": "order_test", "links": [{"rel": "approve", "href": "https://paypal.com/test"}],
            })

    monkeypatch.setattr(paypal_api.httpx, "AsyncClient", Client)
    db = SimpleNamespace(payment_transactions=SimpleNamespace(insert_one=AsyncMock()))
    app = FastAPI()
    app.include_router(paypal_api.make_paypal_router(db), prefix="/api")
    response = TestClient(app).post("/api/public/paypal-checkout", json={
        "email": "buyer@example.com", "tier": tier, "origin_url": "https://sirius-assistant.fr",
    })
    assert response.status_code == 200, response.text
    assert requests[0]["purchase_units"][0]["amount"] == {"currency_code": "EUR", "value": amount}
