"""Opt-in background proposals from ARIANE state; never executes a plan or an API."""

import asyncio
import logging
import sqlite3
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field
from pymongo.errors import PyMongoError

from action_registry import ActionInputs
from work_draft_recordings import digest, insert_once

logger = logging.getLogger(__name__)
INTERVAL = timedelta(minutes=15)


class InitiativeSettings(ActionInputs):
    enabled: bool = Field(strict=True)


def utc_now():
    return datetime.now(timezone.utc)


class ActionInitiatives:
    def __init__(self, db, runs):
        self.db, self.runs = db, runs

    async def settings(self, uid):
        saved = await self.db.sirius_initiative_settings.find_one({"user_id": uid, "id": "ariane-v1"}, {"_id": 0})
        return saved or {"enabled": False, "next_check_at": None, "last_error": None}

    async def configure(self, uid, body, now=None):
        now = now or utc_now()
        previous = await self.settings(uid)
        if previous["enabled"] == body.enabled:
            return previous
        saved = {"user_id": uid, "id": "ariane-v1", "enabled": body.enabled,
                 "revision": digest([uid, now.isoformat(), body.enabled]),
                 "updated_at": now.isoformat(), "last_check_at": None, "last_error": None,
                 "next_check_at": (now + INTERVAL).isoformat() if body.enabled else None}
        await insert_once(self.db, "sirius_initiative_settings", saved)
        await self.db.sirius_initiative_settings.update_one({"user_id": uid, "id": saved["id"]}, {"$set": saved})
        return saved

    async def source_state(self, uid, run_id):
        state = await self.runs.status(uid, run_id)
        if state["state"] not in ("BLOCKED", "WAITING_CONFIRMATION"):
            return None
        return state["state"]

    async def tick_user(self, setting, now):
        uid = setting["user_id"]
        user = await self.db.users.find_one({"user_id": uid}, {"_id": 0})
        if not user or user.get("disabled"):
            return
        current = await self.settings(uid)
        if not current["enabled"] or current.get("revision") != setting.get("revision"):
            return
        # Atomic claim bounds scans across workers, without claiming any business action.
        claimed = await self.db.sirius_initiative_settings.update_one({
            "user_id": uid, "id": "ariane-v1", "enabled": True, "revision": setting["revision"],
            "next_check_at": setting["next_check_at"],
        }, {"$set": {"next_check_at": (now + INTERVAL).isoformat(),
                     "last_check_at": now.isoformat(), "last_error": "Contrôle engagé ; résultat non confirmé."}})
        if not claimed.modified_count:
            return
        try:
            recent = await self.db.sirius_action_runs.find({
                "user_id": uid, "expires_at": {"$gt": now.isoformat()},
                "created_at": {"$lte": (now - INTERVAL).isoformat()},
            }, {"_id": 0}).sort("created_at", -1).to_list(20)
            for run in recent:
                current = await self.settings(uid)
                if not current["enabled"] or current.get("revision") != setting["revision"]:
                    break
                state = await self.source_state(uid, run["id"])
                if state is None:
                    continue
                current = await self.settings(uid)
                if not current["enabled"] or current.get("revision") != setting["revision"]:
                    break
                identity = digest([uid, "ariane-initiative-v1", run["id"], state])[:32]
                await insert_once(self.db, "sirius_action_proposals", {
                    "id": identity, "user_id": uid, "run_id": run["id"], "source_state": state,
                    "created_at": now.isoformat(), "dismissed": False,
                    "title": "Parcours à vérifier" if state == "BLOCKED" else "Validation en attente",
                    "reason": "Un parcours non expiré est bloqué." if state == "BLOCKED" else
                              "Un parcours créé depuis au moins quinze minutes contient une étape attendant votre accord.",
                    "proposal": "Consulter les preuves du même parcours avant de décider d'une reprise." if state == "BLOCKED" else
                                "Relire les entrées exactes ; confirmer seulement si l'action est toujours souhaitée.",
                    "action": "review_only", "executed": False, "external_calls": 0,
                })
            await self.db.sirius_initiative_settings.update_one({
                "user_id": uid, "id": "ariane-v1", "revision": setting["revision"],
            }, {"$set": {"last_error": None}})
        except (sqlite3.Error, PyMongoError, HTTPException):
            logger.exception("ARIANE local initiative scan failed")
            await self.db.sirius_initiative_settings.update_one({
                "user_id": uid, "id": "ariane-v1", "revision": setting["revision"],
            }, {"$set": {"last_error": "Contrôle local indisponible ou partiel ; aucun parcours exécuté."}})
            raise

    async def tick(self, now=None):
        now = now or utc_now()
        async for setting in self.db.sirius_initiative_settings.find({
            "enabled": True, "next_check_at": {"$lte": now.isoformat()},
        }, {"_id": 0}):
            try:
                await self.tick_user(setting, now)
            except (sqlite3.Error, PyMongoError, HTTPException):
                logger.exception("ARIANE local initiatives blocked for one account")

    async def loop(self):
        while True:
            try:
                await self.tick()
            except (sqlite3.Error, PyMongoError):
                logger.exception("ARIANE initiative scheduler storage unavailable")
            await asyncio.sleep(60)

    async def listing(self, uid):
        items = await self.db.sirius_action_proposals.find({
            "user_id": uid, "dismissed": False,
        }, {"_id": 0}).sort("created_at", -1).to_list(21)
        visible = []
        for item in items[:20]:
            try:
                current_state = await self.source_state(uid, item["run_id"])
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                current_state = None
            visible.append({**item, "current": current_state == item["source_state"]})
        return {"settings": await self.settings(uid), "items": visible, "truncated": len(items) > 20}

    async def dismiss(self, uid, identity):
        result = await self.db.sirius_action_proposals.update_one({
            "user_id": uid, "id": identity,
        }, {"$set": {"dismissed": True, "dismissed_at": utc_now().isoformat()}})
        if not result.matched_count:
            raise HTTPException(404, "Proposition introuvable pour ce compte.")
        return await self.listing(uid)


def make_initiative_router(service, require_user):
    router = APIRouter(prefix="/ariane/initiatives", tags=["ariane-initiatives"])

    async def call(request, operation, *args):
        user = await require_user(request, service.db)
        try:
            return await operation(user["user_id"], *args)
        except (sqlite3.Error, PyMongoError) as exc:
            logger.exception("ARIANE initiative storage unavailable")
            raise HTTPException(503, "Propositions proactives indisponibles ; aucune action lancée.") from exc

    @router.get("")
    async def listing(request: Request):
        return await call(request, service.listing)

    @router.put("/settings")
    async def settings(body: InitiativeSettings, request: Request):
        return await call(request, service.configure, body)

    @router.post("/{identity}/dismiss")
    async def dismiss(identity: str, request: Request):
        return await call(request, service.dismiss, identity)

    return router
