# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
"""Routes de la mémoire locale (facts SQLite) et de SIRIUS PRIME (journal d'apprentissage)."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from local_memory import add_fact, delete_fact, list_facts, log_event, prime_overview, update_fact


class LocalFactCreate(BaseModel):
    category: str = "souvenir"
    text: str


class LocalFactUpdate(BaseModel):
    text: str


class PrimeLog(BaseModel):
    text: str
    intent: str = ""


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

    @router.get("/prime/overview")
    async def prime_get_overview():
        return prime_overview()

    return router
