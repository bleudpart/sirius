"""Scoped Zapier credentials and durable, bounded REST-hook delivery."""

import asyncio
import hashlib
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import Field

from action_registry import ActionInputs
from access_gate import access_status
from work_draft_recordings import digest, insert_once

logger = logging.getLogger(__name__)
Scope = Literal["dossiers:read", "notes:write", "meetings:read", "hooks:write"]
Event = Literal["dossier.created", "meeting.ready"]
EVENTS = {
    "dossier.created": ("sirius_work_dossiers", "created_at", "dossiers:read"),
    "meeting.ready": ("sirius_meetings", "ready_at", "meetings:read"),
}


def now():
    return datetime.now(timezone.utc).isoformat()


class KeyIn(ActionInputs):
    label: str = Field(min_length=1, max_length=100)
    scopes: list[Scope] = Field(min_length=1, max_length=4)
    expires_in_days: int = Field(default=30, ge=1, le=90, strict=True)


class HookIn(ActionInputs):
    event: Event
    target_url: str = Field(max_length=2000)


class NoteIn(ActionInputs):
    request_id: uuid.UUID
    dossier_id: str = Field(min_length=1, max_length=120)
    text: str = Field(min_length=1, max_length=4000)


def hook_url(value):
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme == "https" and parsed.hostname == "hooks.zapier.com"
                 and parsed.port in (None, 443) and not parsed.username and not parsed.password
                 and not parsed.fragment and not parsed.query and parsed.path.startswith("/hooks/")
                 and "\\" not in value and not any(ord(char) <= 32 for char in value))
    except ValueError:
        valid = False
    if not valid:
        raise HTTPException(422, "URL HTTPS hooks.zapier.com/hooks/ requise, sans redirection.")
    return value


class ZapierIntegrations:
    def __init__(self, db, transport=None):
        self.db, self.transport = db, transport

    async def create_key(self, uid, body):
        await self.access_user(uid)
        if not body.label.strip():
            raise HTTPException(422, "Nom de connexion requis.")
        if await self.db.sirius_zapier_keys.count_documents({"user_id": uid, "active": True}) >= 10:
            raise HTTPException(409, "Dix clés actives maximum ; révoquer une ancienne clé.")
        token = "szk_" + secrets.token_urlsafe(32)
        row = {"id": str(uuid.uuid4()), "user_id": uid, "label": body.label.strip(),
               "token_hash": hashlib.sha256(token.encode()).hexdigest(),
               "scopes": sorted(set(body.scopes)), "active": True, "created_at": now(),
               "expires_at": (datetime.now(timezone.utc) + timedelta(days=body.expires_in_days)).isoformat()}
        await self.db.sirius_zapier_keys.insert_one(dict(row))
        return {**self.public_key(row), "api_key": token}

    @staticmethod
    def public_key(row):
        return {key: row[key] for key in ("id", "label", "scopes", "active", "created_at", "expires_at")}

    async def access_user(self, uid):
        user = await self.db.users.find_one({"user_id": uid})
        if not user or user.get("disabled"):
            raise HTTPException(401, "Compte indisponible.")
        status = await access_status(self.db, user)
        if not status.get("allowed"):
            raise HTTPException(402, status.get("detail") or "Accès SIRIUS indisponible.")

    async def valid_key(self, row):
        if not row or not row["active"] or row["expires_at"] <= now():
            raise HTTPException(401, "Clé Zapier invalide, expirée ou révoquée.")
        await self.access_user(row["user_id"])
        return row

    async def authenticate(self, request, scope=None):
        token = request.headers.get("X-Sirius-Api-Key", "")
        if not token.startswith("szk_") or len(token) > 100:
            raise HTTPException(401, "Clé Zapier requise.")
        row = await self.valid_key(await self.db.sirius_zapier_keys.find_one({
            "token_hash": hashlib.sha256(token.encode()).hexdigest(),
        }))
        self.require_scope(row, scope)
        bucket = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")
        await insert_once(self.db, "sirius_zapier_limits", {
            "user_id": row["user_id"], "id": row["id"], "minute": bucket, "count": 0,
        })
        await self.db.sirius_zapier_limits.update_one(
            {"user_id": row["user_id"], "id": row["id"], "minute": {"$ne": bucket}},
            {"$set": {"minute": bucket, "count": 0}})
        admitted = await self.db.sirius_zapier_limits.update_one(
            {"user_id": row["user_id"], "id": row["id"], "minute": bucket, "count": {"$lt": 60}},
            {"$inc": {"count": 1}})
        if not admitted.modified_count:
            raise HTTPException(429, "Limite de 60 requêtes par minute atteinte.", headers={"Retry-After": "60"})
        return row

    @staticmethod
    def require_scope(key, scope):
        if scope and scope not in key["scopes"]:
            raise HTTPException(403, "Droit Zapier manquant : " + scope)

    async def subscribe(self, key, body):
        self.require_scope(key, "hooks:write")
        self.require_scope(key, EVENTS[body.event][2])
        target = hook_url(body.target_url)
        identity = digest([key["id"], body.event, target])
        existing = await self.db.sirius_zapier_hooks.find_one({"user_id": key["user_id"], "id": identity})
        if existing:
            if not existing["active"]:
                if await self.db.sirius_zapier_hooks.count_documents({"user_id": key["user_id"], "active": True}) >= 10:
                    raise HTTPException(409, "Dix abonnements actifs maximum.")
                await self.db.sirius_zapier_hooks.update_one(
                    {"user_id": key["user_id"], "id": identity, "active": False}, {"$set": {
                        "active": True, "secret": secrets.token_urlsafe(32), "created_at": now(),
                        "cursor_time": "", "cursor_id": "", "paused_reason": None,
                    }})
                existing = await self.db.sirius_zapier_hooks.find_one({"user_id": key["user_id"], "id": identity})
            return {"id": identity, "secret": existing["secret"]}
        if await self.db.sirius_zapier_hooks.count_documents({"user_id": key["user_id"], "active": True}) >= 10:
            raise HTTPException(409, "Dix abonnements actifs maximum.")
        row, _ = await insert_once(self.db, "sirius_zapier_hooks", {
            "id": identity, "user_id": key["user_id"], "key_id": key["id"],
            "event": body.event, "target_url": target, "secret": secrets.token_urlsafe(32),
            "active": True, "created_at": now(), "cursor_time": "", "cursor_id": "",
        })
        return {"id": identity, "secret": row["secret"]}

    async def note(self, key, body):
        self.require_scope(key, "notes:write")
        uid, identity = key["user_id"], str(body.request_id)
        query = {"user_id": uid, "id": body.dossier_id}
        dossier = await self.db.sirius_work_dossiers.find_one(query)
        if not dossier:
            raise HTTPException(404, "Dossier introuvable.")
        text = body.text.strip()
        if not text:
            raise HTTPException(422, "Note vide.")
        previous = next((item for item in dossier.get("notes", []) if item["id"] == identity), None)
        if previous:
            if previous["text"] != text or previous.get("origin") != "zapier":
                raise HTTPException(409, "Référence déjà utilisée avec un autre contenu.")
            return previous
        note = {"id": identity, "text": text, "created_at": now(), "origin": "zapier"}
        updated = await self.db.sirius_work_dossiers.update_one(
            {**query, "notes": dossier.get("notes", [])}, {"$push": {"notes": note}})
        if updated.modified_count:
            return note
        current = await self.db.sirius_work_dossiers.find_one(query)
        previous = next((item for item in (current or {}).get("notes", []) if item["id"] == identity), None)
        if not previous or previous["text"] != text or previous.get("origin") != "zapier":
            raise HTTPException(409, "Référence déjà utilisée avec un autre contenu, ou dossier supprimé.")
        return previous

    @staticmethod
    def payload(event, source):
        timestamp = source[EVENTS[event][1]]
        result = {"id": event + ":" + source["id"], "event": event,
                  "resource_id": source["id"], "title": source["title"], "created_at": timestamp}
        if event == "meeting.ready":
            result["summary"] = source["result"]["summary"]
            result["capture_complete"] = source["capture_complete"]
        return result

    async def discover(self, hook):
        collection, field, _ = EVENTS[hook["event"]]
        query = {"user_id": hook["user_id"], field: {"$gte": hook["created_at"]}}
        if hook["event"] == "meeting.ready":
            query["state"] = "READY"
        if hook["cursor_time"]:
            query["$or"] = [{field: {"$gt": hook["cursor_time"]}},
                            {field: hook["cursor_time"], "id": {"$gt": hook["cursor_id"]}}]
        rows = await self.db[collection].find(query).sort([(field, 1), ("id", 1)]).to_list(50)
        for row in rows:
            payload = self.payload(hook["event"], row)
            await insert_once(self.db, "sirius_zapier_deliveries", {
                "user_id": hook["user_id"], "id": digest([hook["id"], payload["id"]]),
                "hook_id": hook["id"], "resource_id": row["id"], "event_id": payload["id"],
                "state": "PENDING", "attempts": 0, "next_at": now(), "created_at": now(),
            })
        # Re-scan after each complete sweep to recover late commits without re-delivering.
        cursor = {"cursor_time": rows[-1][field], "cursor_id": rows[-1]["id"]} if len(rows) == 50 else {
            "cursor_time": "", "cursor_id": ""}
        await self.db.sirius_zapier_hooks.update_one(
            {"user_id": hook["user_id"], "id": hook["id"], "active": True}, {"$set": cursor})

    async def deliver(self, hook, delivery, client):
        uid = hook["user_id"]
        key = await self.db.sirius_zapier_keys.find_one({"user_id": uid, "id": hook["key_id"]})
        try:
            await self.valid_key(key)
        except HTTPException as exc:
            await self.db.sirius_zapier_hooks.update_one({"user_id": uid, "id": hook["id"], "active": True},
                {"$set": {"active": exc.status_code != 401, "paused_reason": exc.detail}})
            return
        current_hook = await self.db.sirius_zapier_hooks.find_one({"user_id": uid, "id": hook["id"], "active": True})
        if not current_hook:
            return
        collection, field, scope = EVENTS[hook["event"]]
        self.require_scope(key, scope)
        source = await self.db[collection].find_one({"user_id": uid, "id": delivery["resource_id"]})
        query = {"user_id": uid, "id": delivery["id"]}
        if (not source or source.get(field, "") < current_hook["created_at"]
                or (hook["event"] == "meeting.ready" and source["state"] != "READY")):
            await self.db.sirius_zapier_deliveries.update_one(
                {**query, "state": {"$in": ["PENDING", "SENDING"]}}, {"$set": {"state": "CANCELLED"}})
            return
        attempts = delivery["attempts"]
        if attempts >= 5:
            await self.db.sirius_zapier_deliveries.update_one(
                {**query, "attempts": attempts, "state": {"$in": ["PENDING", "SENDING"]},
                 "next_at": {"$lte": now()}}, {"$set": {"state": "FAILED", "error": "AttemptBudgetExhausted"}})
            return
        claimed = await self.db.sirius_zapier_deliveries.update_one(
            {**query, "attempts": attempts, "state": {"$in": ["PENDING", "SENDING"]}, "next_at": {"$lte": now()}},
            {"$set": {"state": "SENDING", "attempts": attempts + 1,
                      "next_at": (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()}})
        if not claimed.modified_count:
            return
        status, error = None, None
        try:
            async with client.stream("POST", hook_url(current_hook["target_url"]),
                                     json=self.payload(hook["event"], source),
                                     headers={"X-Sirius-Hook-Secret": current_hook["secret"]}) as response:
                status = response.status_code
        except httpx.RequestError as exc:
            error = type(exc).__name__
        success = status is not None and 200 <= status < 300
        permanent = status is not None and 400 <= status < 500 and status not in (408, 429)
        state = "SENT" if success else ("FAILED" if permanent or attempts + 1 >= 5 else "PENDING")
        await self.db.sirius_zapier_deliveries.update_one(query, {"$set": {
            "state": state, "http_status": status, "error": error,
            "next_at": (datetime.now(timezone.utc) + timedelta(seconds=30 * 2 ** attempts)).isoformat(),
        }})
        if not success:
            logger.warning("Zapier delivery %s: %s (%s)", delivery["id"], state, status or error)
        if status == 410:
            await self.db.sirius_zapier_hooks.update_one({"user_id": uid, "id": hook["id"]},
                                                       {"$set": {"active": False}})

    async def tick(self):
        async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False,
                                     transport=self.transport) as client:
            async for hook in self.db.sirius_zapier_hooks.find({"active": True}):
                key = await self.db.sirius_zapier_keys.find_one({"user_id": hook["user_id"], "id": hook["key_id"]})
                try:
                    await self.valid_key(key)
                except HTTPException as exc:
                    await self.db.sirius_zapier_hooks.update_one(
                        {"user_id": hook["user_id"], "id": hook["id"], "active": True},
                        {"$set": {"active": exc.status_code != 401, "paused_reason": exc.detail}})
                    continue
                await self.db.sirius_zapier_hooks.update_one(
                    {"user_id": hook["user_id"], "id": hook["id"], "active": True}, {"$set": {"paused_reason": None}})
                await self.discover(hook)
                deliveries = await self.db.sirius_zapier_deliveries.find({
                    "user_id": hook["user_id"], "hook_id": hook["id"],
                    "state": {"$in": ["PENDING", "SENDING"]}, "next_at": {"$lte": now()},
                }).sort("created_at", 1).to_list(50)
                for delivery in deliveries:
                    await self.deliver(hook, delivery, client)

    async def loop(self):
        while True:
            try:
                await self.tick()
            except Exception:
                logger.exception("Zapier dispatcher failed; durable state retained")
            await asyncio.sleep(15)


def make_zapier_router(service, require_user):
    router = APIRouter(prefix="/integrations/zapier", tags=["zapier"])
    db = service.db

    async def owner(request):
        return (await require_user(request, db))["user_id"]

    @router.post("/keys", status_code=201)
    async def create_key(body: KeyIn, request: Request):
        return await service.create_key(await owner(request), body)

    @router.get("/keys")
    async def keys(request: Request):
        uid = await owner(request)
        return {"keys": [service.public_key(row) async for row in db.sirius_zapier_keys.find({"user_id": uid})]}

    @router.delete("/keys/{identity}")
    async def revoke(identity: str, request: Request):
        uid = await owner(request)
        result = await db.sirius_zapier_keys.update_one({"user_id": uid, "id": identity}, {"$set": {"active": False}})
        if not result.matched_count:
            raise HTTPException(404, "Clé introuvable.")
        await db.sirius_zapier_hooks.update_many({"user_id": uid, "key_id": identity}, {"$set": {"active": False}})
        return {"revoked": True}

    @router.get("/deliveries")
    async def deliveries(request: Request):
        uid = await owner(request)
        return {"deliveries": await db.sirius_zapier_deliveries.find({"user_id": uid}, {"_id": 0}).sort(
            "created_at", -1).to_list(100)}

    @router.get("/hooks")
    async def hooks(request: Request):
        uid = await owner(request)
        return {"hooks": await db.sirius_zapier_hooks.find(
            {"user_id": uid}, {"_id": 0, "secret": 0, "target_url": 0}).to_list(100)}

    @router.get("/me")
    async def me(request: Request):
        key = await service.authenticate(request)
        return {"id": key["id"], "label": key["label"], "scopes": key["scopes"], "expires_at": key["expires_at"]}

    @router.get("/dossiers")
    async def dossiers(request: Request, title: str = "", id: str = ""):
        key = await service.authenticate(request, "dossiers:read")
        if len(title) > 200 or len(id) > 120 or not (title.strip() or id):
            raise HTTPException(422, "Titre exact ou identifiant requis.")
        query = {"user_id": key["user_id"], **({"id": id} if id else {"title": title.strip()})}
        return await db.sirius_work_dossiers.find(query, {
            "_id": 0, "id": 1, "title": 1, "category": 1, "created_at": 1,
        }).sort("created_at", -1).to_list(20)

    @router.post("/notes")
    async def note(body: NoteIn, request: Request):
        return await service.note(await service.authenticate(request, "notes:write"), body)

    @router.post("/hooks", status_code=201)
    async def subscribe(body: HookIn, request: Request):
        return await service.subscribe(await service.authenticate(request, "hooks:write"), body)

    @router.delete("/hooks/{identity}")
    async def unsubscribe(identity: str, request: Request):
        key = await service.authenticate(request, "hooks:write")
        result = await db.sirius_zapier_hooks.update_one(
            {"user_id": key["user_id"], "key_id": key["id"], "id": identity}, {"$set": {"active": False}})
        if not result.matched_count:
            raise HTTPException(404, "Abonnement introuvable.")
        return {"unsubscribed": True}

    @router.get("/samples/{event}")
    async def samples(event: Event, request: Request):
        key = await service.authenticate(request, EVENTS[event][2])
        collection, field, _ = EVENTS[event]
        query = {"user_id": key["user_id"]}
        if event == "meeting.ready":
            query.update({"state": "READY", "ready_at": {"$exists": True}})
        rows = await db[collection].find(query).sort(field, -1).to_list(3)
        return [service.payload(event, row) for row in rows]

    return router
