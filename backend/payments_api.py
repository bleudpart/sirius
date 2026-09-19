# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
# Paiements Stripe pour les deals Hermès Agora : lien d'encaissement (acompte ou total), suivi, webhook.
import os
import asyncio
from datetime import datetime, timezone
from urllib.parse import urlparse

import stripe
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

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
        if t == "checkout.session.completed":
            await db.payment_transactions.update_one(
                {"session_id": obj["id"], "payment_status": {"$ne": "paid"}},
                {"$set": {"status": "completed", "payment_status": obj.get("payment_status", "paid"),
                          "stripe_payment_intent_id": obj.get("payment_intent"), "updated_at": now_iso()}})
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
