# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
"""Feedback léger : thumbs up/down sur les réponses SIRIUS."""

import logging
import sqlite3
import time
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)

_DB_PATH = Path(__file__).parent.parent / "sirius_feedback.db"


def _get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS quality_ratings (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id   TEXT    NOT NULL,
            rating    TEXT    NOT NULL CHECK(rating IN ('up','down')),
            context   TEXT    DEFAULT '',
            ts        REAL    NOT NULL
        )
    """)
    conn.commit()
    return conn


class FeedbackRequest(BaseModel):
    item_id: str
    rating: str          # "up" | "down"
    context: str = ""    # short excerpt of the answer (≤300 chars)


def make_feedback_router() -> APIRouter:
    router = APIRouter(tags=["feedback"])

    @router.post("/feedback")
    async def post_feedback(req: FeedbackRequest):
        if req.rating not in ("up", "down"):
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail="rating must be 'up' or 'down'")
        try:
            conn = _get_db()
            conn.execute(
                "INSERT INTO quality_ratings (item_id, rating, context, ts) VALUES (?,?,?,?)",
                (req.item_id[:64], req.rating, req.context[:300], time.time()),
            )
            conn.commit()
            conn.close()
        except Exception as e:
            logger.error("[FEEDBACK] %s", e)
            from fastapi import HTTPException
            raise HTTPException(status_code=500, detail="Feedback non enregistré")
        return {"ok": True}

    @router.get("/feedback/stats")
    async def get_feedback_stats():
        try:
            conn = _get_db()
            rows = conn.execute(
                "SELECT rating, COUNT(*) AS n FROM quality_ratings GROUP BY rating"
            ).fetchall()
            conn.close()
            return {r[0]: r[1] for r in rows}
        except Exception as e:
            logger.error("[FEEDBACK] stats: %s", e)
            return {}

    return router
