# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Accès au logiciel : essai de 15 jours, puis licence ou location obligatoire.

Le serveur public décide à partir du compte (essai, licence achetée avec la même
adresse e-mail). Un PC (serveur local empaqueté) doit être relié à son compte
ΣIRIUS Cloud : son état d'accès est celui du compte Cloud, mis en cache pour
tolérer une courte coupure Internet.
"""

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

import cloud_link
from provider_access import trial_status, utc_now

logger = logging.getLogger(__name__)

PERPETUAL_TIERS = {"standard", "pro", "lifetime"}
MONTHLY_ACTIVE = {"active", "trialing", "past_due"}
MONTHLY_GRACE = timedelta(days=3)
OPEN_STATES = {"admin", "trial", "licensed"}

EXPIRED_DETAIL = (
    "Votre essai de 15 jours est terminé. Choisissez une licence ou une location sur "
    "sirius-assistant.fr avec l'adresse e-mail de votre compte pour continuer à utiliser ΣIRIUS."
)
UNLINKED_DETAIL = "Reliez ce PC à votre compte ΣIRIUS pour utiliser l'application."
OFFLINE_DETAIL = "Connexion à ΣIRIUS Cloud nécessaire pour vérifier votre accès. Vérifiez Internet puis réessayez."

# Routes toujours ouvertes : compte, paiement, liaison Cloud, santé, export et suppression des données.
OPEN_PREFIXES = (
    "/api/auth/", "/api/access/", "/api/licenses/", "/api/public/", "/api/stripe/",
    "/api/payments/", "/api/cloud/", "/api/health", "/api/version",
)

_CACHE_TTL = 600
_OFFLINE_GRACE = 3 * 24 * 3600
_cache: dict = {}
_cache_lock = asyncio.Lock()


def _parse_dt(value):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def license_valid(license_doc: dict | None, now: datetime | None = None) -> bool:
    if not isinstance(license_doc, dict):
        return False
    now = now or utc_now()
    tier, status = license_doc.get("tier"), license_doc.get("status")
    if tier in PERPETUAL_TIERS:
        return status == "active"
    if tier == "monthly" and status in MONTHLY_ACTIVE:
        expires = _parse_dt(license_doc.get("expires_at"))
        # Échéance encore inconnue juste après le paiement : Stripe l'enverra avec l'abonnement.
        return expires is None or now < expires + MONTHLY_GRACE
    return False


def _public_license(license_doc: dict | None) -> dict | None:
    if not isinstance(license_doc, dict):
        return None
    return {key: license_doc.get(key) for key in ("tier", "status", "expires_at", "cancel_at_period_end")}


async def find_license(db, user: dict) -> dict | None:
    """Licence du compte, achetée connecté (user_id) ou depuis la boutique (e-mail)."""
    ids = [value for value in {
        str(user.get("user_id") or "").strip(),
        str(user.get("email") or "").strip().lower(),
    } if value]
    if not ids:
        return None
    documents = await db.user_licenses.find({"user_id": {"$in": ids}}, {"_id": 0}).to_list(10)
    if not documents:
        return None
    now = utc_now()
    valid = [doc for doc in documents if license_valid(doc, now)]
    ranked = valid or documents
    order = {"lifetime": 0, "pro": 1, "standard": 2, "monthly": 3}
    return sorted(ranked, key=lambda doc: order.get(doc.get("tier"), 9))[0]


async def server_access_status(db, user: dict) -> dict:
    trial = trial_status(user)
    if trial["state"] == "admin":
        return {"state": "admin", "allowed": True, "trial": trial, "license": None}
    license_doc = await find_license(db, user)
    if license_valid(license_doc):
        state = "licensed"
    elif trial["state"] == "active":
        state = "trial"
    else:
        state = "expired"
    status = {"state": state, "allowed": state in OPEN_STATES, "trial": trial, "license": _public_license(license_doc)}
    if state == "expired":
        status["detail"] = EXPIRED_DETAIL
    return status


def gate_enabled_locally() -> bool:
    """Un PC empaqueté dépend du compte Cloud ; le développement depuis les sources reste libre."""
    return cloud_link.relay_allowed()


def reset_cache() -> None:
    _cache.clear()


async def _cloud_access_status(force: bool = False) -> dict:
    state = cloud_link.load_state()
    if not state.get("access_token"):
        reset_cache()
        return {"state": "unlinked", "allowed": False, "detail": UNLINKED_DETAIL, "cloud": {"linked": False}}
    email = state.get("email") or ""
    async with _cache_lock:
        now = time.time()
        cached = _cache.get("status")
        if cached and cached.get("email") == email and not force and now - cached["at"] < _CACHE_TTL:
            return cached["value"]
        try:
            remote = await cloud_link.relay_get_json("/api/access/status")
        except HTTPException as error:
            if error.status_code == 401 and not cloud_link.linked():
                reset_cache()
                return {"state": "unlinked", "allowed": False, "detail": UNLINKED_DETAIL, "cloud": {"linked": False}}
            if cached and cached.get("email") == email and now - cached["at"] < _OFFLINE_GRACE:
                return {**cached["value"], "offline": True}
            logger.warning("[ACCÈS] vérification Cloud impossible : %s", error.detail)
            return {"state": "offline", "allowed": False, "detail": OFFLINE_DETAIL, "cloud": {"linked": True, "email": email}}
        value = {
            "state": remote.get("state") if remote.get("state") in OPEN_STATES | {"expired"} else "expired",
            "trial": remote.get("trial"),
            "license": remote.get("license"),
            "cloud": {"linked": True, "email": email},
        }
        value["allowed"] = value["state"] in OPEN_STATES
        if not value["allowed"]:
            value["detail"] = remote.get("detail") or EXPIRED_DETAIL
        _cache["status"] = {"at": now, "email": email, "value": value}
        return value


async def access_status(db, user: dict, force: bool = False) -> dict:
    if gate_enabled_locally():
        return await _cloud_access_status(force)
    return await server_access_status(db, user)


def is_open_path(path: str) -> bool:
    # Zapier checks the license with its own scoped identity; revocation stays available.
    return (path == "/api/ariane/phone/webhook"
            or path in {
                "/api/integrations/whatsapp/webhook",
                "/api/integrations/workspace/calendar/webhook",
                "/api/integrations/workspace/gmail/webhook",
            }
            or path.startswith("/api/integrations/zapier/")
            or not path.startswith("/api/") or path.startswith(OPEN_PREFIXES))


def make_access_router(db):
    from fastapi import APIRouter, Request
    from auth_api import require_user

    router = APIRouter(prefix="/access", tags=["access"])

    @router.get("/status")
    async def status(request: Request, refresh: bool = False):
        user = await require_user(request, db)
        return await access_status(db, user, force=refresh)

    return router


class AccessGateMiddleware:
    """Refuse (402) l'usage du logiciel quand ni l'essai ni une licence ne sont actifs."""

    def __init__(self, app, db):
        self.app, self.db = app, db

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"} or scope.get("method") == "OPTIONS" or is_open_path(scope.get("path", "")):
            return await self.app(scope, receive, send)
        from auth_api import require_user
        from starlette.requests import HTTPConnection
        from starlette.responses import JSONResponse
        try:
            user = await require_user(HTTPConnection(scope), self.db)
        except HTTPException:
            # Sans session valide, la route applique elle-même son authentification.
            return await self.app(scope, receive, send)
        status = await access_status(self.db, user)
        if status.get("allowed"):
            return await self.app(scope, receive, send)
        detail = status.get("detail") or EXPIRED_DETAIL
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4402, "reason": detail[:120]})
            return
        await JSONResponse({"detail": detail, "access": status}, status_code=402)(scope, receive, send)
