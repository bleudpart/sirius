# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
# Paiements Stripe pour les deals Hermès Agora : lien d'encaissement (acompte ou total), suivi, webhook.
import os
import asyncio
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import stripe
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, EmailStr

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
_LOCAL_CHECKOUT_ORIGINS = {"http://localhost:3000", "http://127.0.0.1:3000"}


def _checkout_origin(origin_url: str) -> str:
    """Accept only exact configured HTTPS origins for Stripe return redirects."""
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
        raise HTTPException(status_code=400, detail="Origine de retour Stripe non autorisée.")
    return candidate


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class DealCheckoutIn(BaseModel):
    deal_id: str
    percent: int = 30
    origin_url: str


class LicenseCheckoutIn(BaseModel):
    tier: str
    origin_url: str


class PublicLicenseCheckoutIn(LicenseCheckoutIn):
    email: EmailStr


class PublicLicensePortalIn(BaseModel):
    session_id: str
    origin_url: str


_LICENSE_PRICE_ENV = {
    "standard": "STRIPE_PRICE_STANDARD_79",
    "pro": "STRIPE_PRICE_PRO_149",
    "lifetime": "STRIPE_PRICE_LIFETIME_299",
    "monthly": "STRIPE_PRICE_MONTHLY_35",
}


def _license_price(tier: str) -> tuple[str, str]:
    normalized = (tier or "").strip().lower()
    env_name = _LICENSE_PRICE_ENV.get(normalized)
    price_id = (os.getenv(env_name or "") or "").strip()
    if not env_name or not price_id.startswith("price_"):
        raise HTTPException(status_code=503, detail="Cette licence Stripe n'est pas encore configurée.")
    return normalized, price_id


def make_payments_router(db):
    r = APIRouter()

    async def _uid(request: Request) -> str:
        from auth_api import require_user
        user = await require_user(request, db)
        uid = user["user_id"]
        if user.get("role") == "admin":
            await db.payment_transactions.update_many({"user_id": {"$exists": False}}, {"$set": {"user_id": uid}})
        return uid

    def _create_session(kwargs):
        # Cascade fiscale : gestion complète Stripe → calcul de taxe → paiement simple
        try:
            return stripe.checkout.Session.create(**kwargs, managed_payments={"enabled": True})
        except stripe.error.StripeError:
            pass
        try:
            return stripe.checkout.Session.create(**kwargs, automatic_tax={"enabled": True},
                                                  billing_address_collection="required")
        except stripe.error.StripeError:
            pass
        return stripe.checkout.Session.create(**kwargs)

    @r.post("/payments/deal-checkout")
    async def deal_checkout(body: DealCheckoutIn, request: Request):
        uid = await _uid(request)
        origin = _checkout_origin(body.origin_url)
        deal = await db.agora_deals.find_one({"id": body.deal_id, "user_id": uid}, {"_id": 0})
        if not deal:
            raise HTTPException(status_code=404, detail="Deal introuvable.")
        pct = body.percent if body.percent in (10, 20, 30, 40, 50, 100) else 30
        valeur = float(deal.get("valeur") or 0)
        amount_cents = int(round(valeur * 100 * pct / 100))
        if amount_cents < 50:
            raise HTTPException(status_code=400, detail="Montant trop faible — le deal doit valoir au moins 0,50 €.")
        if amount_cents > 99999900:
            raise HTTPException(status_code=400, detail="Montant trop élevé.")
        label = f"{'Acompte ' + str(pct) + '% — ' if pct < 100 else 'Règlement — '}{deal.get('nom', 'Client')}"
        if deal.get("entreprise"):
            label += f" ({deal['entreprise']})"
        kwargs = dict(
            line_items=[{
                "price_data": {
                    "currency": "eur",
                    "unit_amount": amount_cents,
                    "product_data": {"name": label[:120]},
                },
                "quantity": 1,
            }],
            mode="payment",
            success_url=f"{origin}/?payment=success&session_id={{CHECKOUT_SESSION_ID}}",
            cancel_url=f"{origin}/?payment=cancel",
            metadata={"deal_id": deal["id"], "percent": str(pct)},
        )
        try:
            session = await asyncio.to_thread(_create_session, kwargs)
        except stripe.error.StripeError as e:
            raise HTTPException(status_code=502, detail=f"Stripe indisponible : {str(e)[:120]}")
        await db.payment_transactions.insert_one({
            "session_id": session.id, "user_id": uid, "deal_id": deal["id"], "deal_nom": deal.get("nom", ""),
            "deal_entreprise": deal.get("entreprise", ""), "deal_email": deal.get("email", ""),
            "checkout_url": session.url,
            "percent": pct, "amount": amount_cents, "currency": "eur",
            "status": "initiated", "payment_status": "pending",
            "created_at": now_iso(), "updated_at": now_iso(),
        })
        return {"checkout_url": session.url, "session_id": session.id, "amount": amount_cents}

    @r.post("/licenses/checkout")
    async def license_checkout(body: LicenseCheckoutIn, request: Request):
        uid = await _uid(request)
        origin = _checkout_origin(body.origin_url)
        tier, price_id = _license_price(body.tier)
        subscription = tier == "monthly"
        trial_days = max(0, min(int(os.getenv("STRIPE_TRIAL_DAYS", "7")), 30))
        kwargs = {
            "line_items": [{"price": price_id, "quantity": 1}],
            "mode": "subscription" if subscription else "payment",
            "success_url": f"{origin}/?payment=success&session_id={{CHECKOUT_SESSION_ID}}",
            "cancel_url": f"{origin}/?payment=cancel",
            "client_reference_id": uid,
            "metadata": {"kind": "license", "tier": tier, "user_id": uid},
        }
        if subscription and trial_days:
            kwargs["subscription_data"] = {"trial_period_days": trial_days, "metadata": {"tier": tier, "user_id": uid}}
        try:
            session = await asyncio.to_thread(stripe.checkout.Session.create, **kwargs)
        except stripe.error.StripeError as error:
            raise HTTPException(status_code=502, detail=f"Stripe indisponible : {str(error)[:120]}") from error
        await db.payment_transactions.insert_one({
            "session_id": session.id, "user_id": uid, "kind": "license", "tier": tier,
            "price_id": price_id, "status": "initiated", "payment_status": "pending",
            "created_at": now_iso(), "updated_at": now_iso(),
        })
        return {"checkout_url": session.url, "session_id": session.id, "tier": tier}

    @r.post("/public/license-checkout")
    async def public_license_checkout(body: PublicLicenseCheckoutIn, request: Request):
        origin = _checkout_origin(body.origin_url)
        tier, price_id = _license_price(body.tier)
        buyer_email = str(body.email).strip().lower()
        subscription = tier == "monthly"
        trial_days = max(0, min(int(os.getenv("STRIPE_TRIAL_DAYS", "7")), 30))
        kwargs = {
            "line_items": [{"price": price_id, "quantity": 1}],
            "mode": "subscription" if subscription else "payment",
            "success_url": f"{origin}/?payment=success&session_id={{CHECKOUT_SESSION_ID}}",
            "cancel_url": f"{origin}/?payment=cancel",
            "customer_email": buyer_email,
            "metadata": {"kind": "license", "tier": tier, "user_id": buyer_email, "buyer_email": buyer_email},
        }
        if subscription and trial_days:
            kwargs["subscription_data"] = {"trial_period_days": trial_days, "metadata": {"tier": tier, "user_id": buyer_email}}
        try:
            session = await asyncio.to_thread(stripe.checkout.Session.create, **kwargs)
        except stripe.error.StripeError as error:
            raise HTTPException(status_code=502, detail=f"Stripe indisponible : {str(error)[:120]}") from error
        await db.payment_transactions.insert_one({
            "session_id": session.id, "user_id": buyer_email, "buyer_email": buyer_email,
            "kind": "license", "tier": tier, "price_id": price_id,
            "status": "initiated", "payment_status": "pending",
            "created_at": now_iso(), "updated_at": now_iso(),
        })
        return {"checkout_url": session.url, "session_id": session.id, "tier": tier}

    @r.post("/public/license-portal")
    async def public_license_portal(body: PublicLicensePortalIn):
        origin = _checkout_origin(body.origin_url)
        transaction = await db.payment_transactions.find_one(
            {"session_id": body.session_id, "kind": "license", "tier": "monthly"},
            {"_id": 0},
        )
        if not transaction:
            raise HTTPException(status_code=404, detail="Abonnement introuvable.")
        try:
            checkout = await asyncio.to_thread(stripe.checkout.Session.retrieve, body.session_id)
            customer_id = checkout.get("customer")
            if not customer_id:
                raise HTTPException(status_code=400, detail="Client Stripe indisponible.")
            kwargs = {"customer": customer_id, "return_url": f"{origin}/?payment=managed"}
            configuration = os.getenv("STRIPE_BILLING_PORTAL_CONFIGURATION", "").strip()
            if configuration:
                kwargs["configuration"] = configuration
            portal = await asyncio.to_thread(stripe.billing_portal.Session.create, **kwargs)
        except HTTPException:
            raise
        except stripe.error.StripeError as error:
            raise HTTPException(status_code=502, detail=f"Portail Stripe indisponible : {str(error)[:120]}") from error
        return {"portal_url": portal.url}
    @r.post("/public/license-portal")
    async def public_license_portal(body: PublicLicensePortalIn):
        origin = _checkout_origin(body.origin_url)
        transaction = await db.payment_transactions.find_one(
            {"session_id": body.session_id, "kind": "license", "tier": "monthly"},
            {"_id": 0},
        )
        if not transaction:
            raise HTTPException(status_code=404, detail="Abonnement introuvable.")
        try:
            checkout = await asyncio.to_thread(stripe.checkout.Session.retrieve, body.session_id)
            customer_id = checkout.get("customer")
            if not customer_id:
                raise HTTPException(status_code=400, detail="Le client Stripe est indisponible.")
            kwargs = {"customer": customer_id, "return_url": f"{origin}/?payment=managed"}
            configuration = (os.getenv("STRIPE_BILLING_PORTAL_CONFIGURATION") or "").strip()
            if configuration:
                kwargs["configuration"] = configuration
            portal = await asyncio.to_thread(stripe.billing_portal.Session.create, **kwargs)
        except HTTPException:
            raise
        except stripe.error.StripeError as error:
            raise HTTPException(status_code=502, detail=f"Portail Stripe indisponible : {str(error)[:120]}") from error
        return {"portal_url": portal.url}

    @r.get("/licenses/me")
    async def license_status(request: Request):
        uid = await _uid(request)
        license_doc = await db.user_licenses.find_one({"user_id": uid}, {"_id": 0})
        return {"license": license_doc or {"tier": "free", "status": "inactive"}}

    async def _sync_from_stripe(record):
        try:
            s = await asyncio.to_thread(stripe.checkout.Session.retrieve, record["session_id"])
            if s.payment_status == "paid" or s.status == "complete":
                await db.payment_transactions.update_one(
                    {"session_id": record["session_id"], "payment_status": {"$ne": "paid"}},
                    {"$set": {"status": "completed", "payment_status": "paid",
                              "stripe_payment_intent_id": s.payment_intent, "updated_at": now_iso()}})
                return await db.payment_transactions.find_one({"session_id": record["session_id"]}, {"_id": 0})
        except stripe.error.StripeError:
            pass
        return record

    @r.get("/payments/status/{session_id}")
    async def payment_status(session_id: str, request: Request):
        uid = await _uid(request)
        record = await db.payment_transactions.find_one({"session_id": session_id, "user_id": uid}, {"_id": 0})
        if not record:
            raise HTTPException(status_code=404, detail="Transaction introuvable.")
        if record.get("payment_status") != "paid":
            record = await _sync_from_stripe(record)
        return {"session_id": record["session_id"], "status": record["status"],
                "payment_status": record["payment_status"], "deal_id": record.get("deal_id"),
                "amount": record.get("amount"), "percent": record.get("percent")}

    @r.get("/payments/deals-status")
    async def payments_deals_status(request: Request):
        uid = await _uid(request)
        txs = await db.payment_transactions.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(500)
        # Rafraîchit les transactions encore en attente (récentes)
        for t in [t for t in txs if t.get("payment_status") == "pending"][:6]:
            await _sync_from_stripe(t)
        txs = await db.payment_transactions.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(500)
        by_deal = {}
        for t in txs:
            d = by_deal.setdefault(t.get("deal_id"), {"paid": 0, "pending": 0, "amount_paid": 0})
            if t.get("payment_status") == "paid":
                d["paid"] += 1
                d["amount_paid"] += t.get("amount", 0)
            elif t.get("payment_status") == "pending":
                d["pending"] += 1
        return {"deals": by_deal}

    @r.get("/payments/transactions")
    async def payments_transactions(request: Request):
        uid = await _uid(request)
        txs = await db.payment_transactions.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(300)
        for t in [t for t in txs if t.get("payment_status") == "pending"][:6]:
            await _sync_from_stripe(t)
        txs = await db.payment_transactions.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(300)
        return {"transactions": txs}

    @r.get("/payments/receipt/{session_id}")
    async def payment_receipt(session_id: str, request: Request):
        uid = await _uid(request)
        tx = await db.payment_transactions.find_one({"session_id": session_id, "user_id": uid}, {"_id": 0})
        if not tx:
            raise HTTPException(status_code=404, detail="Transaction introuvable.")
        if tx.get("payment_status") != "paid":
            tx = await _sync_from_stripe(tx)
        if tx.get("payment_status") != "paid":
            raise HTTPException(status_code=400, detail="Le paiement n'est pas encore confirmé — pas de reçu.")
        from themis_pdf import build_receipt_pdf
        from fastapi.responses import StreamingResponse
        buf = build_receipt_pdf(tx)
        return StreamingResponse(buf, media_type="application/pdf",
                                 headers={"Content-Disposition": 'attachment; filename="recu-paiement.pdf"'})

    class RemindIn(BaseModel):
        session_id: str
        smtp: dict = {}

    @r.post("/payments/remind")
    async def payment_remind(body: RemindIn, request: Request):
        uid = await _uid(request)
        tx = await db.payment_transactions.find_one({"session_id": body.session_id, "user_id": uid}, {"_id": 0})
        if not tx:
            raise HTTPException(status_code=404, detail="Transaction introuvable.")
        if tx.get("payment_status") == "paid":
            raise HTTPException(status_code=400, detail="Ce paiement est déjà encaissé.")
        to = (tx.get("deal_email") or "").strip()
        if "@" not in to:
            raise HTTPException(status_code=400, detail="Aucune adresse e-mail sur ce deal — ajoutez-la dans le pipeline.")
        if not (body.smtp or {}).get("host"):
            raise HTTPException(status_code=400, detail="Serveur SMTP non configuré — renseignez-le dans THÉMIS (Réglages).")
        from themis_api import SmtpConf, _send_smtp
        conf = SmtpConf(**body.smtp)
        montant = f"{tx.get('amount', 0) / 100:.2f} €".replace(".", ",")
        label = "l'acompte de " + str(tx.get("percent")) + "%" if tx.get("percent", 100) < 100 else "le règlement"
        subject = f"Rappel — paiement en attente ({montant})"
        message = (
            f"Bonjour {tx.get('deal_nom', '')},\n\n"
            f"Sauf erreur de notre part, {label} de {montant} reste en attente de règlement.\n"
            f"Vous pouvez payer en toute sécurité via ce lien :\n{tx.get('checkout_url', '')}\n\n"
            "Merci, et belle journée.\n"
        )
        try:
            await asyncio.to_thread(_send_smtp, conf, to, subject, message, b"", "")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Envoi impossible : {str(e)[:140]}")
        await db.payment_transactions.update_one({"session_id": body.session_id},
                                                 {"$set": {"reminded_at": now_iso()}})
        return {"ok": True, "to": to}

    @r.post("/stripe/webhook")
    async def stripe_webhook(request: Request):
        payload = await request.body()
        sig = request.headers.get("stripe-signature", "")
        try:
            event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
        except Exception:
            raise HTTPException(status_code=400, detail="Signature invalide.")
        obj, t = event["data"]["object"], event["type"]
        if await db.stripe_events.find_one({"event_id": event["id"]}, {"_id": 0}):
            return {"status": "already_processed"}
        await db.stripe_events.insert_one({"event_id": event["id"], "type": t, "received_at": now_iso()})
        if t == "checkout.session.completed":
            await db.payment_transactions.update_one(
                {"session_id": obj["id"], "payment_status": {"$ne": "paid"}},
                {"$set": {"status": "completed", "payment_status": obj.get("payment_status", "paid"),
                          "stripe_payment_intent_id": obj.get("payment_intent"), "updated_at": now_iso()}})
            transaction = await db.payment_transactions.find_one({"session_id": obj["id"], "kind": "license"}, {"_id": 0})
            if transaction:
                tier = transaction["tier"]
                subscription_id = obj.get("subscription")
                await db.user_licenses.update_one(
                    {"user_id": transaction["user_id"]},
                    {"$set": {
                        "user_id": transaction["user_id"], "tier": tier,
                        "status": "trialing" if tier == "monthly" and obj.get("payment_status") == "no_payment_required" else "active",
                        "stripe_customer_id": obj.get("customer"), "stripe_subscription_id": subscription_id,
                        "updated_at": now_iso(),
                        "expires_at": None if tier == "lifetime" else (datetime.now(timezone.utc) + timedelta(days=max(0, int(os.getenv("STRIPE_TRIAL_DAYS", "7"))))).isoformat() if tier == "monthly" else None,
                    }},
                    upsert=True,
                )
        elif t in {"customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"}:
            metadata = obj.get("metadata") or {}
            uid, tier = metadata.get("user_id"), metadata.get("tier")
            if uid and tier:
                await db.user_licenses.update_one(
                    {"user_id": uid},
                    {"$set": {"tier": tier, "status": "canceled" if t.endswith("deleted") else obj.get("status", "active"), "stripe_subscription_id": obj.get("id"), "updated_at": now_iso()}},
                    upsert=True,
                )
        elif t in {"invoice.payment_succeeded", "invoice.payment_failed"}:
            subscription_id = obj.get("subscription")
            if subscription_id:
                await db.user_licenses.update_one(
                    {"stripe_subscription_id": subscription_id},
                    {"$set": {"status": "active" if t.endswith("succeeded") else "past_due", "updated_at": now_iso()}},
                )
        elif t == "checkout.session.async_payment_succeeded":
            await db.payment_transactions.update_one({"session_id": obj["id"]},
                {"$set": {"payment_status": "paid", "updated_at": now_iso()}})
        elif t == "checkout.session.async_payment_failed":
            await db.payment_transactions.update_one({"session_id": obj["id"]},
                {"$set": {"status": "failed", "payment_status": "failed", "updated_at": now_iso()}})
        elif t == "checkout.session.expired":
            await db.payment_transactions.update_one({"session_id": obj["id"]},
                {"$set": {"status": "expired", "payment_status": "expired", "updated_at": now_iso()}})
        elif t == "charge.refunded":
            await db.payment_transactions.update_one({"stripe_payment_intent_id": obj.get("payment_intent")},
                {"$set": {"status": "refunded", "payment_status": "refunded", "updated_at": now_iso()}})
        return {"status": "ok"}

    return r
