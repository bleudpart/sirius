# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
# Paiements Stripe pour les deals Hermès Agora : lien d'encaissement (acompte ou total), suivi, webhook.
import os
import asyncio
import logging
from datetime import datetime, timezone
from urllib.parse import urlparse

import stripe
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, EmailStr, StrictBool

from email_signature import load_signature_identity

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
logger = logging.getLogger(__name__)
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
    subscription_accepted: StrictBool = False


class PublicLicenseCheckoutIn(LicenseCheckoutIn):
    email: EmailStr
    phone: str | None = None


class PublicLicensePortalIn(BaseModel):
    session_id: str
    origin_url: str


_LICENSE_PRICE_ENV = {
    "standard": "STRIPE_PRICE_STANDARD_69",
    "pro": "STRIPE_PRICE_PRO_135",
    "lifetime": "STRIPE_PRICE_LIFETIME_269",
    "monthly": "STRIPE_PRICE_MONTHLY_32",
}
_LICENSE_AMOUNT_CENTS = {"standard": 6900, "pro": 13500, "lifetime": 26900, "monthly": 3200}


def _monthly_intro_coupon() -> str:
    coupon_id = (os.getenv("STRIPE_COUPON_MONTHLY_FIRST_10") or "").strip()
    if not coupon_id:
        raise HTTPException(status_code=503, detail="L'offre du premier mois n'est pas encore configurée.")
    try:
        coupon = stripe.Coupon.retrieve(coupon_id)
    except stripe.error.StripeError as error:
        logger.error("Vérification de la remise Stripe impossible (%s)", type(error).__name__)
        raise HTTPException(status_code=502, detail="La remise Stripe ne peut pas être vérifiée. Réessayez.") from error
    if (
        not coupon.get("valid") or coupon.get("duration") != "once"
        or coupon.get("currency") != "eur" or coupon.get("amount_off") != 2200
        or coupon.get("percent_off") is not None or coupon.get("applies_to")
    ):
        logger.error("Remise Stripe incohérente ; première location bloquée.")
        raise HTTPException(status_code=503, detail="La remise du premier mois doit être mise à jour avant paiement.")
    return coupon_id


def _license_price(tier: str) -> tuple[str, str]:
    normalized = (tier or "").strip().lower()
    env_name = _LICENSE_PRICE_ENV.get(normalized)
    price_id = (os.getenv(env_name or "") or "").strip()
    if not env_name or not price_id.startswith("price_"):
        raise HTTPException(status_code=503, detail="Cette licence Stripe n'est pas encore configurée.")
    try:
        price = stripe.Price.retrieve(price_id)
    except stripe.error.StripeError as error:
        logger.error("Vérification du tarif Stripe impossible (%s)", type(error).__name__)
        raise HTTPException(status_code=502, detail="Le tarif Stripe ne peut pas être vérifié. Réessayez.") from error
    recurring = price.get("recurring")
    valid_period = (
        isinstance(recurring, dict) and recurring.get("interval") == "month" and recurring.get("interval_count") == 1
        if normalized == "monthly" else recurring is None
    )
    if (
        not price.get("active") or price.get("currency") != "eur"
        or price.get("unit_amount") != _LICENSE_AMOUNT_CENTS[normalized] or not valid_period
        or price.get("transform_quantity") or price.get("custom_unit_amount")
    ):
        logger.error("Tarif Stripe incohérent pour la formule %s ; paiement bloqué.", normalized)
        raise HTTPException(status_code=503, detail="Le tarif de cette formule doit être mis à jour avant paiement.")
    return normalized, price_id


def _subscription_expiry(subscription: dict) -> str | None:
    period_end = subscription.get("current_period_end")
    if period_end is None:
        items = (subscription.get("items") or {}).get("data") or []
        ends = [item.get("current_period_end") for item in items]
        if ends and all(isinstance(end, int) and not isinstance(end, bool) for end in ends):
            period_end = min(ends)
    if not isinstance(period_end, int) or isinstance(period_end, bool):
        logger.warning("Abonnement Stripe sans échéance de facturation exploitable.")
        return None
    try:
        return datetime.fromtimestamp(period_end, timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        logger.warning("Échéance de facturation Stripe invalide.")
        return None


def make_payments_router(db):
    r = APIRouter()

    async def monthly_terms(body: LicenseCheckoutIn, uid: str, email: str):
        if not body.subscription_accepted:
            raise HTTPException(status_code=422, detail="Acceptez le renouvellement à 32 EUR/mois avant de souscrire.")
        previous = await db.payment_transactions.find_one(
            {"$or": [{"user_id": uid}, {"user_id": email}, {"buyer_email": email}],
             "kind": "license", "tier": "monthly", "status": {"$in": ["completed", "refunded"]}},
        )
        eligible = previous is None
        coupon_id = await asyncio.to_thread(_monthly_intro_coupon) if eligible else None
        return eligible, coupon_id

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
        tier, price_id = await asyncio.to_thread(_license_price, body.tier)
        subscription = tier == "monthly"
        buyer_email = ""
        if subscription:
            user = await db.users.find_one({"user_id": uid}, {"email": 1, "_id": 0})
            buyer_email = str((user or {}).get("email") or "").strip().lower()
            if not buyer_email:
                raise HTTPException(status_code=422, detail="Une adresse email de compte est nécessaire pour la location.")
        intro, coupon_id = await monthly_terms(body, uid, buyer_email) if subscription else (False, None)
        kwargs = {
            "line_items": [{"price": price_id, "quantity": 1}],
            "mode": "subscription" if subscription else "payment",
            "success_url": f"{origin}/?payment=success&tier={tier}&session_id={{CHECKOUT_SESSION_ID}}",
            "cancel_url": f"{origin}/?payment=cancel",
            "client_reference_id": uid,
            "metadata": {"kind": "license", "tier": tier, "user_id": uid},
        }
        if subscription:
            kwargs["customer_email"] = buyer_email
            kwargs["subscription_data"] = {"metadata": {"tier": tier, "user_id": uid}}
            kwargs["custom_text"] = {"submit": {"message": "10 EUR le premier mois pour une première location, puis 32 EUR/mois. Renouvellement automatique, résiliation depuis le portail Stripe. Aucun nouvel essai gratuit à cette souscription." if intro else "32 EUR/mois. Renouvellement automatique, résiliation depuis le portail Stripe."}}
            if coupon_id:
                kwargs["discounts"] = [{"coupon": coupon_id}]
        try:
            session = await asyncio.to_thread(stripe.checkout.Session.create, **kwargs)
        except stripe.error.StripeError as error:
            raise HTTPException(status_code=502, detail=f"Stripe indisponible : {str(error)[:120]}") from error
        await db.payment_transactions.insert_one({
            "session_id": session.id, "user_id": uid, "kind": "license", "tier": tier,
            "buyer_email": buyer_email,
            "price_id": price_id, "status": "initiated", "payment_status": "pending",
            "intro_offer": intro, "subscription_accepted": body.subscription_accepted,
            "created_at": now_iso(), "updated_at": now_iso(),
        })
        return {"checkout_url": session.url, "session_id": session.id, "tier": tier}

    @r.post("/public/license-checkout")
    async def public_license_checkout(body: PublicLicenseCheckoutIn, request: Request):
        origin = _checkout_origin(body.origin_url)
        tier, price_id = await asyncio.to_thread(_license_price, body.tier)
        buyer_email = str(body.email).strip().lower()
        buyer_phone = (body.phone or "").strip()
        subscription = tier == "monthly"
        intro, coupon_id = await monthly_terms(body, buyer_email, buyer_email) if subscription else (False, None)
        kwargs = {
            "line_items": [{"price": price_id, "quantity": 1}],
            "mode": "subscription" if subscription else "payment",
            "success_url": f"{origin}/?payment=success&tier={tier}&session_id={{CHECKOUT_SESSION_ID}}",
            "cancel_url": f"{origin}/?payment=cancel",
            "customer_email": buyer_email,
            "metadata": {"kind": "license", "tier": tier, "user_id": buyer_email, "buyer_email": buyer_email},
        }
        if subscription:
            kwargs["subscription_data"] = {"metadata": {"tier": tier, "user_id": buyer_email}}
            kwargs["custom_text"] = {"submit": {"message": "10 EUR le premier mois pour une première location, puis 32 EUR/mois. Renouvellement automatique, résiliation depuis le portail Stripe. Aucun nouvel essai gratuit à cette souscription." if intro else "32 EUR/mois. Renouvellement automatique, résiliation depuis le portail Stripe."}}
            if coupon_id:
                kwargs["discounts"] = [{"coupon": coupon_id}]
        try:
            session = await asyncio.to_thread(stripe.checkout.Session.create, **kwargs)
        except stripe.error.StripeError as error:
            raise HTTPException(status_code=502, detail=f"Stripe indisponible : {str(error)[:120]}") from error
        await db.payment_transactions.insert_one({
            "session_id": session.id, "user_id": buyer_email, "buyer_email": buyer_email,
            "buyer_phone": buyer_phone,
            "kind": "license", "tier": tier, "price_id": price_id,
            "intro_offer": intro, "subscription_accepted": body.subscription_accepted,
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
        from auth_api import require_user
        from access_gate import find_license
        user = await require_user(request, db)
        license_doc = await find_license(db, user)
        return {"license": license_doc or {"tier": "free", "status": "inactive"}}

    async def _sync_from_stripe(record):
        try:
            s = await asyncio.to_thread(stripe.checkout.Session.retrieve, record["session_id"])
            if s.payment_status == "paid" or s.status == "complete":
                await db.payment_transactions.update_one(
                    {"session_id": record["session_id"], "payment_status": {"$nin": ["paid", "refunded"]}},
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
        identity = await load_signature_identity(db, uid)
        tx = await db.payment_transactions.find_one({"session_id": session_id, "user_id": uid}, {"_id": 0})
        if not tx:
            raise HTTPException(status_code=404, detail="Transaction introuvable.")
        if tx.get("payment_status") != "paid":
            tx = await _sync_from_stripe(tx)
        if tx.get("payment_status") != "paid":
            raise HTTPException(status_code=400, detail="Le paiement n'est pas encore confirmé — pas de reçu.")
        from themis_pdf import build_receipt_pdf
        from fastapi.responses import StreamingResponse
        buf = build_receipt_pdf(tx, **identity)
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
                        **({"expires_at": None} if tier != "monthly" else {}),
                    }},
                    upsert=True,
                )
        elif t in {"customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"}:
            metadata = obj.get("metadata") or {}
            uid, tier = metadata.get("user_id"), metadata.get("tier")
            if uid and tier:
                await db.user_licenses.update_one(
                    {"user_id": uid},
                    {"$set": {"tier": tier, "status": "canceled" if t.endswith("deleted") else obj.get("status", "active"), "stripe_subscription_id": obj.get("id"), "updated_at": now_iso(),
                              "expires_at": _subscription_expiry(obj), "cancel_at_period_end": bool(obj.get("cancel_at_period_end"))}},
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
            payment_intent = obj.get("payment_intent")
            if payment_intent:
                await db.payment_transactions.update_one({"stripe_payment_intent_id": payment_intent},
                    {"$set": {"status": "refunded", "payment_status": "refunded", "updated_at": now_iso()}})
            if obj.get("refunded"):
                await _revoke_refunded_license(obj, payment_intent)
        return {"status": "ok"}

    async def _revoke_refunded_license(charge: dict, payment_intent: str | None):
        # Only a full refund revokes access; partial refunds are commercial gestures.
        transaction = await db.payment_transactions.find_one(
            {"stripe_payment_intent_id": payment_intent, "kind": "license"}, {"_id": 0}) if payment_intent else None
        if transaction and transaction.get("tier") != "monthly":
            await db.user_licenses.update_one(
                {"user_id": transaction["user_id"], "tier": transaction["tier"]},
                {"$set": {"status": "refunded", "refunded_at": now_iso(), "updated_at": now_iso()}})
            return
        customer = charge.get("customer")
        if not customer:
            return
        license_doc = await db.user_licenses.find_one(
            {"stripe_customer_id": customer, "tier": "monthly"}, {"_id": 0})
        if not license_doc:
            return
        subscription_id = license_doc.get("stripe_subscription_id")
        if subscription_id:
            try:
                await asyncio.to_thread(stripe.Subscription.cancel, subscription_id)
            except stripe.error.StripeError as error:
                logger.error("Résiliation après remboursement impossible (%s)", type(error).__name__)
        await db.user_licenses.update_one(
            {"stripe_customer_id": customer, "tier": "monthly"},
            {"$set": {"status": "canceled", "refunded_at": now_iso(), "updated_at": now_iso()}})

    return r
