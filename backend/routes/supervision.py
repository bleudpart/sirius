# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
"""Routes de supervision ARGUS / OMEGA (scan, statut, rapports, correctifs)."""

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field


class ArgusReportRequest(BaseModel):
    source: str = Field(default="runtime", max_length=40)
    message: str = Field(min_length=1, max_length=300)
    stack: str = Field(default="", max_length=500)


class ArgusFixRequest(BaseModel):
    fixId: str = Field(min_length=1, max_length=80)
    confirmed: bool = False


def make_supervision_router(db, omega, require_user, require_local_control, admin_token_matches):
    router = APIRouter(tags=["supervision"])

    @router.post("/argus/scan")
    async def argus_scan(request: Request):
        require_local_control(request)
        await require_user(request, db)
        return omega.scan()

    @router.get("/omega/status")
    async def omega_status(request: Request):
        require_local_control(request)
        await require_user(request, db)
        return omega.status()

    @router.get("/omega/skills")
    async def omega_skills(request: Request):
        require_local_control(request)
        await require_user(request, db)
        skills = omega.skills()
        return {
            "name": "OMEGA_SKILLS",
            "state": "active" if all(skill["state"] == "active" for skill in skills) else "degraded",
            "skills": skills,
        }

    @router.post("/argus/report")
    async def argus_report(payload: ArgusReportRequest, request: Request):
        require_local_control(request)
        await require_user(request, db)
        return omega.report(payload.source, payload.message, payload.stack)

    @router.post("/argus/fix")
    async def argus_fix(
        payload: ArgusFixRequest,
        request: Request,
        x_admin_token: str | None = Header(default=None),
    ):
        require_local_control(request)
        await require_user(request, db)
        if payload.fixId == "clear_runtime_reports" and not admin_token_matches(x_admin_token):
            raise HTTPException(status_code=403, detail="Jeton administrateur requis pour acquitter les rapports.")
        return omega.fix(payload.fixId, payload.confirmed)

    return router
