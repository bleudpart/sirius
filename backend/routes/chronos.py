"""Authenticated Chronos event CRUD endpoints.

POST /events optionally accepts Idempotency-Key, a 36-character hyphenated UUID.
Successful replays return the original response body and the same 201 status.
"""

import logging
import sqlite3
from datetime import date
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Header, HTTPException, Query, Request
from chronos_store import ChronosStore
from chronos_store import EventIn as EventIn, EventUpdateIn as EventUpdateIn


logger = logging.getLogger(__name__)

def make_chronos_router(require_user, db, store: ChronosStore | None = None) -> APIRouter:
    router = APIRouter(prefix="/chronos", tags=["chronos"])
    chronos_store = store or ChronosStore()

    async def user_id_for(request: Request) -> str:
        user = await require_user(request, db)
        user_id = user.get("user_id") if isinstance(user, dict) else None
        if not isinstance(user_id, str) or not user_id:
            raise HTTPException(status_code=401, detail="Authentication required.")
        return user_id

    def call_store(method, *args, **kwargs):
        try:
            return method(*args, **kwargs)
        except (OSError, sqlite3.Error) as error:
            logger.exception("Chronos SQLite storage operation failed.")
            raise HTTPException(
                status_code=503, detail="Chronos storage is unavailable."
            ) from error

    @router.get("/events")
    async def list_events(
        request: Request,
        on: date,
        timezone_name: Annotated[str, Query(alias="timezone", min_length=1, max_length=100)],
    ):
        user_id = await user_id_for(request)
        try:
            ZoneInfo(timezone_name)
        except (ValueError, ZoneInfoNotFoundError) as error:
            raise HTTPException(status_code=422, detail="A valid IANA timezone is required.") from error
        return call_store(chronos_store.list_events, user_id, on, timezone_name)

    @router.post("/events", status_code=201)
    async def create_event(
        payload: EventIn,
        request: Request,
        idempotency_key: Annotated[
            str | None, Header(alias="Idempotency-Key", min_length=36, max_length=36)
        ] = None,
    ):
        return call_store(
            chronos_store.create_event,
            await user_id_for(request),
            payload.model_dump(),
            idempotency_key=idempotency_key,
        )

    @router.put("/events/{event_id}")
    async def update_event(event_id: str, payload: EventUpdateIn, request: Request):
        return call_store(
            chronos_store.update_event,
            await user_id_for(request),
            event_id,
            payload.model_dump(),
        )

    @router.delete("/events/{event_id}")
    async def delete_event(
        event_id: str,
        request: Request,
        revision: Annotated[int, Query(ge=1)],
    ):
        return call_store(
            chronos_store.delete_event,
            await user_id_for(request),
            event_id,
            revision,
        )

    return router
