# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Quotas journaliers par compte quand ΣIRIUS consomme les clés du serveur.

Le serveur public paie Groq / Google pour tous les comptes : chaque utilisateur dispose
d'un volume quotidien (remis à zéro à minuit UTC). Les administrateurs, les requêtes qui
apportent leur propre clé et le serveur local d'un PC (SIRIUS_PACKAGED=1) ne sont pas comptés.
L'expiration de l'essai reste obligatoire pour les non-administrateurs, même sans quotas.
"""

import os
from datetime import datetime, timezone

from fastapi import HTTPException
from pymongo import ReturnDocument
from provider_access import owner_allowed, note_charged, PERSONAL_REQUIRED

DEFAULT_LIMITS = {"chat": 150, "stt": 120, "tts": 400}
_ENV_NAMES = {"chat": "SIRIUS_QUOTA_CHAT", "stt": "SIRIUS_QUOTA_STT", "tts": "SIRIUS_QUOTA_TTS"}
_MESSAGES = {
    "chat": "Limite quotidienne de messages atteinte. ΣIRIUS sera de nouveau disponible demain.",
    "stt": "Limite quotidienne du micro atteinte. Vous pouvez continuer à écrire dans le chat.",
    "tts": "Limite quotidienne de la voix atteinte. Les réponses restent affichées à l'écran.",
}


def quota_enabled() -> bool:
    if (os.getenv("SIRIUS_QUOTA") or "").strip().lower() in {"off", "0", "false"}:
        return False
    return os.getenv("SIRIUS_PACKAGED", "").strip() != "1"


def daily_limit(kind: str) -> int:
    raw = (os.getenv(_ENV_NAMES[kind]) or "").strip()
    try:
        return max(0, int(raw)) if raw else DEFAULT_LIMITS[kind]
    except ValueError:
        return DEFAULT_LIMITS[kind]


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


async def consume(db, user: dict, kind: str, amount: int = 1) -> bool:
    """Décompte une utilisation ; lève 429 avec un message clair si la limite du jour est dépassée.

    Renvoie True quand une unité a réellement été décomptée (remboursable via refund()).
    """
    if db is None:
        return False
    if not owner_allowed(user):
        raise HTTPException(status_code=403, detail=PERSONAL_REQUIRED)
    if db is None or not quota_enabled() or (user or {}).get("role") == "admin":
        return False
    user_id = (user or {}).get("user_id")
    if not user_id:
        return False
    limit = daily_limit(kind)
    key = {"user_id": user_id, "day": _today()}
    doc = await db.usage_quota.find_one_and_update(
        key, {"$inc": {kind: amount}}, upsert=True, return_document=ReturnDocument.AFTER,
    )
    if int((doc or {}).get(kind) or 0) > limit:
        await db.usage_quota.update_one(key, {"$inc": {kind: -amount}})
        raise HTTPException(status_code=429, detail=_MESSAGES[kind])
    note_charged()
    return True


async def exhausted(db, user: dict, kind: str) -> str | None:
    """Read-only check: the daily message when the limit is already reached, else None."""
    user_id = (user or {}).get("user_id")
    if db is None or not user_id or not quota_enabled() or (user or {}).get("role") == "admin":
        return None
    doc = await db.usage_quota.find_one({"user_id": user_id, "day": _today()}) or {}
    return _MESSAGES[kind] if int(doc.get(kind) or 0) >= daily_limit(kind) else None


async def refund(db, user: dict, kind: str, amount: int = 1) -> None:
    """Annule une réservation quand la requête n'a finalement utilisé aucune clé du serveur."""
    user_id = (user or {}).get("user_id")
    if db is None or not user_id:
        return
    await db.usage_quota.update_one(
        {"user_id": user_id, "day": _today(), kind: {"$gte": amount}}, {"$inc": {kind: -amount}},
    )


async def usage_summary(db, user: dict) -> dict:
    if db is None or not quota_enabled() or (user or {}).get("role") == "admin" or not owner_allowed(user):
        return {"enabled": False}
    doc = await db.usage_quota.find_one({"user_id": user.get("user_id"), "day": _today()}) or {}
    return {
        "enabled": True,
        "day": _today(),
        "usage": {kind: int(doc.get(kind) or 0) for kind in DEFAULT_LIMITS},
        "limits": {kind: daily_limit(kind) for kind in DEFAULT_LIMITS},
    }
