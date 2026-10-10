"""Account-bound provider credentials, without changing process environment."""

import os
import logging
import re
from contextvars import ContextVar
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

TRIAL_DAYS = 7
PERSONAL_REQUIRED = "Votre essai de 7 jours est terminé. Déverrouillez vos clés personnelles dans la configuration."
OWNER_ONLY_EXPIRED = (
    "Votre essai de 7 jours est terminé. Ce service en ligne fonctionne uniquement avec les clés "
    "du serveur ΣIRIUS ; vos outils et dossiers locaux restent accessibles."
)
PERSONAL_MISSING = "Clé personnelle manquante pour ce service. Ajoutez-la dans la configuration."
_policy = ContextVar("sirius_provider_policy", default=None)
_keys = ContextVar("sirius_provider_keys", default=None)
_seen_keys = ContextVar("sirius_provider_credentials", default=())
# Mutable per-request holder: survives copied contexts (threadpool, tasks) inside one request.
_denials = ContextVar("sirius_owner_denials", default=None)
_owner_uses = ContextVar("sirius_owner_uses", default=None)
# Holds the daily-quota message when an optional module's quota is exhausted: personal keys still work.
_quota_block = ContextVar("sirius_quota_block", default=None)
_charged = ContextVar("sirius_quota_charged", default=None)
_ALIASES = {
    "groq": ("groq_key", "groq_real"),
    "k3": ("k3", "kimi", "groq"),
    "serp": ("serp", "serpapi"),
    "google_tts": ("google_tts",),
    "gemini_tts": ("gemini_tts",),
    "gemini": ("gemini",),
    "fal": ("fal", "fal_key"),
    "gmaps": ("gmaps", "google_maps", "maps"),
    "alphavantage": ("alphavantage", "alpha_vantage", "alpha"),
}


class _CredentialLogFilter(logging.Filter):
    def filter(self, record):
        message = record.getMessage()
        for value in (*(_keys.get() or {}).values(), *_seen_keys.get()):
            if isinstance(value, str) and len(value) >= 3:
                message = message.replace(value, "[redacted]")
        message = re.sub(r"(?i)([?&](?:api_key|apikey|key|appid|wskey)=)[^&\s\"']+", r"\1[redacted]", message)
        record.msg, record.args = message, ()
        return True


for _logger in ("httpx", "httpcore", "sirius_brain", "server", "webagent", "routes.voice_io", "sirius.semantic"):
    logging.getLogger(_logger).addFilter(_CredentialLogFilter())


def utc_now():
    return datetime.now(timezone.utc)


def trial_status(user, now=None):
    now = now or utc_now()
    if user.get("role") == "admin":
        return {"state": "admin", "started_at": None, "expires_at": None, "remaining_seconds": None}
    started = user.get("trial_started_at")
    try:
        if isinstance(started, str):
            started = datetime.fromisoformat(started.replace("Z", "+00:00"))
        if not isinstance(started, datetime):
            raise ValueError("missing activation")
        started = started.replace(tzinfo=timezone.utc) if started.tzinfo is None else started.astimezone(timezone.utc)
        expiry = started + timedelta(days=TRIAL_DAYS)
    except (ValueError, OverflowError):
        return {"state": "expired", "started_at": None, "expires_at": None, "remaining_seconds": 0}
    return {
        "state": "active" if now < expiry else "expired",
        "started_at": started.isoformat(),
        "expires_at": expiry.isoformat(),
        "remaining_seconds": max(0, int((expiry - now).total_seconds())),
    }


async def activate_trial(db, user):
    """First successful account activation wins, including concurrent requests."""
    if user.get("role") == "admin" or user.get("trial_started_at") is not None:
        return user
    await db.users.update_one(
        {"user_id": user["user_id"], "trial_started_at": None},
        {"$set": {"trial_started_at": utc_now()}},
    )
    return await db.users.find_one({"user_id": user["user_id"]}) or user


def owner_allowed(user=None):
    scoped = user is None
    user = user if user is not None else _policy.get()
    # Unscoped calls are trusted internal/legacy calls. HTTP always installs a deny scope.
    if user is None:
        return True
    if scoped and (_quota_block.get() or {}).get("detail"):
        return False
    return bool(user) and (
        user.get("role") == "admin"
        or trial_status(user)["state"] == "active"
    )


def note_charged():
    """Called by usage_quota.consume when a unit was actually counted for this request."""
    charged = _charged.get()
    if charged is not None:
        charged.add(True)


def bind_user(user):
    return _policy.set(dict(user))


def bind_keys(keys):
    return _keys.set(dict(keys or {}))


@contextmanager
def provider_scope(user, keys=None):
    token, key_token = bind_user(user), bind_keys(keys)
    seen_token = _seen_keys.set(())
    try:
        yield
    finally:
        _keys.reset(key_token)
        _seen_keys.reset(seen_token)
        _policy.reset(token)


@asynccontextmanager
async def metered_scope(db, user, keys=None, kind="chat"):
    """Account scope for owner-key work outside the HTTP request (background tasks, loops).

    During the trial one daily quota unit is reserved upfront and refunded when no owner credential
    was used; at the daily limit owner credentials are withheld (state["blocked"]) while personal
    keys keep working. After expiry no owner credential resolves at all.
    """
    from usage_quota import consume, refund
    uses, block, state = set(), {}, {"blocked": None}
    with provider_scope(user, keys):
        tokens = (_owner_uses.set(uses), _quota_block.set(block), _denials.set(set()), _charged.set(set()))
        reserved = False
        try:
            if owner_allowed(user):
                try:
                    reserved = await consume(db, user, kind)
                except HTTPException as error:
                    if error.status_code != 429:
                        raise
                    block["detail"] = state["blocked"] = error.detail
            yield state
        finally:
            if reserved and not uses:
                try:
                    await refund(db, user, kind)
                except Exception:
                    logging.getLogger(__name__).warning("[QUOTA] remboursement impossible")
            for var, token in zip((_owner_uses, _quota_block, _denials, _charged), tokens):
                var.reset(token)


def personal_key(service, keys=None):
    keys = _keys.get() if keys is None else keys
    for alias in _ALIASES.get(service, (service,)):
        value = (keys or {}).get(alias)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def provider_key(service, owner_key="", keys=None):
    effective = _keys.get() if keys is None else keys
    # Per-provider precedence: a personal key for this provider always wins and never falls back
    # to the owner key (even if refused upstream); keys for other providers have no effect here.
    personal = personal_key(service, effective)
    key = personal or (owner_key if owner_key and owner_allowed() else "") or ""
    if not key and owner_key:
        denied = _denials.get()
        if denied is not None:
            denied.add(service)
    if key and not personal:
        uses = _owner_uses.get()
        if uses is not None:
            uses.add(service)
    if key and key not in _seen_keys.get():
        _seen_keys.set((*_seen_keys.get(), key))
    return key


def provider_env(service, *names, keys=None):
    return provider_key(service, next((os.getenv(name, "").strip() for name in names if os.getenv(name, "").strip()), ""), keys)


def require_personal(service, keys=None):
    if not owner_allowed() and not personal_key(service, keys):
        block = (_quota_block.get() or {}).get("detail")
        if block and owner_allowed(_policy.get()):
            raise HTTPException(status_code=429, detail=block)
        raise HTTPException(status_code=403, detail=PERSONAL_REQUIRED)


def denial_error(service, owner_key="", keys=None):
    """Explicit reason why no credential resolved, or None when the key is simply not configured."""
    policy = _policy.get()
    if policy is None:
        return None
    effective = _keys.get() if keys is None else keys
    personal_capable = service in _ALIASES
    if not owner_allowed(policy):
        if personal_capable:
            return HTTPException(status_code=403, detail=PERSONAL_REQUIRED)
        return HTTPException(status_code=403, detail=OWNER_ONLY_EXPIRED) if owner_key else None
    if not owner_key or personal_key(service, effective):
        return None
    block = (_quota_block.get() or {}).get("detail")
    if block:
        return HTTPException(status_code=429, detail=block)
    return None


def require_key(service, owner_key="", keys=None):
    """provider_key() that raises an explicit French error instead of silently lacking a credential.

    Returns "" only when no owner key is configured and no policy denial applies (caller reports it).
    """
    key = provider_key(service, owner_key, keys)
    if key:
        return key
    error = denial_error(service, owner_key, keys)
    if error is not None:
        raise error
    return ""


def require_env_key(service, *names, keys=None):
    owner = next((os.getenv(name, "").strip() for name in names if os.getenv(name, "").strip()), "")
    return require_key(service, owner, keys)


class ProviderAccessMiddleware:
    """ASGI scope stays alive through SSE iteration and copied async task contexts.

    Expiry never closes the app: local tools keep working. Online modules reach providers
    only through provider_key()/require_key(), which yield no owner credential after the trial
    and raise explicit French errors at the call site. Optional modules reserve one daily quota
    unit during the trial; it is refunded when the request used no owner credential.
    """

    _primary = ("/api/chat", "/api/intent", "/api/stt", "/api/tts")
    # Online modules that may spend owner provider credentials (quota during the trial).
    _optional = {
        "/api/diagram", "/api/display/analyze", "/api/display/ask", "/api/vision/analyze", "/api/webagent/run",
        "/api/webbrowser/open", "/api/task/image", "/api/task/video/start", "/api/dev/review", "/api/floorplan",
        "/api/news/headlines", "/api/weather/current", "/api/country", "/api/technews/bulletin",
        "/api/documentary", "/api/europeana/search", "/api/oracle/overview", "/api/pantheon/ocr",
        "/api/nummarius/market", "/api/nummarius/alerts", "/api/hephaistos/diagnostic", "/api/agora/coach",
    }
    _optional_prefixes = ("/api/task/video/status/", "/api/nummarius/history/")

    def __init__(self, app, db):
        self.app, self.db = app, db

    @staticmethod
    def _primary_kind(path):
        if path.startswith("/api/stt"):
            return "stt"
        if path.startswith("/api/tts"):
            return "tts"
        return "chat"

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        from auth_api import require_user
        from starlette.requests import HTTPConnection
        from starlette.responses import JSONResponse
        path = scope.get("path", "")
        token = bind_user({})
        key_token = bind_keys({})
        seen_token = _seen_keys.set(())
        denied, owner_uses, block, charged = set(), set(), {}, set()
        denial_token = _denials.set(denied)
        uses_token = _owner_uses.set(owner_uses)
        block_token = _quota_block.set(block)
        charged_token = _charged.set(charged)
        reserved = None
        metered = None
        try:
            optional = path in self._optional or path.startswith(self._optional_prefixes) or (
                path.startswith("/api/files/") and path.endswith("/analyze")
            )
            protected = scope.get("method") != "OPTIONS" and (path.startswith(self._primary) or optional)
            if protected:
                user = await require_user(HTTPConnection(scope), self.db)
                if not optional and owner_allowed(user):
                    # Primary routes charge themselves only without a personal key for their own
                    # provider; other owner providers used meanwhile are metered after the call.
                    from usage_quota import exhausted
                    metered = (user, self._primary_kind(path))
                    message = await exhausted(self.db, user, metered[1])
                    if message:
                        block["detail"] = message
                if optional and owner_allowed(user):
                    from usage_quota import consume
                    try:
                        reserved = user if await consume(self.db, user, "chat") else None
                    except HTTPException as error:
                        if error.status_code != 429:
                            raise
                        block["detail"] = error.detail
            await self.app(scope, receive, send)
        except HTTPException as error:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008, "reason": error.detail})
            else:
                await JSONResponse({"detail": error.detail}, status_code=error.status_code)(scope, receive, send)
        finally:
            if metered is not None and owner_uses and not charged and not block:
                from usage_quota import consume
                try:
                    await consume(self.db, metered[0], metered[1])
                except Exception:
                    logging.getLogger(__name__).warning("[QUOTA] décompte différé impossible")
            if reserved is not None and not owner_uses:
                from usage_quota import refund
                try:
                    await refund(self.db, reserved, "chat")
                except Exception:
                    logging.getLogger(__name__).warning("[QUOTA] remboursement impossible")
            _charged.reset(charged_token)
            _quota_block.reset(block_token)
            _owner_uses.reset(uses_token)
            _denials.reset(denial_token)
            _keys.reset(key_token)
            _seen_keys.reset(seen_token)
            _policy.reset(token)
