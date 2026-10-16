"""Bounded ARIANE read-only execution: PORTUS calculations and NEMESIS trace.

Completed steps are immutable snapshots. Resume only runs missing steps; it
never creates price alerts, notifications, trades, or schedules implicitly.
"""

import asyncio
import logging
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from pymongo.errors import PyMongoError

from nummarius_api import STOCKS
from nummarius_market_data import technical_analysis
from work_draft_recordings import digest, insert_once

logger = logging.getLogger(__name__)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class MarketRunIn(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    request_id: uuid.UUID
    symbols: list[Literal["AAPL", "MSFT", "NVDA", "TSLA"]] = Field(min_length=1, max_length=4)
    period: Literal["1m", "3m", "1y", "5y"] = "1y"
    volatility_threshold_pct: float = Field(default=30, gt=0, le=1000, strict=True)


def evaluate_rules(analyses, threshold):
    findings, missing = [], []
    for analysis in analyses:
        symbol = analysis["symbol"]
        volatility = analysis["volatility_20d_annualized_pct"]
        if volatility is None:
            missing.append({"symbol": symbol, "field": "volatility_20d_annualized_pct",
                            "reason": "Historique insuffisant pour vingt rendements."})
        elif volatility > threshold:
            findings.append({
                "symbol": symbol, "rule": "volatility_above_threshold",
                "observed": volatility, "operator": ">", "threshold": threshold, "unit": "%",
                "as_of": analysis["as_of"], "data_version": analysis["data_version"],
                "explanation": "Volatilité historique annualisée supérieure au seuil choisi ; ce n'est pas une prévision.",
            })
        if analysis["age_calendar_days"] > 7:
            missing.append({"symbol": symbol, "field": "as_of", "reason": "Dernière séance vieille de plus de sept jours."})
        if analysis["rejected_bars"]:
            missing.append({"symbol": symbol, "field": "rejected_bars", "reason": "Observations invalides écartées par PORTUS."})
    return {"findings": findings, "missing": missing, "alerts_created": 0,
            "rule_parameters": {"volatility_threshold_pct": threshold, "operator": "strictly_greater"}}


class MarketRuns:
    def __init__(self, db, reader=technical_analysis):
        self.db, self.reader = db, reader

    async def event(self, uid, run_id, step, outcome, **details):
        await self.db.sirius_ariane_events.insert_one({
            "id": uuid.uuid4().hex, "user_id": uid, "run_id": run_id,
            "step": step, "outcome": outcome, "at": now_iso(), **details,
        })

    async def run_for(self, uid, run_id):
        run = await self.db.sirius_ariane_runs.find_one({"user_id": uid, "id": run_id}, {"_id": 0})
        if not run:
            raise HTTPException(404, "Parcours ARIANE introuvable.")
        return run

    async def create(self, uid, body):
        if len(set(body.symbols)) != len(body.symbols):
            raise HTTPException(422, "Les actions du parcours doivent être distinctes.")
        config = body.model_dump(exclude={"request_id"})
        run_id = digest([uid, str(body.request_id)])[:32]
        created = datetime.now(timezone.utc)
        run, _ = await insert_once(self.db, "sirius_ariane_runs", {
            "id": run_id, "user_id": uid, "config": config,
            "created_at": created.isoformat(), "expires_at": (created + timedelta(hours=24)).isoformat(),
            "mode": "read_only", "template": "portus_market_review_v1",
        })
        if run["config"] != config:
            raise HTTPException(409, "Cette référence correspond à un autre parcours. Retrouvez son suivi ou utilisez une nouvelle demande.")
        return await self.execute(uid, run_id)

    async def saved_step(self, uid, run_id, step):
        return await self.db.sirius_ariane_steps.find_one({
            "user_id": uid, "id": f"{run_id}:{step}",
        }, {"_id": 0})

    async def save_step(self, uid, run_id, step, output):
        saved, _ = await insert_once(self.db, "sirius_ariane_steps", {
            "id": f"{run_id}:{step}", "user_id": uid, "run_id": run_id, "step": step,
            "state": "COMPLETED", "completed_at": now_iso(), "output": output,
        })
        return saved

    async def analysis_step(self, uid, run, symbol):
        run_id, step = run["id"], "analysis:" + symbol
        if await self.saved_step(uid, run_id, step):
            return
        attempt_id = uuid.uuid4().hex
        await self.event(uid, run_id, step, "RUNNING", attempt_id=attempt_id)
        try:
            async with asyncio.timeout(25):
                analysis = await self.reader(symbol, dict(STOCKS)[symbol], run["config"]["period"])
        except (HTTPException, TimeoutError) as exc:
            if isinstance(exc, HTTPException) and exc.status_code != 503:
                raise
            logger.warning("ARIANE %s step %s unavailable", run_id, step)
            await self.event(uid, run_id, step, "BLOCKED", attempt_id=attempt_id,
                             reason="Données PORTUS indisponibles. Reprenez cette même référence après vérification.")
            return
        if run["expires_at"] <= now_iso():
            await self.event(uid, run_id, step, "EXPIRED", attempt_id=attempt_id,
                             reason="Parcours expiré pendant la lecture ; résultat non enregistré.")
            return
        saved = await self.save_step(uid, run_id, step, analysis)
        output = saved["output"]
        await self.event(uid, run_id, step, "COMPLETED", attempt_id=attempt_id,
                         source=output["source"], fetched_at=output["fetched_at"],
                         as_of=output["as_of"], currency=output["currency"], data_version=output["data_version"],
                         calculation_version=output["calculation_version"],
                         calculation_parameters=output["calculation_parameters"])

    async def execute(self, uid, run_id):
        run = await self.run_for(uid, run_id)
        if run["expires_at"] <= now_iso():
            return await self.status(uid, run_id)
        results = await asyncio.gather(*(self.analysis_step(uid, run, symbol) for symbol in run["config"]["symbols"]),
                                       return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
        analyses = [await self.saved_step(uid, run_id, "analysis:" + symbol) for symbol in run["config"]["symbols"]]
        if all(analyses) and run["expires_at"] > now_iso():
            if not await self.saved_step(uid, run_id, "rules"):
                rules = evaluate_rules([item["output"] for item in analyses], run["config"]["volatility_threshold_pct"])
                await self.save_step(uid, run_id, "rules", rules)
            rules = await self.saved_step(uid, run_id, "rules")
            if not await self.saved_step(uid, run_id, "summary"):
                output = rules["output"]
                summary = (
                    f"{len(analyses)} action(s) analysée(s), {len(output['findings'])} dépassement(s) du seuil de volatilité, "
                    f"{len(output['missing'])} réserve(s) sur les données. "
                    "Analyse de titres du catalogue, pas de votre portefeuille personnel. "
                    "Aucune alerte créée, aucun ordre ni notification envoyé. "
                    "Les résultats sont descriptifs, pas une recommandation personnalisée."
                )
                await self.save_step(uid, run_id, "summary", {"text": summary})
        return await self.status(uid, run_id)

    async def status(self, uid, run_id):
        run = await self.run_for(uid, run_id)
        events = await self.db.sirius_ariane_events.find(
            {"user_id": uid, "run_id": run_id}, {"_id": 0},
        ).sort("at", -1).to_list(101)
        steps = []
        symbols = run["config"]["symbols"]
        for step in [*("analysis:" + symbol for symbol in symbols), "rules", "summary"]:
            saved = await self.saved_step(uid, run_id, step)
            latest = next((event for event in events if event["step"] == step), None)
            state = "COMPLETED" if saved else latest["outcome"] if latest else "PENDING"
            if state == "RUNNING" and latest["at"] < (datetime.now(timezone.utc) - timedelta(seconds=90)).isoformat():
                state = "INTERRUPTED"
            steps.append({
                "id": step, "state": state, "output": saved["output"] if saved else None,
                "completed_at": saved["completed_at"] if saved else None,
                "snapshot_age_calendar_days": (datetime.now(timezone.utc).date()
                    - datetime.fromisoformat(saved["output"]["as_of"]).date()).days
                    if saved and saved["output"].get("as_of") else None,
                "depends_on": [] if step.startswith("analysis:") else ["analysis:" + symbol for symbol in symbols]
                if step == "rules" else ["rules"],
            })
        complete = all(step["state"] == "COMPLETED" for step in steps)
        state = "COMPLETED" if complete else "EXPIRED" if run["expires_at"] <= now_iso() else (
            "BLOCKED" if any(step["state"] in ("BLOCKED", "INTERRUPTED") for step in steps)
            else "RUNNING" if any(step["state"] == "RUNNING" for step in steps) else "PENDING"
        )
        return {**run, "state": state, "steps": steps, "trace": list(reversed(events[:100])),
                "trace_truncated": len(events) > 100, "external_actions_executed": False,
                "resume_policy": "missing_steps_only_same_snapshots", "alerts_created": 0}

    async def listing(self, uid):
        runs = await self.db.sirius_ariane_runs.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(21)
        return {"items": runs[:20], "truncated": len(runs) > 20}


def make_ariane_market_router(db, require_user):
    router = APIRouter(prefix="/ariane/market-runs", tags=["ariane"])
    service = MarketRuns(db)

    async def call(request, method, *args):
        uid = (await require_user(request, db))["user_id"]
        try:
            return await method(uid, *args)
        except (sqlite3.Error, PyMongoError) as exc:
            logger.exception("ARIANE journal unavailable; recover same request reference")
            raise HTTPException(503, "Journal ARIANE indisponible. Le suivi peut être partiel ; "
                                "reprenez la même référence. Aucun ordre ni alerte exécuté.") from exc

    @router.post("")
    async def create(body: MarketRunIn, request: Request):
        return await call(request, service.create, body)

    @router.get("")
    async def listing(request: Request):
        return await call(request, service.listing)

    @router.get("/{run_id}")
    async def status(run_id: str, request: Request):
        return await call(request, service.status, run_id)

    @router.post("/{run_id}/resume")
    async def resume(run_id: str, request: Request):
        return await call(request, service.execute, run_id)

    return router
