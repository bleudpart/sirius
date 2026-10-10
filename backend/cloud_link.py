# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Relais « ΣIRIUS Cloud » pour le serveur local d'un PC.

Un PC fraîchement installé n'a aucune clé d'IA. Plutôt que d'exiger des clés Groq/Google,
l'utilisateur relie son compte ΣIRIUS : le serveur local transmet alors le chat, la
transcription et la voix au serveur public (soumis aux quotas du compte).
La session Cloud (jetons d'accès et de rafraîchissement) est conservée dans le dossier
de données de l'utilisateur, jamais dans le code source.
"""

import json
import logging
import os
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from runtime_paths import data_file, write_json_atomic

logger = logging.getLogger(__name__)

_STATE_FILE = "cloud_link.json"
_LOCAL_BRAIN_ENV = ("GROQ_KEY", "GROQ_API_KEY", "K3_API_KEY", "DANIEL_DEV_K3")
_TIMEOUT = httpx.Timeout(90.0, connect=15.0)

# Remplaçable dans les tests (httpx.MockTransport).
transport: httpx.AsyncBaseTransport | None = None


def cloud_url() -> str:
    return (os.getenv("SIRIUS_CLOUD_URL") or "https://api.sirius-assistant.fr").strip().rstrip("/")


def relay_allowed() -> bool:
    """Seul un serveur local (PC) relaie ; le serveur public ne se relaie jamais vers lui-même."""
    flag = (os.getenv("SIRIUS_CLOUD_RELAY") or "").strip().lower()
    if flag in {"0", "off", "false"}:
        return False
    return flag in {"1", "on", "true"} or os.getenv("SIRIUS_PACKAGED", "").strip() == "1"


def _env_has(*names: str) -> bool:
    return any((os.getenv(name) or "").strip() for name in names)


def load_state() -> dict:
    try:
        data = json.loads(data_file(_STATE_FILE).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_state(state: dict) -> None:
    write_json_atomic(data_file(_STATE_FILE), state)


def clear_state() -> None:
    try:
        data_file(_STATE_FILE).unlink()
    except FileNotFoundError:
        pass


def linked() -> bool:
    return bool(load_state().get("access_token"))


def should_relay_chat(keys: dict | None) -> bool:
    keys = keys or {}
    user_key = str(keys.get("groq_key") or keys.get("groq_real") or keys.get("k3") or keys.get("groq") or "").strip()
    return relay_allowed() and not user_key and not _env_has(*_LOCAL_BRAIN_ENV) and linked()


def should_relay_stt(user_key: str | None) -> bool:
    return (
        relay_allowed()
        and not (user_key or "").strip()
        and not _env_has("GROQ_KEY", "GROQ_API_KEY", "WHISPER_API_URL", "STT_BACKEND_URL")
        and linked()
    )


def should_relay_tts(env_name: str) -> bool:
    return relay_allowed() and not _env_has(env_name) and linked()


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=cloud_url(), timeout=_TIMEOUT, transport=transport)


def _detail(response: httpx.Response, fallback: str) -> str:
    try:
        detail = response.json().get("detail")
    except ValueError:
        detail = None
    return detail if isinstance(detail, str) and detail else fallback


def _store_session(payload: dict, response: httpx.Response, previous: dict | None = None) -> dict:
    previous = previous or {}
    state = {
        "email": payload.get("email") or previous.get("email") or "",
        "name": payload.get("name") or previous.get("name") or "",
        "access_token": payload.get("access_token") or response.cookies.get("access_token") or "",
        "refresh_token": response.cookies.get("refresh_token") or previous.get("refresh_token") or "",
        "linked_at": previous.get("linked_at") or datetime.now(timezone.utc).isoformat(),
    }
    if not state["access_token"]:
        raise HTTPException(status_code=502, detail="ΣIRIUS Cloud n'a pas renvoyé de session.")
    _save_state(state)
    return state


async def _refresh(state: dict) -> dict | None:
    token = state.get("refresh_token")
    if not token:
        return None
    try:
        async with _client() as cx:
            r = await cx.post("/api/auth/refresh", headers={"Cookie": f"refresh_token={token}"})
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        if r.status_code == 401:
            clear_state()
        return None
    return _store_session(r.json(), r, state)


async def _send(method: str, path: str, **kwargs) -> httpx.Response:
    state = load_state()
    if not state.get("access_token"):
        raise HTTPException(status_code=401, detail="Compte ΣIRIUS Cloud non relié.")
    for attempt in range(2):
        headers = {**kwargs.pop("headers", {}), "Authorization": f"Bearer {state['access_token']}"}
        try:
            async with _client() as cx:
                response = await cx.request(method, path, headers=headers, **kwargs)
        except httpx.HTTPError as error:
            logger.warning("[CLOUD] %s injoignable : %s", path, error)
            raise HTTPException(status_code=502, detail="ΣIRIUS Cloud est injoignable. Vérifiez la connexion Internet.") from error
        if response.status_code != 401 or attempt:
            return response
        refreshed = await _refresh(state)
        if not refreshed:
            return response
        state = refreshed
        kwargs["headers"] = {k: v for k, v in headers.items() if k != "Authorization"}
    return response


async def relay_json(path: str, payload: dict) -> dict:
    response = await _send("POST", path, json=payload)
    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail=_detail(response, "ΣIRIUS Cloud a refusé la requête."))
    return response.json()


async def relay_get_json(path: str) -> dict:
    response = await _send("GET", path)
    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail=_detail(response, "ΣIRIUS Cloud a refusé la requête."))
    try:
        data = response.json()
    except ValueError as error:
        raise HTTPException(status_code=502, detail="Réponse ΣIRIUS Cloud illisible.") from error
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="Réponse ΣIRIUS Cloud illisible.")
    return data


async def relay_stt(filename: str, data: bytes, content_type: str) -> dict:
    response = await _send("POST", "/api/stt", files={"file": (filename, data, content_type)})
    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail=_detail(response, "Transcription Cloud indisponible."))
    return response.json()


async def relay_stream(path: str, payload: dict):
    """Relaie un flux SSE ; en cas d'échec, renvoie un événement « done » lisible par le HUD."""
    state = load_state()
    for attempt in range(2):
        headers = {"Authorization": f"Bearer {state.get('access_token', '')}", "Accept": "text/event-stream"}
        try:
            async with _client() as cx:
                async with cx.stream("POST", path, json=payload, headers=headers) as response:
                    if response.status_code == 401 and not attempt:
                        refreshed = await _refresh(state)
                        if refreshed:
                            state = refreshed
                            continue
                    if response.status_code != 200:
                        await response.aread()
                        message = _detail(response, "ΣIRIUS Cloud a refusé la requête.")
                        break
                    async for chunk in response.aiter_bytes():
                        yield chunk
                    return
        except httpx.HTTPError as error:
            logger.warning("[CLOUD] flux %s interrompu : %s", path, error)
            message = "ΣIRIUS Cloud est injoignable. Vérifiez la connexion Internet."
            break
    else:
        message = "Session ΣIRIUS Cloud expirée : reconnectez votre compte."
    event = {"type": "done", "answer": message, "used_search": False, "memories": [], "popups": []}
    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")


class CloudLinkRequest(BaseModel):
    email: str
    password: str
    code: str = ""
    name: str = ""


def _public_status() -> dict:
    state = load_state()
    return {
        "available": relay_allowed(),
        "linked": bool(state.get("access_token")),
        "email": state.get("email") or "",
        "name": state.get("name") or "",
        "cloud_url": cloud_url(),
        "local_brain": _env_has(*_LOCAL_BRAIN_ENV),
    }


def make_cloud_link_router(require_user, db, is_direct_local_request):
    router = APIRouter(prefix="/cloud", tags=["cloud"])

    async def _guard(request: Request):
        if not relay_allowed():
            raise HTTPException(status_code=404, detail="Relais Cloud indisponible sur ce serveur.")
        if not is_direct_local_request(request):
            raise HTTPException(status_code=403, detail="Liaison Cloud réservée à la machine locale.")
        await require_user(request, db)

    async def _authenticate(path: str, data: CloudLinkRequest) -> dict:
        body = {"email": data.email, "password": data.password, "code": data.code}
        if path.endswith("register"):
            body["name"] = data.name
        try:
            async with _client() as cx:
                r = await cx.post(path, json=body)
        except httpx.HTTPError as error:
            raise HTTPException(status_code=502, detail="ΣIRIUS Cloud est injoignable. Vérifiez la connexion Internet.") from error
        if r.status_code != 200:
            raise HTTPException(status_code=r.status_code, detail=_detail(r, "Connexion à ΣIRIUS Cloud refusée."))
        _store_session(r.json(), r)
        return _public_status()

    @router.get("/status")
    async def status(request: Request):
        await _guard(request)
        return _public_status()

    @router.post("/link")
    async def link(data: CloudLinkRequest, request: Request):
        await _guard(request)
        return await _authenticate("/api/auth/login", data)

    @router.post("/register")
    async def register(data: CloudLinkRequest, request: Request):
        await _guard(request)
        return await _authenticate("/api/auth/register", data)

    @router.delete("/link")
    async def unlink(request: Request):
        await _guard(request)
        clear_state()
        return _public_status()

    return router
