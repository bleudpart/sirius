"""Versioned occupational risk assessments, separate from food safety records."""

import uuid
from datetime import date, datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from typing_extensions import Annotated

from auth_api import require_user
from enterprise import record_audit, require_permission

RequiredText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]


class OccupationalRisk(BaseModel):
    model_config = ConfigDict(extra="forbid")
    unite: RequiredText
    situation: RequiredText
    danger: RequiredText
    personnes: Text = ""
    dommages: Text = ""
    mesures_existantes: Text = ""
    gravite: int = Field(strict=True, ge=1, le=4)
    probabilite: int = Field(strict=True, ge=1, le=4)
    action: Text = ""
    responsable: Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)] = ""
    echeance: date | None = None
    statut: Literal["a_faire", "en_cours", "realisee"] = "a_faire"


class DuerpDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    etablissement: RequiredText
    adresse: Text = ""
    employeur: RequiredText
    effectif: int | None = Field(default=None, strict=True, ge=0, le=1000000)
    participants: Text = ""
    date_evaluation: date
    motif_revision: Text = ""
    risques: list[OccupationalRisk] = Field(default_factory=list, max_length=200)


def assessed(row):
    score = row["gravite"] * row["probabilite"]
    return {**row, "score": score, "priorite": "haute" if score >= 12 else "moyenne" if score >= 6 else "basse"}


def public(document):
    return {**{key: value for key, value in document.items()
               if key not in {"_id", "user_id", "company_id", "created_by"}},
            "risques": [assessed(row) for row in document["risques"]]}


async def haccp_context(db, request):
    user = await require_user(request, db)
    if user.get("company_id"):
        member = await db.enterprise_members.find_one({
            "company_id": user["company_id"], "user_id": user["user_id"]}, {"_id": 0})
        require_permission(member or {}, "haccp")
        return user, {"company_id": user["company_id"]}
    return user, {"user_id": user["user_id"]}


def make_duerp_router(db):
    router = APIRouter(prefix="/duerp", tags=["duerp"])

    async def context(request):
        return await haccp_context(db, request)

    @router.get("")
    async def versions(request: Request):
        _, scope = await context(request)
        rows = await db.haccp_duerp.find(scope, {"_id": 0}).sort("created_at", -1).to_list(101)
        return {"items": [{"id": row["id"], "etablissement": row["etablissement"],
                           "date_evaluation": row["date_evaluation"], "created_at": row["created_at"],
                           "nombre_risques": len(row["risques"])} for row in rows[:100]],
                "truncated": len(rows) > 100}

    @router.get("/current")
    async def current(request: Request):
        _, scope = await context(request)
        rows = await db.haccp_duerp.find(scope, {"_id": 0}).sort("created_at", -1).to_list(1)
        return {"document": public(rows[0]) if rows else None}

    @router.get("/{identity}")
    async def version(identity: str, request: Request):
        _, scope = await context(request)
        row = await db.haccp_duerp.find_one({"id": identity, **scope}, {"_id": 0})
        if not row:
            raise HTTPException(404, "Version DUERP introuvable.")
        return {"document": public(row)}

    @router.post("")
    async def save(body: DuerpDocument, request: Request):
        user, scope = await context(request)
        document = {**body.model_dump(mode="json"), **scope, "id": str(uuid.uuid4()),
                    "created_by": user["user_id"], "created_at": datetime.now(timezone.utc).isoformat()}
        await db.haccp_duerp.insert_one(dict(document))
        if scope.get("company_id"):
            await record_audit(db, company_id=scope["company_id"], user=user, action="haccp.duerp.create",
                               resource="duerp", resource_id=document["id"],
                               details={"nombre_risques": len(body.risques)})
        return {"document": public(document)}

    return router
