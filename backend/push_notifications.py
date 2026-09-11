# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Notifications push ΣIRIUS (Web Push / VAPID) — abonnements persistés en JSON local."""
import os
import json
import base64
import logging
from pathlib import Path
from fastapi import APIRouter
from pydantic import BaseModel
from py_vapid import Vapid
from pywebpush import webpush, WebPushException
from cryptography.hazmat.primitives import serialization
from runtime_paths import data_dir, write_json_atomic

logger = logging.getLogger("sirius.push")

DATA_DIR = data_dir()
VAPID_PEM = DATA_DIR / "vapid_private.pem"
SUBS_FILE = DATA_DIR / "push_subs.json"
VAPID_CLAIMS = {"sub": "mailto:sirius@techenclair.fr"}


def _ensure_keys():
    if not VAPID_PEM.exists():
        v = Vapid()
        v.generate_keys()
        VAPID_PEM.write_bytes(
            v.private_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
    return Vapid.from_file(str(VAPID_PEM))


_vapid = _ensure_keys()


def get_public_key() -> str:
    raw = _vapid.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _load_subs():
    try:
        return json.loads(SUBS_FILE.read_text())
    except Exception:
        return []


def _save_subs(subs):
    write_json_atomic(SUBS_FILE, subs)


def send_push_to_all(title: str, body: str, url: str = "/") -> dict:
    """Envoie une notification à tous les abonnés ; purge les abonnements morts."""
    subs = _load_subs()
    payload = json.dumps({"title": title, "body": body, "url": url}, ensure_ascii=False)
    sent, dead = 0, []
    for s in subs:
        try:
            webpush(
                subscription_info=s,
                data=payload,
                vapid_private_key=str(VAPID_PEM),
                vapid_claims=dict(VAPID_CLAIMS),
            )
            sent += 1
        except WebPushException as e:
            code = getattr(e.response, "status_code", 0)
            if code in (404, 410):
                dead.append(s.get("endpoint"))
            else:
                logger.error(f"[PUSH] envoi: {repr(e)}")
        except Exception as e:
            logger.error(f"[PUSH] envoi: {repr(e)}")
    if dead:
        _save_subs([s for s in subs if s.get("endpoint") not in dead])
    return {"sent": sent, "removed": len(dead), "total": len(subs)}


class SubscribeBody(BaseModel):
    subscription: dict


class UnsubscribeBody(BaseModel):
    endpoint: str


class SendBody(BaseModel):
    title: str = "ΣIRIUS"
    body: str = ""
    url: str = "/"


WATCH_FILE = DATA_DIR / "push_watch.json"


def load_watch():
    try:
        return json.loads(WATCH_FILE.read_text())
    except Exception:
        return {"enabled": True, "interval_min": 60, "last_run": 0, "sent_titles": []}


def save_watch(w):
    write_json_atomic(WATCH_FILE, w)


def subscriber_count() -> int:
    return len(_load_subs())


class WatchBody(BaseModel):
    enabled: bool | None = None
    interval_min: int | None = None


def make_push_router():
    r = APIRouter(prefix="/push", tags=["push"])

    @r.get("/public_key")
    async def public_key():
        return {"publicKey": get_public_key()}

    @r.post("/subscribe")
    async def subscribe(b: SubscribeBody):
        sub = b.subscription
        if not sub.get("endpoint"):
            return {"ok": False, "message": "Abonnement invalide."}
        subs = _load_subs()
        subs = [s for s in subs if s.get("endpoint") != sub["endpoint"]]
        subs.append(sub)
        _save_subs(subs)
        return {"ok": True, "count": len(subs)}

    @r.post("/unsubscribe")
    async def unsubscribe(b: UnsubscribeBody):
        subs = [s for s in _load_subs() if s.get("endpoint") != b.endpoint]
        _save_subs(subs)
        return {"ok": True, "count": len(subs)}

    @r.post("/send")
    async def send(b: SendBody):
        res = send_push_to_all(b.title, b.body, b.url)
        return {"ok": True, **res}

    @r.get("/watch")
    async def watch_status():
        w = load_watch()
        return {"enabled": w.get("enabled", True), "interval_min": w.get("interval_min", 60),
                "last_run": w.get("last_run", 0), "subscribers": subscriber_count()}

    @r.post("/watch")
    async def watch_update(b: WatchBody):
        w = load_watch()
        if b.enabled is not None:
            w["enabled"] = b.enabled
        if b.interval_min is not None:
            w["interval_min"] = max(15, min(720, b.interval_min))
        save_watch(w)
        return {"ok": True, "enabled": w["enabled"], "interval_min": w["interval_min"]}

    return r
