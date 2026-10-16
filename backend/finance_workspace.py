"""Confirmed personal holdings, market watches and bounded CHRONOS routines."""

import asyncio
import csv
import io
import logging
import math
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pymongo.errors import PyMongoError

from ariane_market_runs import MarketRunIn, MarketRuns
from nummarius_api import STOCKS
from nummarius_market_data import technical_analysis
from work_draft_recordings import digest, insert_once

logger = logging.getLogger(__name__)
Symbol = Literal["AAPL", "MSFT", "NVDA", "TSLA"]
Period = Literal["1m", "3m", "1y", "5y"]


def utcnow():
    return datetime.now(timezone.utc)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Holding(StrictModel):
    symbol: Symbol
    quantity: float = Field(gt=0, le=1e9, strict=True)
    average_cost: float = Field(ge=0, le=1e9, strict=True)
    currency: Literal["USD"] = "USD"


class PortfolioAction(StrictModel):
    kind: Literal["portfolio"] = "portfolio"
    positions: list[Holding] = Field(min_length=0, max_length=4)

    @field_validator("positions")
    @classmethod
    def distinct(cls, positions):
        if len({item.symbol for item in positions}) != len(positions):
            raise ValueError("Une seule ligne par symbole ; regroupez quantités et coût moyen.")
        return positions


class AlertAction(StrictModel):
    kind: Literal["alert"] = "alert"
    symbol: Symbol
    condition: Literal["price_above", "price_below", "variation_above", "cross_above_mm200", "cross_below_mm200"]
    threshold: float | None = Field(default=None, gt=0, le=1e9, strict=True)

    @model_validator(mode="after")
    def explicit_threshold(self):
        if self.condition.startswith("cross_"):
            if self.threshold is not None:
                raise ValueError("Un croisement MM200 n'utilise pas de seuil de prix.")
        elif self.threshold is None:
            raise ValueError("Précisez le seuil en USD ou pourcentage.")
        return self


class RoutineAction(StrictModel):
    kind: Literal["routine"] = "routine"
    symbols: list[Symbol] = Field(min_length=1, max_length=4)
    period: Period = "1y"
    start_at: datetime
    recurrence: Literal["once", "daily", "weekly"] = "once"
    volatility_threshold_pct: float = Field(default=30, gt=0, le=1000, strict=True)

    @field_validator("symbols")
    @classmethod
    def distinct(cls, symbols):
        if len(set(symbols)) != len(symbols):
            raise ValueError("Les symboles doivent être distincts.")
        return symbols

    @field_validator("start_at", mode="before")
    @classmethod
    def offset_required(cls, value):
        if not isinstance(value, (str, datetime)):
            raise ValueError("Date ISO avec décalage UTC requise.")
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
        if stamp.tzinfo is None or stamp.utcoffset() is None:
            raise ValueError("Date ISO avec décalage UTC requise.")
        return stamp.astimezone(timezone.utc)


class DisableAction(StrictModel):
    kind: Literal["disable"] = "disable"
    target_kind: Literal["alert", "routine"]
    target_id: str = Field(pattern=r"^[a-f0-9]{32}$")


Action = Annotated[PortfolioAction | AlertAction | RoutineAction | DisableAction, Field(discriminator="kind")]


class PreviewIn(StrictModel):
    request_id: uuid.UUID
    action: Action


class CsvIn(StrictModel):
    request_id: uuid.UUID
    text: str = Field(max_length=100_000)


def parse_holdings_csv(text):
    positions = []
    try:
        reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")), strict=True)
        if reader.fieldnames != ["symbol", "quantity", "average_cost", "currency"]:
            raise HTTPException(422, "En-tête CSV requis : symbol,quantity,average_cost,currency (séparateur virgule).")
        for index, row in enumerate(reader, 2):
            if index > 5 or None in row or any(value is None for value in row.values()):
                raise ValueError("Quatre lignes complètes maximum.")
            positions.append(Holding(symbol=row["symbol"].strip().upper(),
                                     quantity=float(row["quantity"]), average_cost=float(row["average_cost"]),
                                     currency=row["currency"].strip().upper()))
        return PortfolioAction(positions=positions)
    except (ValueError, csv.Error) as exc:
        raise HTTPException(422, "CSV invalide : quatre symboles distincts du catalogue, quantités positives, "
                            "coûts finis positifs ou nuls, devise USD. Aucune ligne importée.") from exc


def action_summary(action):
    if action["kind"] == "portfolio":
        return ("Remplacer intégralement les positions déclarées par ces lignes (aucun ordre) : "
                + "; ".join(f"{p['symbol']} : {p['quantity']} titres, coût moyen {p['average_cost']} USD"
                            for p in action["positions"]) if action["positions"]
                else "Effacer toutes les positions déclarées. Aucun ordre de vente.")
    if action["kind"] == "alert":
        rule = (f"{action['condition']} sur les deux dernières séances" if action["condition"].startswith("cross_")
                else f"{action['condition']}, seuil {action['threshold']} {'%' if action['condition'] == 'variation_above' else 'USD'}")
        return (f"Activer la surveillance {action['symbol']} : {rule}. "
                "Évaluation des clôtures différées toutes les quinze minutes, serveur allumé ; "
                "notification dans PORTUS uniquement, pas de push PC/téléphone ni de courriel.")
    if action["kind"] == "routine":
        return (f"CHRONOS → ARIANE : analyser {', '.join(action['symbols'])}, période {action['period']}, "
                f"seuil de volatilité {action['volatility_threshold_pct']} %, à partir de {action['start_at']}, "
                f"récurrence {action['recurrence']}. Intervalles fixes UTC (24 h / 7 jours, pas heure locale fixe). "
                "Lectures et bilan seulement. Serveur allumé ; dernière échéance seule après une coupure.")
    return f"Suspendre {action['target_kind']} référence {action['target_id']}. Une lecture déjà commencée peut terminer."


class FinanceWorkspace:
    def __init__(self, db, reader=technical_analysis):
        self.db, self.reader = db, reader
        self.runs = MarketRuns(db, reader)

    async def portfolio(self, uid):
        rows = await self.db.sirius_finance_portfolios.find({"user_id": uid}, {"_id": 0}).sort("revision", -1).to_list(1)
        return rows[0] if rows else {"id": "empty", "revision": 0, "positions": []}

    async def preview(self, uid, body):
        action = body.action.model_dump(mode="json")
        identity = digest([uid, str(body.request_id)])[:32]
        existing = await self.db.sirius_finance_previews.find_one({"user_id": uid, "id": identity}, {"_id": 0})
        if existing:
            if existing["action"] != action:
                raise HTTPException(409, "Cette demande correspond à un autre aperçu.")
            return existing
        if action["kind"] == "routine":
            if not utcnow() < body.action.start_at <= utcnow() + timedelta(days=366):
                raise HTTPException(422, "Le premier déclenchement doit être futur et dans les 366 jours.")
        if action["kind"] == "disable":
            await self.target(uid, action["target_kind"], action["target_id"])
        base = await self.portfolio(uid) if action["kind"] == "portfolio" else None
        stamp = utcnow()
        saved, _ = await insert_once(self.db, "sirius_finance_previews", {
            "id": identity, "user_id": uid, "action": action,
            "base_revision": base["revision"] if base else None, "state": "WAITING_CONFIRMATION",
            "summary": action_summary(action), "created_at": stamp.isoformat(),
            "expires_at": (stamp + timedelta(minutes=30)).isoformat(),
        })
        if saved["action"] != action:
            raise HTTPException(409, "Cette demande correspond à un autre aperçu.")
        return saved

    async def target(self, uid, kind, identity):
        name = "sirius_finance_alerts" if kind == "alert" else "sirius_finance_routines"
        item = await self.db[name].find_one({"user_id": uid, "id": identity}, {"_id": 0})
        if not item:
            raise HTTPException(404, "Surveillance ou routine introuvable.")
        return item

    async def disabled(self, uid, identity):
        return bool(await self.db.sirius_finance_disabled.find_one({"user_id": uid, "id": identity}))

    async def confirm(self, uid, identity):
        preview = await self.db.sirius_finance_previews.find_one({"user_id": uid, "id": identity}, {"_id": 0})
        if not preview:
            raise HTTPException(404, "Aperçu introuvable.")
        action = preview["action"]
        kind = action["kind"]
        name = {"portfolio": "sirius_finance_portfolios", "alert": "sirius_finance_alerts",
                "routine": "sirius_finance_routines", "disable": "sirius_finance_disabled"}[kind]
        target_id = (digest([uid, "portfolio", preview["base_revision"] + 1])[:32] if kind == "portfolio"
                     else action["target_id"] if kind == "disable" else identity)
        previous = await self.db[name].find_one({"user_id": uid, "id": target_id}, {"_id": 0})
        if previous:
            if previous["preview_id"] != identity and kind != "disable":
                raise HTTPException(409, "Les données ont changé depuis cet aperçu ; préparez une nouvelle demande.")
            await self.trace(uid, identity, "CONFIRMED", {"kind": kind, "summary": preview["summary"]})
            return {"state": "COMPLETED", "result": previous, "replayed": True}
        if preview["expires_at"] <= utcnow().isoformat():
            raise HTTPException(409, "Aperçu expiré ; préparez une nouvelle demande.")
        if kind == "portfolio" and (await self.portfolio(uid))["revision"] != preview["base_revision"]:
            raise HTTPException(409, "Le portefeuille a changé ; préparez un nouvel aperçu.")
        if kind == "routine" and action["start_at"] <= utcnow().isoformat():
            raise HTTPException(409, "Le premier horaire est déjà passé ; préparez une nouvelle routine future.")
        result, _ = await insert_once(self.db, name, {
            **action, "id": target_id, "user_id": uid, "preview_id": identity,
            "created_at": utcnow().isoformat(),
            **({"revision": preview["base_revision"] + 1} if kind == "portfolio" else {}),
        })
        if result["preview_id"] != identity:
            raise HTTPException(409, "Les données ont changé ; préparez un nouvel aperçu.")
        await self.trace(uid, identity, "CONFIRMED", {"kind": kind, "summary": preview["summary"]})
        return {"state": "COMPLETED", "result": result, "replayed": False}

    async def trace(self, uid, identity, outcome, details):
        await insert_once(self.db, "sirius_finance_events", {
            "id": digest([identity, outcome])[:32], "user_id": uid, "step": "finance:" + identity,
            "outcome": outcome, "at": utcnow().isoformat(), **details,
        })

    async def analyses(self, symbols, period="1y"):
        async def one(symbol):
            try:
                async with asyncio.timeout(25):
                    return symbol, await self.reader(symbol, dict(STOCKS)[symbol], period)
            except (HTTPException, TimeoutError) as exc:
                if isinstance(exc, HTTPException) and exc.status_code != 503:
                    raise
                logger.warning("Financial source unavailable for %s", symbol)
                return symbol, None
        return dict(await asyncio.gather(*(one(symbol) for symbol in symbols)))

    async def valuation(self, uid):
        portfolio = await self.portfolio(uid)
        data = await self.analyses([p["symbol"] for p in portfolio["positions"]])
        positions, missing = [], []
        for position in portfolio["positions"]:
            source = data[position["symbol"]]
            if source is None or source["currency"] != position["currency"]:
                missing.append(position["symbol"])
                positions.append({**position, "value": None, "unrealized_pnl": None, "source": None})
                continue
            value = position["quantity"] * source["latest"]["close"]
            positions.append({**position, "value": value,
                              "unrealized_pnl": value - position["quantity"] * position["average_cost"],
                              "source": {key: source[key] for key in ("source", "source_url", "as_of", "fetched_at",
                                  "data_version", "calculation_version", "currency", "age_calendar_days")}})
        complete = bool(positions) and not missing
        total = sum(p["value"] for p in positions) if complete else None
        for position in positions:
            position["weight_pct"] = position["value"] / total * 100 if total else None
        dates = set.intersection(*(set(b["date"] for b in item["calculation_inputs"]["daily_bars"])
                                   for item in data.values() if item)) if complete else set()
        series = []
        if dates:
            prices = {symbol: {bar["date"]: bar["close"] for bar in item["calculation_inputs"]["daily_bars"]}
                      for symbol, item in data.items()}
            series = [{"date": day, "value": sum(p["quantity"] * prices[p["symbol"]][day] for p in positions)}
                      for day in sorted(dates)]
        returns = [math.log(b["value"] / a["value"]) for a, b in zip(series[-21:], series[-20:])] if len(series) >= 21 else []
        from statistics import stdev
        peak, drawdown = 0, 0
        for point in series:
            peak = max(peak, point["value"])
            drawdown = min(drawdown, (point["value"] / peak - 1) * 100)
        return {
            "portfolio": portfolio, "positions": positions, "currency": "USD", "missing": missing,
            "state": "COMPLETE" if complete else "PARTIAL" if positions else "EMPTY",
            "total_value": total, "unrealized_pnl": sum(p["unrealized_pnl"] for p in positions) if complete else None,
            "volatility_pct": stdev(returns) * math.sqrt(252) * 100 if returns else None,
            "max_drawdown_pct": drawdown if series else None, "series": series[-252:],
            "limitations": [
                "Positions déclarées, pas de connexion courtier. Coût moyen fourni par vous, frais à inclure.",
                "USD uniquement ; quatre actions du catalogue. Aucun gain réalisé, secteur, bêta ni change calculé.",
                "Historique théorique à quantités actuelles constantes sur les séances communes ; pas votre performance réelle.",
                "Prix différés hors dividendes. Total indisponible si une ligne manque ; dates de sources pouvant différer.",
            ],
        }

    async def overview(self, uid):
        async def items(name):
            rows = await self.db[name].find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(101)
            for row in rows[:100]:
                row["disabled"] = await self.disabled(uid, row["id"])
            return {"items": rows[:100], "truncated": len(rows) > 100}
        return {"alerts": await items("sirius_finance_alerts"), "routines": await items("sirius_finance_routines"),
                "events": await self.db.sirius_finance_events.find({"user_id": uid}, {"_id": 0})
                    .sort("at", -1).to_list(100),
                "notifications": await self.db.sirius_finance_notifications.find({"user_id": uid}, {"_id": 0})
                    .sort("created_at", -1).to_list(100)}

    async def notification(self, uid, identity, text, evidence):
        await insert_once(self.db, "sirius_finance_notifications", {
            "id": identity, "user_id": uid, "text": text, "evidence": evidence, "created_at": utcnow().isoformat(),
        })
        await self.trace(uid, identity, "COMPLETED", {"summary": text, "evidence": evidence})

    async def evaluate_alert(self, alert):
        data = (await self.analyses([alert["symbol"]]))[alert["symbol"]]
        if data is None:
            raise HTTPException(503, "Lecture de surveillance indisponible.")
        condition, threshold = alert["condition"], alert["threshold"]
        latest, triggered, observed = data["latest"], False, None
        if condition == "price_above":
            observed = latest["close"]
            triggered = observed >= threshold
        elif condition == "price_below":
            observed = latest["close"]
            triggered = observed <= threshold
        elif condition == "variation_above":
            observed = data["performance_pct"]["1d"]
            triggered = observed is not None and observed >= threshold
        else:
            pair = data["series"][-2:]
            if len(pair) == 2 and all(p["mm200"] is not None for p in pair):
                observed = latest["close"] - latest["mm200"]
                previous = pair[0]["close"] - pair[0]["mm200"]
                triggered = previous <= 0 < observed if condition == "cross_above_mm200" else previous >= 0 > observed
        if data["age_calendar_days"] > 7 or observed is None:
            raise HTTPException(503, "Surveillance non évaluée : historique trop ancien ou insuffisant.")
        evidence = {key: data[key] for key in ("source", "source_url", "as_of", "fetched_at", "currency",
                                             "data_version", "calculation_version", "calculation_parameters")}
        evidence.update({"condition": condition, "threshold": threshold, "observed": observed, "triggered": triggered})
        if condition.startswith("cross_"):
            evidence["crossing_inputs"] = data["series"][-2:]
        if triggered and not await self.disabled(alert["user_id"], alert["id"]):
            await self.notification(alert["user_id"], digest([alert["id"], data["as_of"]])[:32],
                                    f"{alert['symbol']} : {condition} détecté sur la séance {data['as_of']}.", evidence)
        return evidence

    async def tick(self, now=None):
        now = now or utcnow()
        batch = []
        for kind, name in (("alert", "sirius_finance_alerts"), ("routine", "sirius_finance_routines")):
            async for item in self.db[name].find({}):
                batch.append((kind, item, now))
                if len(batch) == 4:
                    await self._tick_batch(batch)
                    batch = []
        if batch:
            await self._tick_batch(batch)

    async def _tick_batch(self, batch):
        results = await asyncio.gather(*(self._tick_item(*args) for args in batch), return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result

    async def _tick_item(self, kind, item, now):
        # Configurations are immutable; suspension is a separate durable marker.
        uid = item["user_id"]
        user = await self.db.users.find_one({"user_id": uid})
        if not user or user.get("disabled") or await self.disabled(uid, item["id"]):
            return
        start = datetime.fromisoformat(item["start_at"]) if kind == "routine" else datetime.fromisoformat(item["created_at"])
        if start > now:
            return
        interval = {"once": None, "daily": 86400, "weekly": 604800}[item["recurrence"]] if kind == "routine" else 900
        slot = int((now - start).total_seconds() // interval) if interval else 0
        occurrence = digest([item["id"], slot])[:32]
        if await self.db.sirius_finance_occurrences.find_one({"user_id": uid, "id": occurrence}):
            return
        attempts = await self.db.sirius_finance_attempts.find({"user_id": uid, "occurrence": occurrence}).sort("number", -1).to_list(1)
        if attempts and datetime.fromisoformat(attempts[0]["created_at"]) > now - timedelta(seconds=90):
            return
        blocked_evidence = {"target_id": item["id"], "state": "BLOCKED",
                            **({"run_id": digest([uid, str(uuid.uuid5(uuid.NAMESPACE_URL, occurrence))])[:32]}
                               if kind == "routine" else {})}
        if attempts and attempts[0]["number"] >= 3:
            await self.notification(uid, occurrence, "Résultat PORTUS non vérifiable après trois tentatives ou interruption ; consultez NÉMÉSIS.",
                                    blocked_evidence)
            return
        attempt = attempts[0]["number"] + 1 if attempts else 1
        _, claimed = await insert_once(self.db, "sirius_finance_attempts", {
            "id": f"{occurrence}:{attempt}", "user_id": uid, "occurrence": occurrence,
            "number": attempt, "created_at": now.isoformat(),
        })
        if not claimed:
            return
        try:
            if kind == "alert":
                evidence = await self.evaluate_alert(item)
            else:
                body = MarketRunIn(request_id=uuid.uuid5(uuid.NAMESPACE_URL, occurrence),
                                   symbols=item["symbols"], period=item["period"],
                                   volatility_threshold_pct=item["volatility_threshold_pct"])
                result = await self.runs.create(uid, body)
                if result["state"] != "COMPLETED":
                    raise HTTPException(503, "Parcours partiel ; reprise des étapes manquantes requise.")
                evidence = {"run_id": result["id"], "state": result["state"],
                            "scheduled_at": (start + timedelta(seconds=slot * (interval or 0))).isoformat(), "slot": slot}
                await self.notification(uid, occurrence, "CHRONOS : bilan PORTUS disponible dans ARIANE.", evidence)
            await insert_once(self.db, "sirius_finance_occurrences", {
                "id": occurrence, "user_id": uid, "target_id": item["id"], "created_at": now.isoformat(), "evidence": evidence,
            })
        except (HTTPException, sqlite3.Error, PyMongoError) as exc:
            if isinstance(exc, HTTPException) and exc.status_code != 503:
                raise
            logger.warning("Financial scheduled read blocked: %s attempt %s", occurrence, attempt, exc_info=True)
            await self.trace(uid, f"{occurrence}:{attempt}", "BLOCKED",
                             {"summary": "Lecture impossible ; trois tentatives maximum espacées de 90 s."})
            if attempt == 3:
                await self.notification(uid, occurrence, "Lecture PORTUS impossible après trois tentatives ; consultez NÉMÉSIS.",
                                        blocked_evidence)

    async def loop(self):
        while True:
            try:
                await self.tick()
            except (sqlite3.Error, PyMongoError, HTTPException):
                logger.exception("Financial scheduler storage/source failure")
            await asyncio.sleep(60)

    async def preview_status(self, uid, identity):
        saved = await self.db.sirius_finance_previews.find_one({"user_id": uid, "id": identity}, {"_id": 0})
        if not saved:
            raise HTTPException(404, "Aperçu introuvable.")
        return saved


def make_finance_router(service, require_user):
    router = APIRouter(tags=["finance"])

    async def call(request, operation, *args):
        uid = (await require_user(request, service.db))["user_id"]
        try:
            return await operation(uid, *args)
        except (sqlite3.Error, PyMongoError) as exc:
            logger.exception("Financial workspace persistence unavailable")
            raise HTTPException(503, "Stockage financier indisponible ; réessayez la même référence, sans recréer de demande.") from exc

    @router.get("/nummarius/workspace")
    async def overview(request: Request):
        return await call(request, service.overview)

    @router.get("/nummarius/portfolio")
    async def portfolio(request: Request):
        return await call(request, service.valuation)

    @router.post("/nummarius/actions/preview")
    async def preview(body: PreviewIn, request: Request):
        return await call(request, service.preview, body)

    @router.post("/nummarius/portfolio/csv/preview")
    async def csv_preview(body: CsvIn, request: Request):
        await require_user(request, service.db)
        parsed = PreviewIn(request_id=body.request_id, action=parse_holdings_csv(body.text))
        return await call(request, service.preview, parsed)

    @router.post("/nummarius/actions/{identity}/confirm")
    async def confirm(identity: str, request: Request):
        return await call(request, service.confirm, identity)

    @router.get("/nummarius/actions/{identity}")
    async def preview_status(identity: str, request: Request):
        return await call(request, service.preview_status, identity)

    @router.get("/chronos/market-routines")
    async def routines(request: Request):
        result = await call(request, service.overview)
        return {"routines": result["routines"], "notifications": result["notifications"]}

    return router
