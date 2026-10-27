"""File privee interrogee en sortie par le poste Windows, sans port entrant."""
import logging
import uuid
from collections.abc import Awaitable, Callable, Generator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StringConstraints
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

import cloud_link
from haccp_database import get_db
from models.haccp import EtiquetteHaccp
from models.haccp_printing import HaccpPrintJob, HaccpPrintStation
from routers.haccp import _response
from services.haccp_opening import construire_fragment_impression

logger = logging.getLogger(__name__)


class StationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    relay_id: uuid.UUID
    device_name: Annotated[str, StringConstraints(min_length=1, max_length=255)]
    width_mm: Annotated[int, Field(strict=True, ge=20, le=150)]
    height_mm: Annotated[int, Field(strict=True, ge=20, le=300)]


class ClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    relay_id: uuid.UUID


class PrintRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label_id: Annotated[int, Field(strict=True, gt=0)]
    reviewed: StrictBool


class PrintAcknowledgement(ClaimRequest):
    status: Literal["accepted", "uncertain"]
    detail: Annotated[str, StringConstraints(max_length=500)] | None = None


@contextmanager
def database_errors(db: Session) -> Generator[None, None, None]:
    try:
        yield
    except SQLAlchemyError as error:
        db.rollback()
        logger.exception("[HACCP-PRINT] Erreur de la file SQLite")
        raise HTTPException(500, "La file d'impression est indisponible.") from error


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _valid_label(db: Session, scope: str, label_id: int) -> EtiquetteHaccp:
    row = db.scalar(select(EtiquetteHaccp).where(
        EtiquetteHaccp.id == label_id, EtiquetteHaccp.scope_key == scope,
    ))
    if row is None:
        raise HTTPException(404, "Ouverture introuvable.")
    if (row.type_operation != "ouverture" or not row.dlc_secondaire or not row.conforme_reception
            or not row.regle_confirmee or row.dlc_secondaire <= _now()):
        raise HTTPException(422, "Ouverture non imprimable : regle, verification ou DLC secondaire invalide.")
    return row


def _station(db: Session, scope: str, relay_id: str | None = None) -> HaccpPrintStation:
    station = db.get(HaccpPrintStation, scope)
    if station is None:
        raise HTTPException(409, "Configurez d'abord l'imprimante dans ΣIRIUS Windows.")
    if relay_id is not None and station.relay_id != relay_id:
        raise HTTPException(409, "Un autre poste est configure pour ce registre. Utilisez le poste associe.")
    return station


def _job_response(job: HaccpPrintJob) -> dict[str, object]:
    return {"id": job.id, "label_id": job.label_id, "status": job.status, "detail": job.detail,
            "created_at": job.created_at.replace(tzinfo=timezone.utc).isoformat()}


def make_haccp_print_router(
    resolve_scope: Callable[[Request], Awaitable[str]],
    is_direct_local: Callable[[Request], bool],
) -> APIRouter:
    router = APIRouter(prefix="/haccp/impression", tags=["haccp-impression"])

    async def proxy(request: Request, path: str, body: BaseModel | None = None) -> dict | None:
        if not cloud_link.relay_allowed():
            return None
        if not is_direct_local(request):
            raise HTTPException(403, "Le relais Cloud d'impression est reserve a ce PC.")
        if not cloud_link.linked():
            raise HTTPException(409, "Reliez d'abord le PC a votre compte ΣIRIUS Cloud.")
        return await cloud_link.relay_haccp_print(path, body.model_dump(mode="json") if body else None)

    @router.get("/etat")
    async def state(
        request: Request, scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "/etat")
        if forwarded is not None:
            return forwarded
        with database_errors(db):
            stale = _now() - timedelta(minutes=2)
            db.execute(update(HaccpPrintJob).where(
                HaccpPrintJob.scope_key == scope, HaccpPrintJob.status == "claimed",
                HaccpPrintJob.claimed_at < stale,
            ).values(status="uncertain", detail="Confirmation du poste absente. Verifiez le papier, sans reemission automatique."))
            db.commit()
            station = db.get(HaccpPrintStation, scope)
            jobs = list(db.scalars(select(HaccpPrintJob).where(
                HaccpPrintJob.scope_key == scope,
            ).order_by(HaccpPrintJob.created_at.desc()).limit(20)))
            return {
                "station": None if station is None else {
                    "device_name": station.device_name, "width_mm": station.width_mm,
                    "height_mm": station.height_mm,
                    "online": station.last_seen >= _now() - timedelta(seconds=30),
                },
                "jobs": [_job_response(job) for job in jobs],
            }

    @router.post("/poste")
    async def configure(
        body: StationConfig, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "/poste", body)
        if forwarded is not None:
            return forwarded
        with database_errors(db):
            station = db.get(HaccpPrintStation, scope)
            if station is not None and station.relay_id != str(body.relay_id):
                raise HTTPException(409, "Un autre PC est deja associe : aucune reassociation automatique.")
            if station is None:
                station = HaccpPrintStation(scope_key=scope, relay_id=str(body.relay_id))
                db.add(station)
            station.device_name = body.device_name
            station.width_mm = body.width_mm
            station.height_mm = body.height_mm
            station.last_seen = _now()
            db.commit()
            return {"configured": True}

    @router.post("/demandes")
    async def enqueue(
        body: PrintRequest, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "/demandes", body)
        if forwarded is not None:
            return forwarded
        if not body.reviewed:
            raise HTTPException(422, "Relisez la photo et les dates puis confirmez l'ouverture avant impression.")
        with database_errors(db):
            row = _valid_label(db, scope, body.label_id)
            existing = db.scalar(select(HaccpPrintJob).where(
                HaccpPrintJob.scope_key == scope, HaccpPrintJob.label_id == row.id,
            ))
            if existing is not None:
                return _job_response(existing)
            station = _station(db, scope)
            if station.last_seen < _now() - timedelta(seconds=30):
                raise HTTPException(409, "Le poste d'impression est hors ligne. Ouvrez ΣIRIUS sur le PC.")
            job = HaccpPrintJob(
                id=str(uuid.uuid4()), scope_key=scope, label_id=row.id, relay_id=station.relay_id,
                status="pending", created_at=_now(),
            )
            db.add(job)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                existing = db.scalar(select(HaccpPrintJob).where(
                    HaccpPrintJob.scope_key == scope, HaccpPrintJob.label_id == row.id,
                ))
                if existing is None:
                    raise
                return _job_response(existing)
            return _job_response(job)

    @router.post("/prochaine")
    async def claim(
        body: ClaimRequest, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "/prochaine", body)
        if forwarded is not None:
            return forwarded
        with database_errors(db):
            station = _station(db, scope, str(body.relay_id))
            station.last_seen = _now()
            db.commit()
            job = db.scalar(select(HaccpPrintJob).where(
                HaccpPrintJob.scope_key == scope, HaccpPrintJob.relay_id == station.relay_id,
                HaccpPrintJob.status == "pending",
            ).order_by(HaccpPrintJob.created_at, HaccpPrintJob.id).limit(1))
            if job is None:
                return {"job": None}
            updated = db.execute(update(HaccpPrintJob).where(
                HaccpPrintJob.id == job.id, HaccpPrintJob.status == "pending",
            ).values(status="claimed", claimed_at=_now()))
            db.commit()
            if updated.rowcount != 1:
                return {"job": None}
            try:
                row = _valid_label(db, scope, job.label_id)
            except HTTPException as error:
                job.status = "cancelled"
                job.detail = str(error.detail)
                db.commit()
                return {"job": None}
            return {"job": {
                "id": job.id, "html": construire_fragment_impression(_response(row, "/api/haccp/registre")),
                "widthMm": station.width_mm, "heightMm": station.height_mm,
            }}

    @router.post("/demandes/{job_id}/confirmation")
    async def acknowledge(
        job_id: uuid.UUID, body: PrintAcknowledgement, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, f"/demandes/{job_id}/confirmation", body)
        if forwarded is not None:
            return forwarded
        with database_errors(db):
            _station(db, scope, str(body.relay_id))
            job = db.scalar(select(HaccpPrintJob).where(
                HaccpPrintJob.id == str(job_id), HaccpPrintJob.scope_key == scope,
                HaccpPrintJob.relay_id == str(body.relay_id),
            ))
            if job is None:
                raise HTTPException(404, "Demande d'impression introuvable.")
            if job.status in {"accepted", "uncertain"}:
                return _job_response(job)
            if job.status != "claimed":
                raise HTTPException(409, "Cette demande n'a pas ete prise en charge par le poste.")
            job.status = body.status
            job.detail = ("Acceptee par le spouleur Windows ; sortie papier a verifier."
                          if body.status == "accepted" else "Impression incertaine. Verifiez le papier et le poste ; aucun nouvel essai automatique.")
            db.commit()
            return _job_response(job)

    return router
