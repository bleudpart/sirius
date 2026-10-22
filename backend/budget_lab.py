"""Read-only budget evidence and an opt-in, fixed synthetic CSV benchmark."""

import asyncio
import csv
import io
import logging
import re
import sqlite3
import time
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from pymongo.errors import PyMongoError

from action_registry import ActionDefinition, ActionInputs, ActionOutput
from work_draft_recordings import digest, insert_once

logger = logging.getLogger(__name__)


class CsvBudgetIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=200_000)


class UsageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    used: bool = Field(strict=True)


class ShadowIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = Field(strict=True)


def parse_transactions(text):
    """Explicit EUR contract: date,label,amount,currency; decimal point, no guessing."""
    try:
        reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")), strict=True)
        if reader.fieldnames != ["date", "label", "amount", "currency"]:
            raise ValueError("En-tête requis : date,label,amount,currency.")
        rows = []
        for index, row in enumerate(reader, 2):
            if index > 2001 or None in row or any(value is None for value in row.values()):
                raise ValueError("Deux mille lignes complètes maximum.")
            stamp = date.fromisoformat(row["date"].strip())
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", row["date"].strip()):
                raise ValueError("Dates requises au format AAAA-MM-JJ.")
            if stamp > datetime.now(timezone.utc).date():
                raise ValueError("Une opération ne peut pas être future.")
            label = " ".join(row["label"].split())
            amount = Decimal(row["amount"].strip())
            if (not re.fullmatch(r"-?\d{1,10}(?:\.\d{1,2})?", row["amount"].strip())
                    or not label or len(label) > 160 or row["currency"].strip() != "EUR"
                    or not amount.is_finite() or abs(amount) > 1_000_000_000
                    or amount != amount.quantize(Decimal("0.01"))):
                raise ValueError("Libellé requis, montants finis à deux décimales maximum et devise EUR uniquement.")
            rows.append({"date": stamp.isoformat(), "label": label, "cents": int(amount * 100)})
        if not rows:
            raise ValueError("Le relevé est vide.")
        return sorted(rows, key=lambda row: (row["date"], row["label"], row["cents"]))
    except (ValueError, InvalidOperation, csv.Error) as exc:
        raise HTTPException(422, f"CSV refusé, aucune analyse enregistrée. {exc}") from exc


def analyze_budget(rows):
    grouped = defaultdict(list)
    months = defaultdict(lambda: {"income_cents": 0, "expenses_cents": 0})
    for row in rows:
        monthly = months[row["date"][:7]]
        monthly["income_cents" if row["cents"] >= 0 else "expenses_cents"] += abs(row["cents"])
        if row["cents"] < 0:
            grouped[row["label"].casefold()].append(row)
    candidates = []
    for label, payments in sorted(grouped.items()):
        if len(payments) < 3:
            continue
        dates = [date.fromisoformat(row["date"]) for row in payments]
        gaps = [(right - left).days for left, right in zip(dates, dates[1:])]
        amounts = sorted(abs(row["cents"]) for row in payments)
        typical = (amounts[(len(amounts) - 1) // 2] + amounts[len(amounts) // 2]) // 2
        if not all(25 <= gap <= 35 for gap in gaps) or max(amounts) - min(amounts) > max(1, typical // 20):
            continue
        candidates.append({
            "id": digest(label)[:32], "label": payments[-1]["label"],
            "monthly_cents": typical, "annual_estimate_cents": typical * 12,
            "occurrences": len(payments), "first_date": dates[0].isoformat(),
            "last_date": dates[-1].isoformat(),
            "evidence": "Au moins trois débits de même libellé, espacés de 25 à 35 jours, montants proches.",
        })
    return {
        "months": [{"month": month, **amounts, "net_cents": amounts["income_cents"] - amounts["expenses_cents"]}
                   for month, amounts in sorted(months.items())],
        "candidates": candidates, "transaction_count": len(rows),
        "first_date": rows[0]["date"], "last_date": rows[-1]["date"],
        "limitations": [
            "Débits récurrents possibles, pas preuve d'abonnement ni d'inutilisation.",
            "Les libellés différents ne sont pas regroupés. Doublons et opérations absentes faussent l'analyse.",
            "Les mois peuvent être incomplets. Le solde du relevé n'est pas votre solde bancaire ni une épargne disponible.",
            "Estimation annuelle au tarif observé, sans engagement contractuel, frais ni garantie d'économie.",
            "Aucun accès bancaire, virement, résiliation ou transmission à une IA externe.",
        ],
    }


def local_benchmark():
    """Compare only fixed in-process parsers, never client CSV, URLs, or generated code."""
    fixtures = [
        ("2026-01-01,Cafe,-12.50,EUR", True),
        ('2026-01-01,"Cafe, musique",-12.50,EUR', True),
        ("2026-01-01,Cafe,NaN,EUR", False),
        ("2026-01-01,Cafe,-12.50,USD", False),
        ("2026-01-01,Cafe,-12.501,EUR", False),
        ("date,label,amount,currency", False),
    ]
    results = []
    for name in ("decoupage_naif", "csv_strict"):
        started = time.perf_counter()
        correct = 0
        for line, expected in fixtures:
            text = "date,label,amount,currency\n" + line
            if name == "decoupage_naif":
                parts = line.split(",")
                accepted = len(parts) == 4 and bool(re.fullmatch(r"-?\d+(?:\.\d{1,2})?", parts[2])) and parts[3] == "EUR"
            else:
                try:
                    parse_transactions(text)
                    accepted = True
                except HTTPException as exc:
                    if exc.status_code != 422:
                        raise
                    accepted = False
            correct += accepted == expected
        results.append({"tool": name, "correct": correct, "cases": len(fixtures),
                        "elapsed_ms": round((time.perf_counter() - started) * 1000, 3)})
    return {"results": results, "cost_eur": 0, "external_calls": 0,
            "scope": "Six cas CSV fictifs fixes ; pas une certification ni une mesure de performance générale.",
            "production_modified": False}


class BudgetLab:
    def __init__(self, db):
        self.db = db

    async def storage(self, operation):
        try:
            return await operation
        except (sqlite3.Error, PyMongoError) as exc:
            logger.exception("Budget/lab persistence unavailable")
            raise HTTPException(503, "Stockage indisponible ; réessayez sans modifier la demande.") from exc

    async def persist(self, collection, document):
        saved, _ = await self.storage(insert_once(self.db, collection, document))
        return saved

    async def analysis_for(self, uid, identity):
        saved = await self.storage(self.db.sirius_budget_analyses.find_one({"user_id": uid, "id": identity}, {"_id": 0}))
        if not saved:
            raise HTTPException(404, "Analyse introuvable pour ce compte.")
        return saved

    async def analyze(self, uid, body):
        rows = parse_transactions(body.text)
        return await self.persist("sirius_budget_analyses", {
            "id": digest(["budget-v1", uid, rows])[:32], "user_id": uid,
            "created_at": datetime.now(timezone.utc).isoformat(), **analyze_budget(rows),
        })

    async def usage(self, uid, identity, candidate, body):
        saved = await self.analysis_for(uid, identity)
        item = next((item for item in saved["candidates"] if item["id"] == candidate), None)
        if item is None:
            raise HTTPException(404, "Débit récurrent introuvable dans cette analyse.")
        decision = {
            "id": digest([uid, identity, candidate])[:32], "user_id": uid,
            "analysis_id": identity, "candidate_id": candidate, "used": body.used,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "recommendation": "Conserver ou vérifier le contrat." if body.used else
                "Vérifier le contrat, les frais et la date d'engagement avant de demander une résiliation au fournisseur.",
            "potential_annual_cents": 0 if body.used else item["annual_estimate_cents"],
            "executed": False,
        }
        await self.persist("sirius_budget_decisions", decision)
        await self.storage(self.db.sirius_budget_decisions.update_one(
            {"user_id": uid, "id": decision["id"]}, {"$set": decision}))
        return decision

    async def history(self, uid):
        return {
            "analyses": await self.storage(self.db.sirius_budget_analyses.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(20)),
            "decisions": await self.storage(self.db.sirius_budget_decisions.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(100)),
            "experiments": await self.storage(self.db.sirius_lab_runs.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(20)),
            "shadow": await self.shadow_status(uid),
        }

    async def shadow_status(self, uid):
        saved = await self.storage(self.db.sirius_shadow_settings.find_one({"user_id": uid}, {"_id": 0}))
        return saved or {"enabled": False, "next_run_at": None}

    async def configure_shadow(self, uid, body, now=None):
        now = now or datetime.now(timezone.utc)
        previous = await self.shadow_status(uid)
        if previous["enabled"] == body.enabled:
            return previous
        setting = {"id": "shadow-local-v1", "user_id": uid, "enabled": body.enabled,
                   "updated_at": now.isoformat(),
                   "next_run_at": (now + timedelta(days=1)).isoformat() if body.enabled else None}
        await self.persist("sirius_shadow_settings", setting)
        await self.storage(self.db.sirius_shadow_settings.update_one(
            {"user_id": uid, "id": setting["id"]}, {"$set": setting}))
        return setting

    async def shadow_tick(self, now=None):
        now = now or datetime.now(timezone.utc)
        async for setting in self.db.sirius_shadow_settings.find({
            "enabled": True, "next_run_at": {"$lte": now.isoformat()},
        }, {"_id": 0}):
            uid = setting["user_id"]
            user = await self.storage(self.db.users.find_one({"user_id": uid}, {"_id": 0}))
            if not user or user.get("disabled"):
                continue
            current = await self.shadow_status(uid)
            if not current["enabled"] or current.get("updated_at") != setting["updated_at"]:
                continue
            recent = await self.storage(self.db.sirius_lab_runs.find({
                "user_id": uid, "mode": "shadow",
                "created_at": {"$gt": (now - timedelta(days=1)).isoformat()},
            }, {"_id": 0}).to_list(1))
            if recent:
                continue
            identity = digest([uid, "shadow-local-v1", now.date().isoformat()])[:32]
            _, claimed = await self.storage(insert_once(self.db, "sirius_lab_runs", {
                "id": identity, "user_id": uid, "mode": "shadow", "state": "RUNNING",
                "created_at": now.isoformat(),
                "notice": "Essai engagé : résultat non confirmé tant que l'état n'est pas COMPLETED.",
            }))
            if not claimed:
                continue
            # Fixed synthetic tests only; no URLs, discovery, credentials or generated code.
            try:
                result = local_benchmark()
                strict, naive = result["results"][1], result["results"][0]
                proposal = ("Préférer le parseur CSV strict au découpage naïf pour ces cas fictifs. "
                            "Le parseur budgétaire utilise déjà le mode strict ; aucune modification nécessaire."
                            if strict["correct"] > naive["correct"] else
                            "Aucune amélioration démontrée par ce banc d'essai limité.")
                result.update({"state": "COMPLETED", "proposal": proposal, "finished_at": now.isoformat()})
            except (HTTPException, ValueError):
                logger.exception("Shadow local benchmark failed")
                result = {"state": "BLOCKED", "error": "Essai local échoué ; aucune amélioration validée.",
                          "finished_at": now.isoformat()}
            await self.storage(self.db.sirius_lab_runs.update_one(
                {"user_id": uid, "id": identity}, {"$set": result}))
            await self.storage(self.db.sirius_shadow_settings.update_one(
                {"user_id": uid, "id": setting["id"], "updated_at": setting["updated_at"]},
                {"$set": {"next_run_at": (now + timedelta(days=1)).isoformat()}}))

    async def shadow_loop(self):
        while True:
            try:
                await self.shadow_tick()
            except (sqlite3.Error, PyMongoError, HTTPException):
                logger.exception("Shadow scheduler unavailable; no successful result assumed")
            await asyncio.sleep(60)

    @staticmethod
    def policy():
        return {"cerebras": {"enabled": False, "monthly_budget_eur": 0, "free_quota_verified": False,
                            "reason": "Quota gratuit non vérifié : aucun appel Cerebras autorisé."},
                "local": {"enabled": True, "manual_start_only": True, "synthetic_data_only": True},
                "shadow": {"default_enabled": False, "interval_hours": 24, "external_calls": False,
                           "catalog": ["decoupage_naif", "csv_strict"]},
                "code_modification": False, "deployment": False}

    async def run_local(self, uid, identity):
        return await self.persist("sirius_lab_runs", {
            "id": identity, "user_id": uid,
            "created_at": datetime.now(timezone.utc).isoformat(), **local_benchmark(),
        })

    def register(self, registry):
        async def history(context, inputs):
            return ActionOutput(data=await self.history(context.user_id))

        async def policy(context, inputs):
            return ActionOutput(data=self.policy())

        async def experiment(context, inputs):
            return ActionOutput(data=await self.run_local(context.user_id, digest(context.idempotency_key)[:32]))

        for definition in (
            ActionDefinition("budget.history", "PORTUS", "Consulter les analyses budgétaires du compte", "1",
                             ActionInputs, ActionOutput, history),
            ActionDefinition("lab.policy", "NÉMÉSIS", "Vérifier les limites du laboratoire", "1",
                             ActionInputs, ActionOutput, policy),
            ActionDefinition("lab.local", "ARIANE", "Comparer deux parseurs sur six cas fictifs fixes", "1",
                             ActionInputs, ActionOutput, experiment, kind="mutation", risk="sensitive",
                             timeout_seconds=5, max_attempts=1),
        ):
            registry.register(definition)


def make_budget_lab_router(service, require_user):
    router = APIRouter(prefix="/nummarius", tags=["budget-lab"])

    async def owner(request):
        return (await require_user(request, service.db))["user_id"]

    @router.post("/budget/analyze")
    async def analyze(body: CsvBudgetIn, request: Request):
        return await service.analyze(await owner(request), body)

    @router.put("/budget/{identity}/usage/{candidate}")
    async def usage(identity: str, candidate: str, body: UsageIn, request: Request):
        return await service.usage(await owner(request), identity, candidate, body)

    @router.get("/budget/history")
    async def history(request: Request):
        return await service.history(await owner(request))

    @router.get("/lab/policy")
    async def policy(request: Request):
        await owner(request)
        return service.policy()

    @router.post("/lab/local")
    async def run_local(request: Request):
        return await service.run_local(await owner(request), uuid.uuid4().hex)

    @router.put("/lab/shadow")
    async def configure_shadow(body: ShadowIn, request: Request):
        return await service.configure_shadow(await owner(request), body)

    return router
