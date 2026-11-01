"""API du cerveau analytique : mêmes droits que la finance, lecture d'états publiés uniquement."""
import asyncio
import logging
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import ValidationError
from pymongo.errors import PyMongoError
from sqlalchemy.exc import SQLAlchemyError

from brain_analytical.collecte import ProfilIntrouvable
from brain_analytical.orchestrator import AnalyticalOrchestrator
from brain_analytical.repartition import ECHANGES, REPARTITION, etat_perime
from brain_analytical.schemas import (
    AlerteSuivie, AnalyseLancee, DemandeAcquittement, EtatCerveau, StatutAlerte, VueCortexAnalytique,
)
from brain_analytical.store import acquitter
from routers.finance import FinanceMember, read_json_object, resolve_finance_member
from schemas.finance import CompanyId

logger = logging.getLogger(__name__)
STORAGE_ERRORS = (SQLAlchemyError, sqlite3.Error, PyMongoError, OSError)


async def membre_courant(db, user_id: str):
    try:
        return await db.enterprise_members.find_one({"user_id": user_id})
    except (sqlite3.Error, PyMongoError) as error:
        logger.exception("[CERVEAU] Vérification des droits indisponible")
        raise HTTPException(503, "Vérification des droits entreprise indisponible.") from error


async def etat_autorise(orchestrator: AnalyticalOrchestrator, company_id: str) -> EtatCerveau:
    try:
        return await orchestrator.lire(company_id)
    except ProfilIntrouvable as error:
        raise HTTPException(404, str(error)) from error
    except STORAGE_ERRORS as error:
        logger.exception("[CERVEAU] Lecture de l'état impossible")
        raise HTTPException(503, "État analytique indisponible ; réessayez ultérieurement.") from error
    except ValueError as error:
        logger.exception("[CERVEAU] État publié incohérent")
        raise HTTPException(500, "État analytique incohérent ; aucune donnée partielle affichée.") from error


def make_analytical_router(db, require_user, orchestrator: AnalyticalOrchestrator) -> APIRouter:
    router = APIRouter(tags=["cerveau-analytique"])

    async def member(request: Request, company_id: str) -> FinanceMember:
        return await resolve_finance_member(db, require_user, request, company_id)

    @router.get("/finance/{company_id}/cerveau", response_model=EtatCerveau)
    async def state(company_id: Annotated[CompanyId, Path()], authorized: Annotated[FinanceMember, Depends(member)]) -> EtatCerveau:
        return await etat_autorise(orchestrator, authorized.company_id)

    @router.post("/finance/{company_id}/cerveau/analyse", response_model=AnalyseLancee, status_code=202)
    async def analyse(company_id: Annotated[CompanyId, Path()], request: Request,
                      authorized: Annotated[FinanceMember, Depends(member)]) -> AnalyseLancee:
        if await read_json_object(request, 4096):
            raise HTTPException(422, "La demande d'analyse attend un objet JSON vide.")
        await etat_autorise(orchestrator, authorized.company_id)
        accepted = await orchestrator.demander_analyse(authorized.company_id, authorized.user_id)
        if not accepted:
            raise HTTPException(503, "Analyse non planifiée : moteur arrêté ou file pleine.")
        return AnalyseLancee(company_id=company_id, acceptee=True,
                             message="Analyse planifiée en arrière-plan. Vous pouvez continuer à utiliser ΣIRIUS.")

    @router.post("/finance/{company_id}/cerveau/alertes/{alert_id}/acquitter", response_model=AlerteSuivie)
    async def ack(company_id: Annotated[CompanyId, Path()], alert_id: Annotated[int, Path(ge=1, le=2**63 - 1)],
                  request: Request, authorized: Annotated[FinanceMember, Depends(member)]) -> AlerteSuivie:
        try:
            body = DemandeAcquittement.model_validate(await read_json_object(request, 4096))
        except ValidationError as error:
            raise HTTPException(422, "Commentaire facultatif limité à 300 caractères ; aucun autre champ accepté.") from error
        try:
            return await asyncio.to_thread(
                lambda: acquitter(orchestrator.engine_factory(), authorized.company_id, alert_id,
                                  authorized.user_id, orchestrator.clock(), body.commentaire)
            )
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        except STORAGE_ERRORS as error:
            logger.exception("[CERVEAU] Acquittement non enregistré")
            raise HTTPException(503, "Acquittement non enregistré ; stockage indisponible.") from error

    @router.get("/cortex/analytique", response_model=VueCortexAnalytique)
    async def cortex(request: Request) -> VueCortexAnalytique:
        user = await require_user(request, db)
        membership = await membre_courant(db, str(user["user_id"]))
        state = None
        message = None
        if not membership:
            message = "Rattachez votre compte à une entreprise pour activer la surveillance financière."
        elif membership.get("role") not in {"admin", "manager"}:
            message = "Le cerveau analytique financier est réservé aux administrateurs et gestionnaires de l'entreprise."
        else:
            try:
                state = await etat_autorise(orchestrator, str(membership["company_id"]))
            except HTTPException as error:
                if error.status_code != 404:
                    raise
                message = str(error.detail)
            if state is not None:
                if not state.orchestrateur.actif:
                    message = "Moteur arrêté : l'état conservé n'est pas actualisé."
                elif etat_perime(state.verifie_le, orchestrator.clock()) and not state.orchestrateur.en_attente:
                    if await orchestrator.demander_analyse(state.company_id, str(user["user_id"])):
                        state = state.model_copy(update={"orchestrateur": orchestrator.statut(state.company_id)})
                        message = "Première analyse ou actualisation en cours."
                    else:
                        message = "Actualisation non planifiée : file pleine. Réessayez ultérieurement."
        return VueCortexAnalytique(etat=state, message=message, repartition=list(REPARTITION), echanges=list(ECHANGES))

    return router


def make_strategic_source(db, orchestrator: AnalyticalOrchestrator):
    async def source(user_id: str) -> list[AlerteSuivie]:
        membership = await membre_courant(db, user_id)
        if not membership or membership.get("role") not in {"admin", "manager"}:
            return []
        try:
            state = await etat_autorise(orchestrator, str(membership["company_id"]))
        except HTTPException as error:
            if error.status_code == 404:
                return []
            raise
        return [a for a in state.alertes if a.statut == StatutAlerte.OUVERTE]
    return source
