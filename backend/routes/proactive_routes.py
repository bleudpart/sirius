# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
"""Routes des suggestions proactives (moteur proactive.py)."""

from fastapi import APIRouter, Request

import proactive


def make_proactive_router(db, require_user):
    router = APIRouter(tags=["proactive"])

    @router.post("/suggestions/evaluate")
    async def suggestions_evaluate(request: Request):
        """Suggestions proactives issues de la mémoire réelle (projets, épisodes, habitudes)."""
        uid = (await require_user(request, db))["user_id"]
        return proactive.evaluate(uid)

    @router.post("/suggestions/settings")
    async def suggestions_settings(payload: dict, request: Request):
        uid = (await require_user(request, db))["user_id"]
        mode = ((payload or {}).get("settings") or {}).get("mode") or "equilibre"
        return {"mode": proactive.set_mode(uid, mode)}

    @router.get("/suggestions/{suggestion_id}/why")
    async def suggestions_why(suggestion_id: str, request: Request):
        uid = (await require_user(request, db))["user_id"]
        return proactive.suggestion_why(uid, suggestion_id)

    @router.post("/suggestions/{suggestion_id}/action")
    async def suggestions_action(suggestion_id: str, payload: dict, request: Request):
        uid = (await require_user(request, db))["user_id"]
        action = (payload or {}).get("action") or ""
        return proactive.suggestion_action(uid, suggestion_id, action)

    return router
