"""Editable HACCP sheet snapshots, isolated by account or enterprise."""

import uuid
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from duerp import RequiredText, Text, haccp_context
from enterprise import record_audit

Template = Literal["temp", "frigo", "congelateur", "chambre_froide", "epicerie", "boitage", "cuisson",
                   "refroidissement", "remise", "reception", "huiles", "nettoyage", "trace", "dlc", "maintenance"]
Cell = Annotated[str, StringConstraints(max_length=1000)]
Column = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Row = Annotated[list[Cell], Field(min_length=2, max_length=16)]


class SheetDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    titre: RequiredText
    sous: Text = ""
    etablissement: RequiredText
    periode: Text = ""
    responsable: Text = ""
    equipement: Text = ""
    cible: Text = ""
    remarques: Text = ""
    colonnes: list[Column] = Field(min_length=2, max_length=16)
    lignes: list[Row] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def consistent_columns(self):
        if any(len(row) != len(self.colonnes) for row in self.lignes):
            raise ValueError("Chaque ligne doit contenir une case par colonne.")
        return self


def public(document):
    return {key: value for key, value in document.items()
            if key not in {"_id", "user_id", "company_id", "created_by"}}


def make_sheet_documents_router(db):
    router = APIRouter(prefix="/feuilles", tags=["feuilles-haccp"])

    @router.get("/{template}/current")
    async def current(template: Template, request: Request):
        _, scope = await haccp_context(db, request)
        rows = await db.haccp_sheets.find({"modele": template, **scope}, {"_id": 0}).sort("created_at", -1).to_list(1)
        return {"document": public(rows[0]) if rows else None}

    @router.get("/{template}/versions")
    async def versions(template: Template, request: Request):
        _, scope = await haccp_context(db, request)
        rows = await db.haccp_sheets.find({"modele": template, **scope}, {"_id": 0}).sort("created_at", -1).to_list(101)
        return {"items": [{"id": row["id"], "titre": row["titre"], "created_at": row["created_at"]}
                          for row in rows[:100]], "truncated": len(rows) > 100}

    @router.get("/{template}/versions/{identity}")
    async def version(template: Template, identity: str, request: Request):
        _, scope = await haccp_context(db, request)
        row = await db.haccp_sheets.find_one({"id": identity, "modele": template, **scope}, {"_id": 0})
        if not row:
            raise HTTPException(404, "Version de feuille introuvable.")
        return {"document": public(row)}

    @router.post("/{template}")
    async def save(template: Template, body: SheetDocument, request: Request):
        user, scope = await haccp_context(db, request)
        document = {**body.model_dump(mode="json"), **scope, "modele": template, "id": str(uuid.uuid4()),
                    "created_at": datetime.now(timezone.utc).isoformat(), "created_by": user["user_id"]}
        await db.haccp_sheets.insert_one(dict(document))
        if scope.get("company_id"):
            await record_audit(db, company_id=scope["company_id"], user=user, action="haccp.sheet.create",
                               resource="feuille-haccp", resource_id=document["id"], details={"modele": template})
        return {"document": public(document)}

    return router
