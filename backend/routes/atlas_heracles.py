# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Stubs de compatibilité ATLAS (itinéraires) et HERACLES (OSINT)."""

from fastapi import APIRouter


def make_stub_router():
    router = APIRouter(tags=["stubs"])

    @router.get("/atlas/route")
    async def atlas_route_get():
        return {"ok": True, "route": {"from": "Paris", "to": "Lyon", "distance_km": 420}, "status": "stub"}

    @router.post("/atlas/route")
    async def atlas_route_post(payload: dict | None = None):
        body = payload or {}
        return {"ok": True, "route": {"from": body.get("from_address", "Paris"), "to": body.get("to_address", "Lyon"), "distance_km": 420}, "status": "stub"}

    @router.get("/heracles/check")
    async def heracles_check_get():
        return {"ok": True, "status": "ok", "result": "Heracles check stub ready"}

    @router.post("/heracles/check")
    async def heracles_check_post(payload: dict | None = None):
        body = payload or {}
        return {"ok": True, "status": "ok", "input": body.get("input", "@sirius_diag"), "result": "Heracles check stub ready"}

    return router
