# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
# Paiement PayPal (second moyen de paiement, en complément de Stripe) pour les licences
# publiques uniques (Standard/Pro/Lifetime). L'abonnement mensuel reste Stripe uniquement.
import os
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, EmailStr

_LOCAL_CHECKOUT_ORIGINS = {"http://localhost:3000", "http://127.0.0.1:3000"}

# Mêmes tarifs que Stripe (prix public, EUR) — l'abonnement mensuel n'est pas proposé ici.
_LICENSE_PRICES_EUR = {
    "standard": "79.00",
    "pro": "149.00",
    "lifetime": "299.00",
}


def _api_base() -> str:
    mode = (os.getenv("PAYPAL_MODE") or "live").strip().lower()
    return "https://api-m.sandbox.paypal.com" if mode == "sandbox" else "https://api-m.paypal.com"


def _checkout_origin(origin_url: str) -> str:
    configured = {
        value.strip().rstrip("/")
        for value in os.environ.get("SIRIUS_PUBLIC_ORIGINS", "https://sirius-assistant.fr").split(",")
        if value.strip()
    }
    allowed = configured | _LOCAL_CHECKOUT_ORIGINS
    candidate = (origin_url or "").strip().rstrip("/")
    parsed = urlparse(candidate)
    if (
        candidate not in allowed
        or parsed.scheme not in {"http", "https"}
        or parsed.path
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise HTTPException(status_code=400, detail="Origine de retour PayPal non autorisée.")
    return candidate


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class PaypalCheckoutIn(BaseModel):
    tier: str
    origin_url: str
    email: EmailStr
    phone: str | None = None


class PaypalCaptureIn(BaseModel):
    order_id: str


async def _access_token() -> str:
    client_id = (os.getenv("PAYPAL_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("PAYPAL_CLIENT_SECRET") or "").strip()
    if not client_id or not client_secret:
        raise HTTPException(status_code=503, detail="PayPal n'est pas encore configuré.")
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            f"{_api_base()}/v1/oauth2/token",
            data={"grant_type": "client_credentials"},
            auth=(client_id, client_secret),
        )
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="PayPal indisponible (authentification).")
    return response.json()["access_token"]


def make_paypal_router(db):
    r = APIRouter()

    @r.post("/public/paypal-checkout")
    async def paypal_checkout(body: PaypalCheckoutIn):
        origin = _checkout_origin(body.origin_url)
        tier = (body.tier or "").strip().lower()
        amount = _LICENSE_PRICES_EUR.get(tier)
        if not amount:
            raise HTTPException(status_code=400, detail="Cette licence n'est pas disponible via PayPal.")
        buyer_email = str(body.email).strip().lower()
        token = await _access_token()
        order_payload = {
            "intent": "CAPTURE",
            "purchase_units": [{
                "amount": {"currency_code": "EUR", "value": amount},
                "description": f"ΣIRIUS — licence {tier}",
                "custom_id": tier,
            }],
            "application_context": {
                "brand_name": "ΣIRIUS",
                "return_url": f"{origin}/?payment=paypal-return",
                "cancel_url": f"{origin}/?payment=cancel",
                "user_action": "PAY_NOW",
            },
        }
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                f"{_api_base()}/v2/checkout/orders",
                json=order_payload,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            )
        if response.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail="PayPal indisponible (création de commande).")
        order = response.json()
        approve_url = next((link["href"] for link in order.get("links", []) if link.get("rel") == "approve"), None)
        if not approve_url:
            raise HTTPException(status_code=502, detail="Lien d'approbation PayPal introuvable.")
        await db.payment_transactions.insert_one({
            "session_id": order["id"], "user_id": buyer_email, "buyer_email": buyer_email,
            "buyer_phone": (body.phone or "").strip(),
            "kind": "license", "tier": tier, "provider": "paypal",
            "status": "initiated", "payment_status": "pending",
            "created_at": now_iso(), "updated_at": now_iso(),
        })
        return {"approve_url": approve_url, "order_id": order["id"], "tier": tier}

    @r.post("/public/paypal-capture")
    async def paypal_capture(body: PaypalCaptureIn):
        transaction = await db.payment_transactions.find_one(
            {"session_id": body.order_id, "kind": "license", "provider": "paypal"}, {"_id": 0}
        )
        if not transaction:
            raise HTTPException(status_code=404, detail="Commande PayPal introuvable.")
        if transaction.get("payment_status") == "paid":
            return {"status": "already_captured", "tier": transaction["tier"]}
        token = await _access_token()
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                f"{_api_base()}/v2/checkout/orders/{body.order_id}/capture",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            )
        if response.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail="Échec de la capture du paiement PayPal.")
        capture = response.json()
        if capture.get("status") != "COMPLETED":
            raise HTTPException(status_code=402, detail="Paiement PayPal non finalisé.")
        tier = transaction["tier"]
        await db.payment_transactions.update_one(
            {"session_id": body.order_id},
            {"$set": {"status": "completed", "payment_status": "paid", "updated_at": now_iso()}},
        )
        await db.user_licenses.update_one(
            {"user_id": transaction["user_id"]},
            {"$set": {
                "user_id": transaction["user_id"], "tier": tier, "status": "active",
                "paypal_order_id": body.order_id, "updated_at": now_iso(),
                "expires_at": None,
            }},
            upsert=True,
        )
        return {"status": "ok", "tier": tier}

    return r
