"""Consultation des quatre destinations, reprise et deconditionnement explicite."""
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Path as PathParam, Query, Request, Response
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

import cloud_link
from haccp_database import get_db, get_engine
from models.haccp import EtiquetteHaccp
from models.haccp_reception import ReceptionSource
from schemas.haccp import Destination, EtatDistribution, EtiquetteResponse, OperationCapture
from schemas.haccp_reception import OuvertureReception, canonical_json, fingerprint
from services.haccp_opening import calculer_ouverture, verifier_etiquette_imprimable
from services.haccp_records import existing_capture, record_response, save_record
from services.haccp_reception import (
    ReceptionDispatcher, ReceptionIntegrityError, ReceptionNotFoundError, charger_source,
    consulter_destination, etat_distribution, lire_image_verifiee, verifier_integrite,
)

logger = logging.getLogger(__name__)
T = TypeVar("T")


async def _run(operation: Callable[..., T], *args, **kwargs) -> T:
    try:
        return await run_in_threadpool(operation, *args, **kwargs)
    except ReceptionNotFoundError as error:
        raise HTTPException(404, str(error)) from error
    except (ReceptionIntegrityError, ValidationError) as error:
        logger.exception("[HACCP] Integrite des receptions invalide")
        raise HTTPException(409, "L'integrite de cette reception est invalide. Consultez le controle du journal.") from error
    except (SQLAlchemyError, OSError) as error:
        logger.exception("[HACCP] Operation sur les receptions impossible")
        raise HTTPException(503, "Le registre des receptions est indisponible. "
                            "Les reprises utilisent la fiche existante, sans nouvelle photo.") from error


def _liste(db: Session, scope: str, restaurant_name: str | None, offset: int, limit: int, prefix: str) -> dict:
    statement = select(EtiquetteHaccp).join(
        ReceptionSource, ReceptionSource.reception_id == EtiquetteHaccp.id,
    ).where(ReceptionSource.scope_key == scope)
    if restaurant_name is not None:
        statement = statement.where(func.haccp_casefold(EtiquetteHaccp.restaurant_name) == restaurant_name.strip().casefold())
    total = db.scalar(select(func.count()).select_from(statement.subquery()))
    items = []
    for row in db.scalars(statement.order_by(EtiquetteHaccp.created_at.desc(), EtiquetteHaccp.id.desc()).offset(offset).limit(limit)):
        record = record_response(row, prefix)
        record.distribution = etat_distribution(db, scope, row.id)
        items.append(record.model_dump(mode="json"))
    return {"items": items, "total": total, "offset": offset, "limit": limit}


def _ouvrir(
    db: Session, scope: str, reception_id: int, body: OuvertureReception, prefix: str,
) -> EtiquetteResponse:
    digest = fingerprint(canonical_json({"reception_id": reception_id, **body.model_dump(mode="json", exclude={"capture_id"})}))
    existing = existing_capture(db, scope, str(body.capture_id), digest, prefix)
    if existing is not None:
        return existing
    _, document = charger_source(db, scope, reception_id)
    lire_image_verifiee(document.image, scope)
    source_row = db.scalar(select(EtiquetteHaccp).where(
        EtiquetteHaccp.id == reception_id, EtiquetteHaccp.scope_key == scope,
    ))
    if source_row is None:
        raise ReceptionNotFoundError("La fiche de reception est introuvable.")
    operation = OperationCapture.model_validate(body.model_dump(include=set(OperationCapture.model_fields)))
    instant = datetime.now(timezone.utc)
    try:
        label, deadline = calculer_ouverture(document.etiquette, operation, instant)
        candidate = EtiquetteResponse.model_validate({
            **record_response(source_row, prefix).model_dump(),
            **label.model_dump(), **operation.model_dump(),
            "date_ouverture": instant, "dlc_secondaire": deadline,
        })
        verifier_etiquette_imprimable(candidate, instant)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    try:
        return save_record(
            db, label, scope, body.operateur, source_row.image_path, prefix,
            operation, instant, deadline, str(body.capture_id), digest,
            restaurant_name=document.restaurant_name, raw_image=document.image, reception_source_id=reception_id,
        )
    except IntegrityError:
        existing = existing_capture(db, scope, str(body.capture_id), digest, prefix)
        if existing is None:
            raise
        return existing


def make_haccp_reception_router(resolve_scope: Callable[[Request], Awaitable[str]]) -> APIRouter:
    router = APIRouter(prefix="/receptions", tags=["haccp-receptions"])

    @router.get("")
    async def liste(
        request: Request, response: Response,
        restaurant_name: Annotated[str | None, Query(min_length=1, max_length=160)] = None,
        offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=100)] = 25,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        response.headers["Cache-Control"] = "private, no-store"
        if cloud_link.relay_allowed():
            return (await cloud_link.relay_haccp_registry("GET", "/receptions", params=dict(request.query_params))).json()
        prefix = str(request.url_for("haccp_search")).removesuffix("/recherche")
        return await _run(_liste, db, scope, restaurant_name, offset, limit, prefix)

    @router.get("/destinations/{destination}")
    async def destination(
        destination: Destination, request: Request, response: Response,
        restaurant_name: Annotated[str | None, Query(min_length=1, max_length=160)] = None,
        offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=100)] = 25,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        response.headers["Cache-Control"] = "private, no-store"
        if cloud_link.relay_allowed():
            return (await cloud_link.relay_haccp_registry(
                "GET", f"/receptions/destinations/{destination}", params=dict(request.query_params),
            )).json()
        return await _run(consulter_destination, db, scope, destination, restaurant_name, offset, limit)

    @router.get("/integrite")
    async def integrite(
        request: Request, response: Response,
        offset: Annotated[int, Query(ge=0)] = 0, limit: Annotated[int, Query(ge=1, le=100)] = 20,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        response.headers["Cache-Control"] = "private, no-store"
        if cloud_link.relay_allowed():
            return (await cloud_link.relay_haccp_registry("GET", "/receptions/integrite", params=dict(request.query_params))).json()
        return await _run(verifier_integrite, db, scope, offset, limit)

    @router.get("/{id}/distribution", response_model=EtatDistribution)
    async def distribution(
        id: Annotated[int, PathParam(ge=1)], response: Response,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> EtatDistribution:
        response.headers["Cache-Control"] = "private, no-store"
        if cloud_link.relay_allowed():
            forwarded = await cloud_link.relay_haccp_registry("GET", f"/receptions/{id}/distribution")
            return EtatDistribution.model_validate(forwarded.json())
        return await _run(etat_distribution, db, scope, id)

    @router.post("/{id}/reprise", response_model=EtatDistribution)
    async def reprise(
        id: Annotated[int, PathParam(ge=1)], response: Response, scope: str = Depends(resolve_scope),
    ) -> EtatDistribution:
        response.headers["Cache-Control"] = "private, no-store"
        if cloud_link.relay_allowed():
            forwarded = await cloud_link.relay_haccp_registry("POST", f"/receptions/{id}/reprise")
            return EtatDistribution.model_validate(forwarded.json())
        return await _run(lambda: ReceptionDispatcher(get_engine()).distribuer(scope, id))

    @router.get("/{id}/original")
    async def original(
        id: Annotated[int, PathParam(ge=1)], scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> Response:
        if cloud_link.relay_allowed():
            forwarded = await cloud_link.relay_haccp_registry("GET", f"/receptions/{id}/original")
            headers = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}
            for name in ("Content-Disposition", "X-HACCP-SHA256"):
                if name in forwarded.headers:
                    headers[name] = forwarded.headers[name]
            return Response(forwarded.content, media_type=forwarded.headers.get("content-type", "application/octet-stream"),
                            headers=headers)
        def load():
            _, document = charger_source(db, scope, id)
            return document.image, lire_image_verifiee(document.image, scope)
        image, content = await _run(load)
        return Response(content, media_type=image.type_mime, headers={
            "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
            "Content-Disposition": f'attachment; filename="{Path(image.chemin).name}"',
            "X-HACCP-SHA256": image.sha256,
        })

    @router.post("/{id}/ouverture", response_model=EtiquetteResponse, status_code=201)
    async def ouverture(
        id: Annotated[int, PathParam(ge=1)], body: OuvertureReception, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> EtiquetteResponse:
        if cloud_link.relay_allowed():
            forwarded = await cloud_link.relay_haccp_registry(
                "POST", f"/receptions/{id}/ouverture", json=body.model_dump(mode="json"),
            )
            return EtiquetteResponse.model_validate(forwarded.json())
        return await _run(_ouvrir, db, scope, id, body, str(request.url_for("haccp_search")).removesuffix("/recherche"))

    return router
