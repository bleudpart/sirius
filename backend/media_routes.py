"""Routes FastAPI et WebSocket du module multimedia SIRIUS."""

import os
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, ValidationError

from auth_api import LEGACY_UID, require_user
from media_archive import MediaArchive
from media_oracle import build_media_oracle
from media_proxy import MediaProxy
from providers.base import MediaProviderError


class MediaResolveRequest(BaseModel):
    provider: str = Field(min_length=2, max_length=32)
    query: str = Field(default="", max_length=240)
    url: str = Field(default="", max_length=2048)


class MediaControlRequest(BaseModel):
    action: str = Field(min_length=2, max_length=32)
    position_seconds: float | None = Field(default=None, ge=0, le=172800)


class MediaStateError(ValueError):
    """La commande necessite un media actif."""


class MediaSessionManager:
    """Etat en memoire, synchronise par utilisateur et archive localement."""

    _ACTIONS = {"play", "pause", "stop", "seek", "open", "close", "toggle"}

    def __init__(self, proxy: MediaProxy | None = None, archive: MediaArchive | None = None):
        self.proxy = proxy or MediaProxy()
        self.archive = archive or MediaArchive()
        self._states: dict[str, dict] = {}
        self._connections: dict[str, set[WebSocket]] = {}

    @staticmethod
    def _idle_state() -> dict:
        return {
            "provider": "",
            "title": "",
            "kind": "",
            "query": "",
            "status": "idle",
            "embeddable": False,
            "controllable": False,
            "embed_url": None,
            "external_url": "",
            "message": "",
            "position_seconds": 0,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    def state_for(self, user_id: str) -> dict:
        return dict(self._states.get(user_id, self._idle_state()))

    async def resolve(
        self,
        user_id: str,
        provider: str,
        query: str = "",
        url: str = "",
        parent_host: str = "localhost",
    ) -> dict:
        descriptor = self.proxy.resolve(provider, query=query, url=url, parent_host=parent_host)
        state = {
            **descriptor.as_dict(),
            "query": query.strip()[:240],
            "status": "ready",
            "position_seconds": 0,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        self._states[user_id] = state
        self.archive.record(user_id, "resolve", state)
        await self._broadcast(user_id, state)
        return dict(state)

    async def control(self, user_id: str, request: MediaControlRequest) -> dict:
        action = request.action.lower().strip()
        if action not in self._ACTIONS:
            raise MediaStateError("Commande multimedia non prise en charge.")

        state = self.state_for(user_id)
        if not state["provider"] and action != "close":
            raise MediaStateError("Aucun media n'est selectionne.")
        if action in {"play", "pause", "stop", "seek", "toggle"} and not state.get("controllable"):
            raise MediaStateError("Ce media utilise les controles officiels de sa plateforme.")

        status_for_action = {
            "play": "playing",
            "pause": "paused",
            "stop": "stopped",
            "open": "ready",
            "close": "closed",
        }
        if action == "toggle":
            state["status"] = "paused" if state["status"] == "playing" else "playing"
        elif action in status_for_action:
            state["status"] = status_for_action[action]
        if request.position_seconds is not None:
            state["position_seconds"] = request.position_seconds
        state["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._states[user_id] = state
        self.archive.record(user_id, action, state)
        await self._broadcast(user_id, state)
        return dict(state)

    async def connect(self, user_id: str, websocket: WebSocket) -> None:
        self._connections.setdefault(user_id, set()).add(websocket)
        await websocket.send_json({"type": "media_state", "state": self.state_for(user_id)})

    def disconnect(self, user_id: str, websocket: WebSocket) -> None:
        connections = self._connections.get(user_id)
        if not connections:
            return
        connections.discard(websocket)
        if not connections:
            self._connections.pop(user_id, None)

    async def _broadcast(self, user_id: str, state: dict) -> None:
        disconnected: list[WebSocket] = []
        for websocket in list(self._connections.get(user_id, set())):
            try:
                await websocket.send_json({"type": "media_state", "state": state})
            except (RuntimeError, WebSocketDisconnect):
                disconnected.append(websocket)
        for websocket in disconnected:
            self.disconnect(user_id, websocket)


def _embed_parent(request: Request) -> str:
    configured = (os.getenv("MEDIA_EMBED_PARENT") or "").strip().lower().rstrip(".")
    if configured and re.fullmatch(r"(?:localhost|[a-z0-9][a-z0-9.-]{0,252})", configured):
        return configured

    origin = request.headers.get("origin") or ""
    hostname = (urlsplit(origin).hostname or "").lower().rstrip(".")
    if hostname and re.fullmatch(r"(?:localhost|[a-z0-9][a-z0-9.-]{0,252})", hostname):
        return hostname
    return "localhost"


def make_media_router(db, manager: MediaSessionManager | None = None) -> APIRouter:
    router = APIRouter(prefix="/media", tags=["media"])
    sessions = manager or MediaSessionManager()

    async def user_id_for(request: Request) -> str:
        return (await require_user(request, db))["user_id"]

    @router.get("/providers")
    async def providers(request: Request):
        await user_id_for(request)
        return {"providers": sessions.proxy.providers()}

    @router.get("/state")
    async def state(request: Request):
        return {"state": sessions.state_for(await user_id_for(request))}

    @router.post("/resolve")
    async def resolve_media(payload: MediaResolveRequest, request: Request):
        user_id = await user_id_for(request)
        try:
            state = await sessions.resolve(
                user_id,
                provider=payload.provider,
                query=payload.query,
                url=payload.url,
                parent_host=_embed_parent(request),
            )
        except MediaProviderError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return {"state": state}

    @router.post("/control")
    async def control_media(payload: MediaControlRequest, request: Request):
        try:
            state = await sessions.control(await user_id_for(request), payload)
        except MediaStateError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        return {"state": state}

    @router.get("/archive")
    async def archive(request: Request, limit: int = 50):
        user_id = await user_id_for(request)
        return {"events": sessions.archive.list(user_id, limit)}

    @router.get("/oracle")
    async def oracle(request: Request):
        user_id = await user_id_for(request)
        state = sessions.state_for(user_id)
        return build_media_oracle(state, sessions.archive.list(user_id, limit=10))

    @router.websocket("/ws")
    async def media_websocket(websocket: WebSocket):
        await websocket.accept()
        user_id = LEGACY_UID
        await sessions.connect(user_id, websocket)
        try:
            while True:
                payload = await websocket.receive_json()
                message_type = payload.get("type") if isinstance(payload, dict) else ""
                request_id = payload.get("request_id") if isinstance(payload, dict) else None
                if message_type == "ping":
                    await websocket.send_json({"type": "media_pong", "request_id": request_id})
                    continue
                if message_type != "media_control":
                    await websocket.send_json(
                        {
                            "type": "media_error",
                            "request_id": request_id,
                            "detail": "Message multimedia non pris en charge.",
                        }
                    )
                    continue
                try:
                    control = MediaControlRequest.model_validate(payload.get("control") or {})
                    state = await sessions.control(user_id, control)
                except (ValidationError, MediaStateError) as error:
                    await websocket.send_json(
                        {"type": "media_error", "request_id": request_id, "detail": str(error)}
                    )
                    continue
                await websocket.send_json(
                    {"type": "media_ack", "request_id": request_id, "state": state}
                )
        except WebSocketDisconnect:
            return
        finally:
            sessions.disconnect(user_id, websocket)

    return router
