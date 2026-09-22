# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Routes de la mémoire locale (facts SQLite) et de ΣIRIUS PRIME (journal d'apprentissage)."""

from datetime import datetime, timedelta
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from local_memory import (
    add_fact, delete_fact, list_facts, list_work_interventions, log_event,
    log_work_intervention, prime_overview, update_fact, update_work_intervention,
)
from runtime_paths import data_file
from sirius_doctor import DoctorError, create_backup, verify_backup


class LocalFactCreate(BaseModel):
    category: str = "souvenir"
    text: str


class LocalFactUpdate(BaseModel):
    text: str


class PrimeLog(BaseModel):
    text: str
    intent: str = ""


class WorkLogCreate(BaseModel):
    id: str = ""
    title: str
    project: str = ""
    task_type: str = ""
    status: str = "running"
    result: str = ""


class WorkLogUpdate(BaseModel):
    status: str
    result: str = ""


class WorkLogQuery(BaseModel):
    query: str


def _work_log_query_filters(query: str) -> tuple[str, str]:
    """Extract a local-date or project filter from common French history requests."""
    normalized = " ".join((query or "").lower().split())
    today = datetime.now().astimezone().date()
    if "hier" in normalized:
        return (today - timedelta(days=1)).isoformat(), ""
    if "aujourd" in normalized:
        return today.isoformat(), ""
    weekdays = {
        "lundi": 0, "mardi": 1, "mercredi": 2, "jeudi": 3,
        "vendredi": 4, "samedi": 5, "dimanche": 6,
    }
    for name, weekday in weekdays.items():
        if re.search(rf"\b{name}\b", normalized):
            delta = (today.weekday() - weekday) % 7 or 7
            return (today - timedelta(days=delta)).isoformat(), ""
    project_match = re.search(r"(?:sur|projet|dossier)\s+([\wÀ-ÿ][\wÀ-ÿ .'-]{1,80})", query or "", re.IGNORECASE)
    return "", project_match.group(1).strip(" .?!") if project_match else ""


def make_memory_router(db, require_user, resolve_user_id):
    router = APIRouter(tags=["memory"])

    @router.get("/local-memory")
    async def local_memory_list(request: Request, category: str = ""):
        user = await require_user(request, db)
        return {"facts": list_facts(category or None, user_id=user["user_id"])}

    @router.post("/local-memory")
    async def local_memory_add(req: LocalFactCreate, request: Request):
        user = await require_user(request, db)
        fact = add_fact(req.category, req.text, user_id=user["user_id"])
        if not fact:
            raise HTTPException(status_code=409, detail="Ce fait existe déjà ou est vide")
        return fact

    @router.delete("/local-memory/{fact_id}")
    async def local_memory_delete(fact_id: str, request: Request):
        user = await require_user(request, db)
        if not delete_fact(fact_id, user_id=user["user_id"]):
            raise HTTPException(status_code=404, detail="Fait introuvable")
        return {"ok": True}

    @router.put("/local-memory/{fact_id}")
    async def local_memory_update(fact_id: str, req: LocalFactUpdate, request: Request):
        user = await require_user(request, db)
        if not update_fact(fact_id, req.text, user_id=user["user_id"]):
            raise HTTPException(status_code=404, detail="Fait introuvable ou texte vide")
        return {"ok": True}

    @router.post("/prime/log")
    async def prime_log(req: PrimeLog, request: Request):
        uid = await resolve_user_id(request, db)
        log_event(req.text, req.intent, user_id=uid)
        return {"ok": True}

    @router.get("/work-log")
    async def work_log_list(request: Request, date: str = "", project: str = "", limit: int = 100):
        user = await require_user(request, db)
        return {
            "interventions": list_work_interventions(
                user_id=user["user_id"], date_key=date[:10], project=project[:160], limit=limit,
            )
        }

    @router.post("/work-log/query")
    async def work_log_query(req: WorkLogQuery, request: Request):
        user = await require_user(request, db)
        date_key, project = _work_log_query_filters(req.query)
        interventions = list_work_interventions(
            user_id=user["user_id"], date_key=date_key, project=project, limit=100,
        )
        return {"query": req.query, "date": date_key or None, "project": project or None, "interventions": interventions}

    @router.post("/work-log")
    async def work_log_create(req: WorkLogCreate, request: Request):
        user = await require_user(request, db)
        intervention = log_work_intervention(
            title=req.title, task_type=req.task_type, project=req.project, status=req.status,
            result=req.result, user_id=user["user_id"], entry_id=req.id or None,
        )
        if not intervention:
            raise HTTPException(status_code=422, detail="Titre d'intervention manquant")
        return intervention

    @router.patch("/work-log/{entry_id}")
    async def work_log_update(entry_id: str, req: WorkLogUpdate, request: Request):
        user = await require_user(request, db)
        if not update_work_intervention(entry_id, req.status, req.result, user_id=user["user_id"]):
            raise HTTPException(status_code=404, detail="Intervention introuvable")
        return {"ok": True}

    @router.post("/backup")
    async def backup_local_data(request: Request):
        await require_user(request, db)
        try:
            return create_backup(
                database_path=data_file("sirius_local.db"),
                backup_directory=data_file("backups") / "sirius",
            ).to_dict()
        except DoctorError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @router.get("/backup/verify")
    async def backup_verify(request: Request, backup: str):
        await require_user(request, db)
        backup_path = data_file("backups") / "sirius" / backup.split("/")[-1].split("\\")[-1]
        return verify_backup(backup_path).to_dict()

    @router.get("/prime/overview")
    async def prime_get_overview():
        return prime_overview()

    return router
