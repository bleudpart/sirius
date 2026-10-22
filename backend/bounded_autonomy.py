"""Explicit read-only autonomy over ARIANE; no screen, shell, model or arbitrary URL."""

import asyncio
import logging
import sqlite3
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field, StrictBool, ValidationError
from pymongo.errors import PyMongoError

from action_registry import ActionInputs
from action_runs import RunIn
from work_draft_recordings import insert_once

logger = logging.getLogger(__name__)
ALLOWED = frozenset({
    "budget.history", "lab.policy", "finance.overview", "finance.portfolio",
    "portus.analysis", "portus.volatility_rules",
})
ACTIVE = ("ACTIVE", "EXECUTING")


def now_utc():
    return datetime.now(timezone.utc)


class StartAutonomy(ActionInputs):
    confirm: StrictBool
    max_cycles: int = Field(default=2, strict=True, ge=1, le=3)
    max_seconds: int = Field(default=120, strict=True, ge=15, le=180)


class BoundedAutonomy:
    def __init__(self, db, runs):
        self.db, self.runs = db, runs

    def validate(self, run):
        self.runs.check_contracts(run)
        for step in run["plan"]["steps"]:
            contract = run["contracts"][step["id"]]
            if (step["action"] not in ALLOWED or contract["kind"] != "read"
                    or contract["risk"] != "low" or contract["confirmation_required"]):
                raise HTTPException(422, "Autonomie limitée aux lectures autorisées ; aucune mutation ni mission IA.")

    async def prepare(self, uid, body):
        contracts = self.runs.validate_plan(body)
        self.validate({"plan": body.model_dump(mode="json"), "contracts": contracts})
        return await self.runs.prepare(uid, body)

    async def status(self, uid, identity):
        saved = await self.db.sirius_autonomy_sessions.find_one({"user_id": uid, "id": identity}, {"_id": 0})
        if not saved:
            raise HTTPException(404, "Session autonome introuvable pour ce compte.")
        return {**saved, "run": await self.runs.status(uid, identity)}

    async def start(self, uid, identity, body):
        if not body.confirm:
            raise HTTPException(422, "Autorisation explicite du parcours et de ses limites requise.")
        run = await self.runs.owned(uid, identity)
        self.validate(run)
        state = await self.runs.status(uid, identity)
        if state["state"] in ("CANCELLED", "EXPIRED"):
            raise HTTPException(409, "Parcours arrêté ou expiré ; aucune relance autonome.")
        now = now_utc()
        await insert_once(self.db, "sirius_autonomy_sessions", {
            "id": identity, "user_id": uid, "state": "ACTIVE", "cycles": 0,
            "max_cycles": body.max_cycles, "max_seconds": body.max_seconds,
            "created_at": now.isoformat(), "deadline": (now + timedelta(seconds=body.max_seconds)).isoformat(),
            "next_check_at": now.isoformat(), "reason": "Parcours exact autorisé ; en attente du contrôleur.",
        })
        return await self.status(uid, identity)

    async def stop(self, uid, identity):
        await self.status(uid, identity)
        await self.db.sirius_autonomy_sessions.update_one(
            {"user_id": uid, "id": identity, "state": {"$in": list(ACTIVE)}},
            {"$set": {"state": "STOPPED", "reason": "Arrêt demandé ; une lecture déjà engagée peut terminer."}})
        await self.runs.cancel(uid, identity)
        return await self.status(uid, identity)

    async def finish(self, session, state, reason, **extra):
        await self.db.sirius_autonomy_sessions.update_one(
            {"user_id": session["user_id"], "id": session["id"], "state": {"$in": list(ACTIVE)}},
            {"$set": {"state": state, "reason": reason, **extra}})

    @staticmethod
    def retryable(run):
        for step in run["steps"]:
            if step["state"] in ("COMPLETED", "SKIPPED", "PENDING"):
                continue
            reflection = step.get("reflection") or {}
            if (step["state"] != "BLOCKED" or step.get("output") is not None
                    or reflection.get("http_status") not in (502, 503, 504)
                    or step["attempts"] >= step["attempt_limit"]):
                return False
        return True

    async def tick_session(self, session):
        uid, identity = session["user_id"], session["id"]
        now = now_utc()
        user = await self.db.users.find_one({"user_id": uid}, {"_id": 0})
        if not user or user.get("disabled"):
            await self.finish(session, "STOPPED", "Compte indisponible ; autonomie arrêtée.")
            return
        if session["deadline"] <= now.isoformat():
            await self.finish(session, "EXPIRED", "Durée autorisée atteinte ; aucune complétion supposée.")
            return
        if session["state"] == "EXECUTING":
            # Never replay an interrupted/unknown cycle after a process restart.
            return
        claim = await self.db.sirius_autonomy_sessions.update_one({
            "user_id": uid, "id": identity, "state": "ACTIVE", "cycles": session["cycles"],
        }, {"$set": {"state": "EXECUTING", "cycles": session["cycles"] + 1,
                     "next_check_at": session["deadline"], "reason": "Cycle engagé ; résultat pas encore confirmé."}})
        if not claim.modified_count:
            return
        try:
            run = await self.runs.status(uid, identity)
            self.validate(run)
            if run["state"] == "COMPLETED":
                await self.finish(session, "COMPLETED", "Toutes les étapes ont un résultat conforme au contrat.")
                return
            if run["state"] in ("CANCELLED", "EXPIRED") or not self.retryable(run):
                await self.finish(session, "BLOCKED", "Résultat partiel, refus ou effet incertain : intervention requise.")
                return
            current = await self.status(uid, identity)
            if current["state"] != "EXECUTING":
                return
            remaining = (datetime.fromisoformat(session["deadline"]) - now_utc()).total_seconds()
            if remaining <= 0:
                await self.finish(session, "EXPIRED", "Durée autorisée atteinte avant l'appel ; aucune lecture lancée.")
                return
            async with asyncio.timeout(min(remaining, 60)):
                run = await self.runs.execute(uid, identity)
            if run["state"] == "COMPLETED":
                await self.finish(session, "COMPLETED", "Résultats validés par les contrats ARIANE, pas vérifiés factuellement.")
            elif session["cycles"] + 1 >= session["max_cycles"] or not self.retryable(run):
                await self.finish(session, "BLOCKED", "Limite de cycles, résultat partiel ou erreur non rejouable ; vérifiez les preuves.")
            else:
                await self.finish(session, "ACTIVE", "Lecture temporairement indisponible ; nouvelle vérification après 15 secondes.",
                                  next_check_at=(now_utc() + timedelta(seconds=15)).isoformat())
        except TimeoutError:
            await self.runs.cancel(uid, identity)
            await self.finish(session, "BLOCKED", "Délai dépassé ; résultat incertain, aucune répétition automatique.")
        except HTTPException as exc:
            logger.warning("Bounded autonomy blocked (%s)", exc.status_code)
            await self.finish(session, "BLOCKED", "Contrat, compte ou parcours indisponible ; aucune adaptation aveugle.")
        except ValidationError:
            logger.exception("Bounded autonomy invalid action output")
            await self.finish(session, "BLOCKED", "Résultat non conforme au schéma ; aucune répétition automatique.")

    async def tick(self):
        now = now_utc().isoformat()
        sessions = await self.db.sirius_autonomy_sessions.find({
            "state": {"$in": list(ACTIVE)}, "next_check_at": {"$lte": now},
        }, {"_id": 0}).sort("created_at", 1).to_list(20)
        for session in sessions:
            await self.tick_session(session)

    async def loop(self):
        while True:
            try:
                await self.tick()
            except (sqlite3.Error, PyMongoError):
                logger.exception("Bounded autonomy storage unavailable; no success assumed")
            await asyncio.sleep(2)


def make_autonomy_router(service, require_user):
    router = APIRouter(prefix="/ariane/autonomy", tags=["ariane-autonomy"])

    async def call(request, operation, *args):
        user = await require_user(request, service.db)
        try:
            return await operation(user["user_id"], *args)
        except (sqlite3.Error, PyMongoError) as exc:
            logger.exception("Bounded autonomy storage unavailable")
            raise HTTPException(503, "Journal autonome indisponible ; résultat non confirmé.") from exc

    @router.post("/prepare")
    async def prepare(body: RunIn, request: Request):
        return await call(request, service.prepare, body)

    @router.post("/{identity}/start")
    async def start(identity: str, body: StartAutonomy, request: Request):
        return await call(request, service.start, identity, body)

    @router.get("/{identity}")
    async def status(identity: str, request: Request):
        return await call(request, service.status, identity)

    @router.post("/{identity}/stop")
    async def stop(identity: str, request: Request):
        return await call(request, service.stop, identity)

    return router
