"""Account-scoped, bounded DAG execution over an explicit action registry."""

import asyncio
import logging
import math
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field, JsonValue, StrictBool
from pymongo.errors import PyMongoError

from action_registry import ActionContext, ActionInputs, ActionRegistry
from work_draft_recordings import digest, insert_once

logger = logging.getLogger(__name__)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class Reference(ActionInputs):
    step: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,39}$")
    path: list[str] = Field(min_length=1, max_length=8)


class Condition(ActionInputs):
    source: Reference
    operator: Literal["eq", "gt", "lt"]
    value: JsonValue


class PlanStep(ActionInputs):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,39}$")
    action: str = Field(max_length=100)
    inputs: dict[str, JsonValue] = Field(default_factory=dict)
    bindings: dict[str, Reference] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list, max_length=12)
    when: Condition | None = None


class RunIn(ActionInputs):
    request_id: uuid.UUID
    objective: str = Field(min_length=1, max_length=300)
    steps: list[PlanStep] = Field(min_length=1, max_length=12)


class ConfirmIn(ActionInputs):
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    confirm: StrictBool


def resolve(reference, completed):
    saved = completed.get(reference["step"])
    if not saved or saved["state"] != "COMPLETED":
        raise HTTPException(409, "Une source requise n'est pas terminée.")
    value = saved["output"]
    for key in reference["path"]:
        if not isinstance(value, dict) or key not in value:
            raise HTTPException(422, "Champ source absent ; aucune valeur par défaut inventée.")
        value = value[key]
    return value


def condition_matches(condition, completed):
    actual = resolve(condition["source"], completed)
    expected = condition["value"]
    if condition["operator"] == "eq":
        return type(actual) is type(expected) and actual == expected
    if (isinstance(actual, bool) or isinstance(expected, bool)
            or not isinstance(actual, (int, float)) or not isinstance(expected, (int, float))
            or not math.isfinite(actual) or not math.isfinite(expected)):
        raise HTTPException(422, "La condition numérique nécessite deux valeurs finies, pas une donnée absente.")
    return actual > expected if condition["operator"] == "gt" else actual < expected


class ActionRuns:
    def __init__(self, db, registry: ActionRegistry):
        self.db, self.registry = db, registry

    def validate_plan(self, body):
        steps = {step.id: step for step in body.steps}
        if len(steps) != len(body.steps):
            raise HTTPException(422, "Les identifiants d'étape doivent être distincts.")
        contracts = {}
        for step in body.steps:
            definition = self.registry.get(step.action)
            contracts[step.id] = definition.contract()
            if (len(set(step.depends_on)) != len(step.depends_on) or step.id in step.depends_on
                    or any(dep not in steps for dep in step.depends_on)):
                raise HTTPException(422, "Dépendances invalides.")
            references = list(step.bindings.values()) + ([step.when.source] if step.when else [])
            if any(ref.step not in step.depends_on for ref in references):
                raise HTTPException(422, "Toute source doit être une dépendance explicite.")
            for source in definition.sources:
                reference = step.bindings.get(source.input)
                if (not reference or steps[reference.step].action != source.action
                        or tuple(reference.path) != source.path):
                    raise HTTPException(422, "Cette entrée doit provenir du résultat authentifié de l'action source déclarée.")
            fields = definition.inputs.model_fields
            if (set(step.bindings) & set(step.inputs) or any(key not in fields for key in step.bindings)
                    or any(key not in fields for key in step.inputs)):
                raise HTTPException(422, "Entrées ou liaisons inconnues/dupliquées.")
            if not step.bindings:
                self.registry.validate_inputs(step.action, step.inputs)
            elif any(field.is_required() and name not in step.inputs and name not in step.bindings
                     for name, field in fields.items()):
                raise HTTPException(422, "Une entrée obligatoire n'est ni fournie ni liée.")
        visited = set()
        while len(visited) < len(steps):
            ready = {name for name, step in steps.items() if name not in visited and set(step.depends_on) <= visited}
            if not ready:
                raise HTTPException(422, "Cycle de dépendances interdit.")
            visited |= ready
        return contracts

    async def create(self, uid, body):
        contracts = self.validate_plan(body)
        plan = body.model_dump(mode="json", exclude={"request_id"})
        if len(str(plan).encode("utf-8")) > 100_000:
            raise HTTPException(422, "Plan limité à 100 ko.")
        stamp = datetime.now(timezone.utc)
        saved, _ = await insert_once(self.db, "sirius_action_runs", {
            "id": digest([uid, str(body.request_id)])[:32], "user_id": uid, "plan": plan, "contracts": contracts,
            "created_at": stamp.isoformat(), "expires_at": (stamp + timedelta(hours=24)).isoformat(),
        })
        if saved["plan"] != plan or saved["contracts"] != contracts:
            raise HTTPException(409, "Cette référence correspond à un autre plan ou une autre version d'action.")
        return await self.execute(uid, saved["id"])

    async def owned(self, uid, run_id):
        result = await self.db.sirius_action_runs.find_one({"user_id": uid, "id": run_id}, {"_id": 0})
        if not result:
            raise HTTPException(404, "Parcours commun introuvable.")
        return result

    async def item(self, uid, identity):
        return await self.db.sirius_action_steps.find_one({"user_id": uid, "id": identity}, {"_id": 0})

    async def completed(self, uid, run):
        saved = {}
        for step in run["plan"]["steps"]:
            result = await self.item(uid, f"{run['id']}:{step['id']}:result")
            if result:
                saved[step["id"]] = result
        return saved

    async def cancelled(self, uid, run_id):
        return bool(await self.db.sirius_action_controls.find_one({"user_id": uid, "id": f"{run_id}:cancel"}))

    async def event(self, uid, run_id, step, state, **data):
        await self.db.sirius_action_events.insert_one({
            "id": uuid.uuid4().hex, "user_id": uid, "run_id": run_id, "step": step,
            "state": state, "at": now_iso(), **data,
        })

    async def save_result(self, uid, run_id, step_id, state, output, **data):
        return await insert_once(self.db, "sirius_action_steps", {
            "id": f"{run_id}:{step_id}:result", "user_id": uid, "run_id": run_id,
            "step": step_id, "state": state, "output": output, "completed_at": now_iso(), **data,
        })

    def check_contracts(self, run):
        for step in run["plan"]["steps"]:
            if self.registry.get(step["action"]).contract() != run["contracts"][step["id"]]:
                raise HTTPException(409, "Le contrat d'une action a changé. Créez un nouveau parcours, sans reprise automatique.")

    async def execute(self, uid, run_id):
        run = await self.owned(uid, run_id)
        self.check_contracts(run)
        tried = set()
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and run["expires_at"] > now_iso() and not await self.cancelled(uid, run_id):
            completed = await self.completed(uid, run)
            ready = [step for step in run["plan"]["steps"] if step["id"] not in completed
                     and step["id"] not in tried and all(dep in completed for dep in step["depends_on"])]
            if not ready:
                break
            for index in range(0, len(ready), 4):
                if time.monotonic() >= deadline:
                    break
                batch = ready[index:index + 4]
                results = await asyncio.gather(*(self.perform(uid, run, step, completed) for step in batch),
                                               return_exceptions=True)
                tried.update(step["id"] for step in batch)
                for result in results:
                    if isinstance(result, BaseException):
                        raise result
        return await self.status(uid, run_id)

    async def perform(self, uid, run, step, completed):
        run_id, step_id = run["id"], step["id"]
        definition = self.registry.get(step["action"])
        if await self.item(uid, f"{run_id}:{step_id}:result"):
            return
        try:
            if any(completed[dep]["state"] == "SKIPPED" for dep in step["depends_on"]):
                await self.save_result(uid, run_id, step_id, "SKIPPED", None, reason="Dépendance ignorée.")
                return
            if step["when"] and not condition_matches(step["when"], completed):
                await self.save_result(uid, run_id, step_id, "SKIPPED", None, reason="Condition non satisfaite.")
                return
            values = dict(step["inputs"])
            values.update({key: resolve(ref, completed) for key, ref in step["bindings"].items()})
            values = self.registry.validate_inputs(step["action"], values)
        except HTTPException as exc:
            await self.event(uid, run_id, step_id, "BLOCKED", reason=exc.detail)
            return
        fingerprint = digest([run_id, step_id, run["contracts"][step_id], values])
        prepared, _ = await insert_once(self.db, "sirius_action_steps", {
            "id": f"{run_id}:{step_id}:prepared", "user_id": uid, "run_id": run_id, "step": step_id,
            "inputs": values, "fingerprint": fingerprint, "prepared_at": now_iso(),
        })
        if prepared["fingerprint"] != fingerprint:
            raise HTTPException(409, "Les entrées ont changé depuis l'aperçu.")
        if definition.confirmation_required:
            approval = await self.db.sirius_action_controls.find_one({
                "user_id": uid, "id": f"{run_id}:{step_id}:approved", "fingerprint": fingerprint,
            })
            if not approval:
                return
        attempts = await self.db.sirius_action_attempts.find({
            "user_id": uid, "run_id": run_id, "step": step_id,
        }, {"_id": 0}).sort("number", -1).to_list(1)
        if attempts:
            finish = await self.item(uid, attempts[0]["id"] + ":finished")
            if not finish and attempts[0]["lease_until"] > now_iso():
                return
            if attempts[0]["number"] >= definition.max_attempts:
                return
        number = attempts[0]["number"] + 1 if attempts else 1
        if await self.item(uid, f"{run_id}:{step_id}:result"):
            return
        attempt_id = f"{run_id}:{step_id}:{number}"
        _, claimed = await insert_once(self.db, "sirius_action_attempts", {
            "id": attempt_id, "user_id": uid, "run_id": run_id, "step": step_id, "number": number,
            "started_at": now_iso(), "lease_until": (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(),
        })
        if not claimed:
            return
        if await self.cancelled(uid, run_id) or run["expires_at"] <= now_iso():
            return
        started = time.monotonic()
        await self.event(uid, run_id, step_id, "RUNNING", attempt=number, action=step["action"])
        partial_output = None
        try:
            context = ActionContext(uid, run_id, step_id, digest([run_id, step_id]))
            async with asyncio.timeout(definition.timeout_seconds):
                output = await definition.handler(context, definition.inputs.model_validate(prepared["inputs"]))
            output = definition.output.model_validate(output).model_dump(mode="json")
            if output["completion"] == "PARTIAL":
                partial_output = output
                outcome, reason = "BLOCKED", " ".join(output["issues"]) or "Résultat partiel ; une reprise est nécessaire."
            else:
                await self.save_result(uid, run_id, step_id, "COMPLETED", output,
                                       input_fingerprint=fingerprint, duration_ms=round((time.monotonic() - started) * 1000))
                outcome, reason = "COMPLETED", None
        except (HTTPException, TimeoutError) as exc:
            outcome = "BLOCKED"
            reason = exc.detail if isinstance(exc, HTTPException) else "Délai dépassé ; résultat non confirmé, reprenez la même référence."
            logger.warning("ARIANE action %s blocked (%s)", step["action"], type(exc).__name__)
        except Exception:
            logger.exception("Unexpected ARIANE action failure: %s", step["action"])
            raise
        await insert_once(self.db, "sirius_action_steps", {
            "id": attempt_id + ":finished", "user_id": uid, "run_id": run_id, "step": step_id,
            "state": outcome, "reason": reason, "partial_output": partial_output, "finished_at": now_iso(),
        })
        await self.event(uid, run_id, step_id, outcome, reason=reason, attempt=number)

    async def confirm(self, uid, run_id, step_id, body):
        run = await self.owned(uid, run_id)
        self.check_contracts(run)
        if not body.confirm or await self.cancelled(uid, run_id) or run["expires_at"] <= now_iso():
            raise HTTPException(409, "Confirmation refusée : parcours expiré, arrêté ou accord absent.")
        step = next((step for step in run["plan"]["steps"] if step["id"] == step_id), None)
        if not step or not self.registry.get(step["action"]).confirmation_required:
            raise HTTPException(422, "Cette étape n'attend pas de confirmation.")
        prepared = await self.item(uid, f"{run_id}:{step_id}:prepared")
        if not prepared or prepared["fingerprint"] != body.fingerprint:
            raise HTTPException(409, "Relisez l'aperçu exact avant confirmation.")
        await insert_once(self.db, "sirius_action_controls", {
            "id": f"{run_id}:{step_id}:approved", "user_id": uid, "run_id": run_id, "step": step_id,
            "fingerprint": body.fingerprint, "confirmed_at": now_iso(),
        })
        return await self.execute(uid, run_id)

    async def cancel(self, uid, run_id):
        await self.owned(uid, run_id)
        await insert_once(self.db, "sirius_action_controls", {
            "id": f"{run_id}:cancel", "user_id": uid, "run_id": run_id, "cancelled_at": now_iso(),
        })
        return await self.status(uid, run_id)

    async def status(self, uid, run_id):
        run = await self.owned(uid, run_id)
        completed = await self.completed(uid, run)
        steps = []
        events = await self.db.sirius_action_events.find({"user_id": uid, "run_id": run_id}, {"_id": 0}).sort("at", -1).to_list(101)
        for step in run["plan"]["steps"]:
            step_id = step["id"]
            saved = completed.get(step_id)
            prepared = await self.item(uid, f"{run_id}:{step_id}:prepared")
            approval = await self.db.sirius_action_controls.find_one({"user_id": uid, "id": f"{run_id}:{step_id}:approved"}, {"_id": 0})
            attempts = await self.db.sirius_action_attempts.find({"user_id": uid, "run_id": run_id, "step": step_id},
                                                               {"_id": 0}).sort("number", -1).to_list(1)
            finished = await self.item(uid, attempts[0]["id"] + ":finished") if attempts else None
            state = (saved["state"] if saved else "RUNNING" if attempts and not finished and attempts[0]["lease_until"] > now_iso()
                     else "BLOCKED" if attempts else "WAITING_CONFIRMATION"
                     if prepared and run["contracts"][step_id]["confirmation_required"] and not approval else "PENDING")
            latest = next((event for event in events if event["step"] == step_id), None)
            if state == "PENDING" and latest and latest["state"] == "BLOCKED":
                state = "BLOCKED"
            reason = (saved.get("reason") if saved else finished.get("reason") if finished
                      else latest.get("reason") if latest else None)
            if attempts and not finished and not saved:
                reason = ("Tentative encore engagée ; une réponse perdue ne signifie pas absence d'effet."
                          if state == "RUNNING" else
                          "Tentative interrompue sans résultat vérifiable. Consultez les preuves puis reprenez la même référence.")
            if attempts and not saved and attempts[0]["number"] >= run["contracts"][step_id]["max_attempts"]:
                reason = (reason or "Résultat non confirmé.") + " Limite de tentatives atteinte ; vérifiez la source et ses traces avant toute nouvelle action."
            steps.append({**step, "state": state, "output": saved["output"] if saved else finished.get("partial_output") if finished else None,
                          "completed_at": saved.get("completed_at") if saved else None,
                          "duration_ms": saved.get("duration_ms") if saved else None,
                          "prepared": prepared, "approved": bool(approval), "approval": approval,
                          "attempts": attempts[0]["number"] if attempts else 0,
                          "attempt_limit": run["contracts"][step_id]["max_attempts"],
                          "retry_after": attempts[0]["lease_until"] if attempts and not finished and not saved else None,
                          "reason": reason})
        all_done = all(step["state"] in ("COMPLETED", "SKIPPED") for step in steps)
        cancellation = await self.db.sirius_action_controls.find_one({"user_id": uid, "id": f"{run_id}:cancel"}, {"_id": 0})
        state = ("COMPLETED" if all_done else "CANCELLED" if cancellation
                 else "EXPIRED" if run["expires_at"] <= now_iso() else "WAITING_CONFIRMATION"
                 if any(step["state"] == "WAITING_CONFIRMATION" for step in steps) else "BLOCKED"
                 if any(step["state"] == "BLOCKED" for step in steps) else "RUNNING"
                 if any(step["state"] == "RUNNING" for step in steps) else "PENDING")
        return {**run, "state": state, "steps": steps, "events": list(reversed(events[:100])),
                "events_truncated": len(events) > 100, "cancellation": cancellation,
                "summary": {name: sum(step["state"] == name for step in steps)
                            for name in ("COMPLETED", "SKIPPED", "BLOCKED", "WAITING_CONFIRMATION", "PENDING", "RUNNING")}}

    async def listing(self, uid):
        runs = await self.db.sirius_action_runs.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(21)
        return {"items": [{"id": item["id"], "objective": item["plan"]["objective"], "created_at": item["created_at"]}
                          for item in runs[:20]], "truncated": len(runs) > 20}


def make_action_router(service, require_user):
    router = APIRouter(prefix="/ariane", tags=["ariane-actions"])

    async def call(request, operation, *args):
        user = await require_user(request, service.db)
        try:
            return await operation(user["user_id"], *args)
        except (sqlite3.Error, PyMongoError) as exc:
            logger.exception("ARIANE shared action persistence unavailable")
            raise HTTPException(503, "Journal ARIANE indisponible. Résultat potentiellement partiel ; reprenez la même référence.") from exc

    @router.get("/actions")
    async def catalog(request: Request):
        await require_user(request, service.db)
        return {"actions": service.registry.catalog()}

    @router.post("/runs")
    async def create(body: RunIn, request: Request):
        return await call(request, service.create, body)

    @router.get("/runs")
    async def listing(request: Request):
        return await call(request, service.listing)

    @router.get("/runs/{run_id}")
    async def status(run_id: str, request: Request):
        return await call(request, service.status, run_id)

    @router.post("/runs/{run_id}/resume")
    async def resume(run_id: str, request: Request):
        return await call(request, service.execute, run_id)

    @router.post("/runs/{run_id}/steps/{step_id}/confirm")
    async def confirm(run_id: str, step_id: str, body: ConfirmIn, request: Request):
        return await call(request, service.confirm, run_id, step_id, body)

    @router.post("/runs/{run_id}/cancel")
    async def cancel(run_id: str, request: Request):
        return await call(request, service.cancel, run_id)

    return router
