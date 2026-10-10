# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Routes des suggestions proactives (moteur proactive.py)."""

from fastapi import APIRouter, Request

import proactive
from briefing_news import fetch_briefing_news


def make_proactive_router(db, require_user):
    router = APIRouter(tags=["proactive"])

    @router.post("/suggestions/evaluate")
    async def suggestions_evaluate(request: Request):
        """Suggestions proactives issues de la mémoire réelle (projets, épisodes, habitudes)."""
        uid = (await require_user(request, db))["user_id"]
        news = await fetch_briefing_news()
        result = proactive.evaluate(uid, news_sections=news["sections"])
        result["news_status"] = "partial" if any(
            section["status"] == "unavailable" for section in news["sections"]
        ) else "ok"
        return result

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
