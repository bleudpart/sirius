"""QR code Cuisine : un lien révocable qui permet seulement de photographier et de retrouver les étiquettes."""
import hashlib
import re
import secrets
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, StringConstraints

import cloud_link

HEADER = "x-sirius-cuisine"
SITE_URL = "https://sirius-assistant.fr/cuisine"
DISABLED = "QR code cuisine désactivé. Demandez le nouveau QR code au chef."
_ALLOWED = (
    ("POST", re.compile(r"^/api/haccp/etiquettes/scan$")),
    ("GET", re.compile(r"^/api/haccp/registre/recherche$")),
    ("GET", re.compile(r"^/api/haccp/registre/\d+/photo$")),
    ("GET", re.compile(r"^/api/haccp/cuisine/session$")),
)


class KitchenLinkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    restaurant_name: Annotated[str, StringConstraints(min_length=1, max_length=160)]


def kitchen_token(request: Request) -> str | None:
    value = request.headers.get(HEADER)
    return None if value is None else value.strip()


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _public(link: dict | None) -> dict:
    if not link:
        return {"active": False}
    return {
        "active": True,
        "url": f"{SITE_URL}#k={link['token']}",
        "restaurant_name": link["restaurant_name"],
        "created_at": link["created_at"],
    }


async def resolve_kitchen(
    request: Request, db, owner_scope: Callable[[dict], Awaitable[str]],
) -> str:
    from access_gate import access_status

    path = request.scope.get("path", "")
    if not any(request.method == method and pattern.match(path) for method, pattern in _ALLOWED):
        raise HTTPException(403, "Ce QR code sert seulement à photographier et retrouver les étiquettes.")
    token = kitchen_token(request) or ""
    if not 20 <= len(token) <= 200:
        raise HTTPException(401, DISABLED)
    link = await db.haccp_kitchen_links.find_one({"token_hash": _hash(token)})
    if not link:
        raise HTTPException(401, DISABLED)
    owner = await db.users.find_one({"user_id": link.get("owner_user_id")})
    if not owner or owner.get("disabled"):
        raise HTTPException(401, DISABLED)
    if not (await access_status(db, owner)).get("allowed"):
        raise HTTPException(402, "Abonnement ΣIRIUS du chef inactif.")
    # Un chef retiré de l'entreprise ou privé du droit HACCP invalide son QR code.
    try:
        scope = await owner_scope(owner)
    except HTTPException as error:
        raise HTTPException(401, DISABLED) from error
    if scope != link.get("scope"):
        raise HTTPException(401, DISABLED)
    request.state.haccp_actor = owner["user_id"]
    request.state.haccp_kitchen = {"restaurant_name": link["restaurant_name"]}
    return scope


def make_haccp_kitchen_router(
    resolve_scope: Callable[[Request], Awaitable[str]], get_db: Callable[[], object],
) -> APIRouter:
    router = APIRouter(prefix="/haccp/cuisine", tags=["haccp-cuisine"])

    def chef(request: Request) -> str:
        actor = getattr(request.state, "haccp_actor", None)
        if getattr(request.state, "haccp_kitchen", None) is not None or not actor:
            raise HTTPException(403, "Réservé au chef connecté.")
        return str(actor)

    @router.get("/session")
    async def session(request: Request, _scope: str = Depends(resolve_scope)) -> dict:
        kitchen = getattr(request.state, "haccp_kitchen", None)
        if kitchen is None:
            raise HTTPException(400, "Réservé au QR code cuisine.")
        return {"restaurant_name": kitchen["restaurant_name"]}

    @router.get("/lien")
    async def current(request: Request, scope: str = Depends(resolve_scope)) -> dict:
        if cloud_link.relay_allowed():
            return (await cloud_link.relay_haccp_registry("GET", "/cuisine/lien")).json()
        chef(request)
        return _public(await get_db().haccp_kitchen_links.find_one({"scope": scope}))

    @router.post("/lien")
    async def create(body: KitchenLinkCreate, request: Request, scope: str = Depends(resolve_scope)) -> dict:
        if cloud_link.relay_allowed():
            return (await cloud_link.relay_haccp_registry("POST", "/cuisine/lien", json=body.model_dump())).json()
        owner = chef(request)
        db = get_db()
        token = secrets.token_urlsafe(32)
        link = {
            "scope": scope, "owner_user_id": owner, "restaurant_name": body.restaurant_name,
            "token": token, "token_hash": _hash(token),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.haccp_kitchen_links.delete_many({"scope": scope})
        await db.haccp_kitchen_links.insert_one(dict(link))
        return _public(link)

    @router.delete("/lien")
    async def disable(request: Request, scope: str = Depends(resolve_scope)) -> dict:
        if cloud_link.relay_allowed():
            return (await cloud_link.relay_haccp_registry("DELETE", "/cuisine/lien")).json()
        chef(request)
        await get_db().haccp_kitchen_links.delete_many({"scope": scope})
        return {"active": False}

    return router
