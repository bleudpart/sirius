"""Versioned personnel and site safety working registers, not statutory certification."""

import uuid
from datetime import date, datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from duerp import RequiredText, Text, haccp_context
from enterprise import record_audit

Progress = Literal["a_faire", "en_cours", "realisee"]


class SafetyEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WelcomeEntry(SafetyEntry):
    personne: RequiredText
    poste: RequiredText
    date_accueil: date
    accueillant: Text = ""
    consignes_remises: Text = ""
    observations: Text = ""


class TrainingEntry(SafetyEntry):
    personne: RequiredText
    formation: RequiredText
    date_formation: date
    organisme: Text = ""
    preuve: Text = ""
    renouvellement: date | None = None
    observations: Text = ""


class EvacuationEntry(SafetyEntry):
    date_exercice: date
    scenario: RequiredText
    responsable: Text = ""
    participants: Text = ""
    observations: Text = ""
    action: Text = ""
    pilote_action: Text = ""
    echeance: date | None = None
    statut: Progress = "a_faire"


class VerificationEntry(SafetyEntry):
    equipement: RequiredText
    type_verification: RequiredText
    date_verification: date
    intervenant: Text = ""
    resultat: Literal["sans_observation", "avec_observations", "non_verifie"] = "non_verifie"
    reference_rapport: Text = ""
    observations: Text = ""
    prochaine_date: date | None = None
    action: Text = ""
    responsable: Text = ""
    echeance: date | None = None
    statut: Progress = "a_faire"


class FireInstructions(SafetyEntry):
    responsable: Text = ""
    alerte: Text = ""
    evacuation: Text = ""
    point_rassemblement: Text = ""
    accueil_secours: Text = ""
    assistance: Text = ""
    references_plans: Text = ""
    valide_par: Text = ""
    date_validation: date | None = None


class ShiftEntry(SafetyEntry):
    personne: RequiredText
    poste: RequiredText
    date_service: date
    debut: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    fin: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    lendemain: Literal["non", "oui"] = "non"
    pause_minutes: int = Field(default=0, strict=True, ge=0, le=1439)
    observations: Text = ""

    @model_validator(mode="after")
    def valid_duration(self):
        def minutes(value):
            hour, minute = map(int, value.split(":"))
            return hour * 60 + minute
        duration = minutes(self.fin) - minutes(self.debut) + (1440 if self.lendemain == "oui" else 0)
        if not 0 < duration < 1440 or self.pause_minutes >= duration:
            raise ValueError("Durée de service invalide ; vérifier horaires, lendemain et pause.")
        return self


class SafetyDossier(SafetyEntry):
    etablissement: RequiredText
    adresse: Text = ""
    responsable: RequiredText
    date_document: date
    motif_revision: Text = ""
    accueil: list[WelcomeEntry] = Field(default_factory=list, max_length=200)
    formations: list[TrainingEntry] = Field(default_factory=list, max_length=200)
    incendie: FireInstructions = Field(default_factory=FireInstructions)
    evacuations: list[EvacuationEntry] = Field(default_factory=list, max_length=200)
    verifications: list[VerificationEntry] = Field(default_factory=list, max_length=200)
    planning_cuisine: list[ShiftEntry] = Field(default_factory=list, max_length=200)
    planning_salle: list[ShiftEntry] = Field(default_factory=list, max_length=200)


def public(document):
    return {key: value for key, value in document.items()
            if key not in {"_id", "user_id", "company_id", "created_by"}}


def make_safety_router(db):
    router = APIRouter(prefix="/personnel-securite", tags=["personnel-securite"])

    @router.get("")
    async def versions(request: Request):
        _, scope = await haccp_context(db, request)
        rows = await db.haccp_safety.find(scope, {"_id": 0}).sort("created_at", -1).to_list(101)
        return {"items": [{"id": row["id"], "etablissement": row["etablissement"],
                           "date_document": row["date_document"], "created_at": row["created_at"]}
                          for row in rows[:100]], "truncated": len(rows) > 100}

    @router.get("/current")
    async def current(request: Request):
        _, scope = await haccp_context(db, request)
        rows = await db.haccp_safety.find(scope, {"_id": 0}).sort("created_at", -1).to_list(1)
        return {"document": public(rows[0]) if rows else None}

    @router.get("/{identity}")
    async def version(identity: str, request: Request):
        _, scope = await haccp_context(db, request)
        row = await db.haccp_safety.find_one({"id": identity, **scope}, {"_id": 0})
        if not row:
            raise HTTPException(404, "Version personnel et sécurité introuvable.")
        return {"document": public(row)}

    @router.post("")
    async def save(body: SafetyDossier, request: Request):
        user, scope = await haccp_context(db, request)
        document = {**body.model_dump(mode="json"), **scope, "id": str(uuid.uuid4()),
                    "created_by": user["user_id"], "created_at": datetime.now(timezone.utc).isoformat()}
        await db.haccp_safety.insert_one(dict(document))
        if scope.get("company_id"):
            await record_audit(db, company_id=scope["company_id"], user=user, action="haccp.safety.create",
                               resource="personnel-securite", resource_id=document["id"])
        return {"document": public(document)}

    return router
