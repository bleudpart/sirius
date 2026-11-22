"""File privee interrogee en sortie par le poste Windows, sans port entrant."""
import hashlib
import logging
import secrets
import uuid
from collections.abc import Awaitable, Callable, Generator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StringConstraints
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

import cloud_link
from haccp_database import get_db
from models.haccp import EtiquetteHaccp
from models.haccp_printing import (
    HaccpAndroidPrintTarget, HaccpMobilePrintTarget, HaccpPrintJob,
    HaccpPrintRelayCredential, HaccpPrintStation,
)
from routers.haccp import _response
from services.haccp_opening import (
    PARIS, construire_etiquette_mobile, construire_fragment_impression, verifier_etiquette_imprimable,
)

logger = logging.getLogger(__name__)


class StationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    relay_id: uuid.UUID
    device_name: Annotated[str, StringConstraints(min_length=1, max_length=255)]
    width_mm: Annotated[int, Field(strict=True, ge=20, le=150)]
    height_mm: Annotated[int, Field(strict=True, ge=20, le=300)]


class RelayStationConfig(StationConfig):
    replace_existing: StrictBool = False


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


class RelayAcknowledgement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["accepted", "uncertain"]
    detail: Annotated[str, StringConstraints(max_length=500)] | None = None


class DeviceIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: uuid.UUID


class AndroidPrintRequest(DeviceIdentity):
    label_id: Annotated[int, Field(strict=True, gt=0)]
    reviewed: StrictBool


class AndroidAcknowledgement(DeviceIdentity):
    status: Literal["accepted", "uncertain"]
    detail: Annotated[str, StringConstraints(max_length=500)] | None = None


class MobilePrintRequest(PrintRequest):
    device_id: uuid.UUID


def _actor(request: Request, scope: str) -> str:
    actor = getattr(request.state, "haccp_actor", None)
    if actor:
        return str(actor)
    if scope.startswith("user:"):
        return scope[5:]
    raise HTTPException(403, "Identite de l'operateur requise pour l'impression directe.")


def _android_payload(row: EtiquetteHaccp, job_id: str) -> dict:
    record = _response(row, "/api/haccp/registre")
    preparation = record.type_operation == "preparation"
    def stamp(value: datetime | None) -> str:
        return value.astimezone(PARIS).strftime("%d/%m/%Y %H:%M:%S %z" if preparation else "%d/%m/%Y %H:%M") if value else ""
    return {
        "id": job_id, "labelId": row.id,
        "product": record.nom_produit, "lot": record.numero_lot,
        **({"operation": "preparation", "prepared": stamp(record.date_fabrication),
            "storage": record.conditions_conservation} if preparation else {"opened": stamp(record.date_ouverture)}),
        "deadline": stamp(record.dlc_secondaire),
        "operator": record.operateur,
    }


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


def _valid_label(
    db: Session, scope: str, label_id: int, restaurant_name: str | None = None,
) -> EtiquetteHaccp:
    statement = select(EtiquetteHaccp).where(
        EtiquetteHaccp.id == label_id, EtiquetteHaccp.scope_key == scope,
    )
    if restaurant_name is not None:
        statement = statement.where(EtiquetteHaccp.restaurant_name == restaurant_name)
    row = db.scalar(statement)
    if row is None:
        raise HTTPException(404, "Etiquette introuvable.")
    try:
        verifier_etiquette_imprimable(_response(row, "/api/haccp/registre"), _now().replace(tzinfo=timezone.utc))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return row


def _station(db: Session, scope: str, relay_id: str | None = None) -> HaccpPrintStation:
    station = db.get(HaccpPrintStation, scope)
    if station is None:
        raise HTTPException(409, "Configurez d'abord un poste d'impression ΣIRIUS.")
    if relay_id is not None and station.relay_id != relay_id:
        raise HTTPException(409, "Un autre poste est configure pour ce registre. Utilisez le poste associe.")
    return station


def _job_response(job: HaccpPrintJob, transport: str = "windows") -> dict[str, object]:
    return {"id": job.id, "label_id": job.label_id, "status": job.status, "detail": job.detail,
            "transport": transport,
            "created_at": job.created_at.replace(tzinfo=timezone.utc).isoformat(),
            "accepted_at": job.accepted_at.replace(tzinfo=timezone.utc).isoformat() if job.accepted_at else None}


def _job_transport(db: Session, job: HaccpPrintJob) -> str:
    if db.get(HaccpMobilePrintTarget, job.id):
        return "mobile"
    if db.get(HaccpAndroidPrintTarget, job.id):
        return "android"
    if db.scalar(select(HaccpPrintRelayCredential.token_hash).where(
        HaccpPrintRelayCredential.scope_key == job.scope_key,
        HaccpPrintRelayCredential.relay_id == job.relay_id,
    )) is not None:
        return "linux"
    return "windows"


def make_haccp_print_router(
    resolve_scope: Callable[[Request], Awaitable[str]],
    is_direct_local: Callable[[Request], bool],
    resolve_relay_owner_scope: Callable[[str], Awaitable[str]] | None = None,
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

    async def authenticate_relay(request: Request, db: Session) -> tuple[HaccpPrintRelayCredential, HaccpPrintStation]:
        token = request.headers.get("x-sirius-print-relay", "").strip()
        if not token or resolve_relay_owner_scope is None:
            raise HTTPException(401, "Autorisation du relais Linux absente ou invalide.")
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        credential = db.get(HaccpPrintRelayCredential, token_hash)
        if credential is None:
            raise HTTPException(401, "Autorisation du relais Linux absente ou invalide.")
        try:
            owner_scope = await resolve_relay_owner_scope(credential.owner_user_id)
        except HTTPException as error:
            raise HTTPException(error.status_code, "Autorisation du relais Linux révoquée ou compte indisponible.") from error
        if owner_scope != credential.scope_key:
            raise HTTPException(401, "Autorisation du relais Linux révoquée ou compte indisponible.")
        return credential, _station(db, credential.scope_key, credential.relay_id)

    def claim_job(db: Session, scope: str, relay_id: str, transport: str = "windows") -> dict:
        station = _station(db, scope, relay_id)
        paired = db.scalar(select(HaccpPrintRelayCredential.token_hash).where(
            HaccpPrintRelayCredential.scope_key == scope,
            HaccpPrintRelayCredential.relay_id == relay_id,
        )) is not None
        if (transport == "linux") != paired:
            raise HTTPException(409, "Le transport ne correspond pas au relais associé.")
        station.last_seen = _now()
        db.commit()
        job = db.scalar(select(HaccpPrintJob).where(
            HaccpPrintJob.scope_key == scope, HaccpPrintJob.relay_id == station.relay_id,
            HaccpPrintJob.status == "pending",
            ~select(HaccpAndroidPrintTarget.job_id).where(
                HaccpAndroidPrintTarget.job_id == HaccpPrintJob.id,
            ).exists(),
            ~select(HaccpMobilePrintTarget.job_id).where(
                HaccpMobilePrintTarget.job_id == HaccpPrintJob.id,
            ).exists(),
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

    def acknowledge_job(
        db: Session, scope: str, relay_id: str, job_id: uuid.UUID, status: str,
        transport: str = "windows",
    ) -> dict:
        _station(db, scope, relay_id)
        job = db.scalar(select(HaccpPrintJob).where(
            HaccpPrintJob.id == str(job_id), HaccpPrintJob.scope_key == scope,
            HaccpPrintJob.relay_id == relay_id,
        ))
        if job is None:
            raise HTTPException(404, "Demande d'impression introuvable.")
        if _job_transport(db, job) != transport:
            raise HTTPException(409, "Cette demande est reservee a un autre transport d'impression.")
        if job.status in {"accepted", "uncertain"}:
            return _job_response(job, transport)
        if job.status != "claimed":
            raise HTTPException(409, "Cette demande n'a pas ete prise en charge par le poste.")
        detail = ("Acceptee par le spouleur ; sortie papier a verifier."
                  if status == "accepted" else "Impression incertaine. Verifiez le papier et le poste ; aucun nouvel essai automatique.")
        db.execute(update(HaccpPrintJob).where(
            HaccpPrintJob.id == job.id, HaccpPrintJob.status == "claimed",
        ).values(status=status, detail=detail,
                 accepted_at=_now() if status == "accepted" else None))
        db.commit()
        db.refresh(job)
        return _job_response(job, transport)

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
            ).values(status="uncertain", detail="Confirmation de l'appareil absente. Verifiez le papier, sans reemission automatique."))
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
                "jobs": [_job_response(job, _job_transport(db, job)) for job in jobs],
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

    @router.post("/relais/associer")
    async def pair_relay(
        body: RelayStationConfig, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "/relais/associer", body)
        if forwarded is not None:
            return forwarded
        if getattr(request.state, "haccp_kitchen", None) is not None:
            raise HTTPException(403, "Associez un relais depuis le compte du chef.")
        owner_user_id = getattr(request.state, "haccp_actor", None)
        if not owner_user_id:
            raise HTTPException(403, "Identite du chef requise pour associer le relais.")
        with database_errors(db):
            station = db.get(HaccpPrintStation, scope)
            if station is not None and station.relay_id != str(body.relay_id) and not body.replace_existing:
                raise HTTPException(409, "Un autre poste est associe. Confirmez explicitement son remplacement.")
            if station is not None and station.relay_id != str(body.relay_id):
                db.execute(update(HaccpPrintJob).where(
                    HaccpPrintJob.scope_key == scope, HaccpPrintJob.relay_id == station.relay_id,
                    HaccpPrintJob.status == "pending",
                ).values(status="cancelled", detail="Poste remplacé ; demande non transmise."))
                db.execute(update(HaccpPrintJob).where(
                    HaccpPrintJob.scope_key == scope, HaccpPrintJob.relay_id == station.relay_id,
                    HaccpPrintJob.status == "claimed",
                ).values(status="uncertain", detail="Poste remplacé pendant l'impression. Vérifiez le papier ; aucun nouvel essai automatique."))
            if station is None:
                station = HaccpPrintStation(scope_key=scope, relay_id=str(body.relay_id))
                db.add(station)
            station.relay_id = str(body.relay_id)
            station.device_name = body.device_name
            station.width_mm = body.width_mm
            station.height_mm = body.height_mm
            station.last_seen = _now() - timedelta(minutes=5)
            db.execute(delete(HaccpPrintRelayCredential).where(HaccpPrintRelayCredential.scope_key == scope))
            token = secrets.token_urlsafe(32)
            db.add(HaccpPrintRelayCredential(
                token_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
                scope_key=scope, relay_id=str(body.relay_id), owner_user_id=str(owner_user_id),
                created_at=_now(),
            ))
            db.commit()
            return {"configured": True, "relay_id": str(body.relay_id), "token": token}

    @router.get("/relais/config")
    async def relay_config(request: Request, db: Session = Depends(get_db)) -> dict:
        with database_errors(db):
            _credential, station = await authenticate_relay(request, db)
            station.last_seen = _now()
            db.commit()
            return {
                "relay_id": station.relay_id, "device_name": station.device_name,
                "width_mm": station.width_mm, "height_mm": station.height_mm,
            }

    @router.post("/relais/prochaine")
    async def relay_claim(request: Request, db: Session = Depends(get_db)) -> dict:
        with database_errors(db):
            credential, _station_row = await authenticate_relay(request, db)
            return claim_job(db, credential.scope_key, credential.relay_id, "linux")

    @router.post("/relais/demandes/{job_id}/confirmation")
    async def relay_acknowledge(
        job_id: uuid.UUID, body: RelayAcknowledgement, request: Request,
        db: Session = Depends(get_db),
    ) -> dict:
        with database_errors(db):
            credential, _station_row = await authenticate_relay(request, db)
            return acknowledge_job(db, credential.scope_key, credential.relay_id, job_id, body.status, "linux")

    @router.post("/demandes")
    async def enqueue(
        body: PrintRequest, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "/demandes", body)
        if forwarded is not None:
            return forwarded
        if not body.reviewed:
            raise HTTPException(422, "Relisez le produit, les dates et les conditions puis confirmez avant impression.")
        with database_errors(db):
            row = _valid_label(db, scope, body.label_id)
            existing = db.scalar(select(HaccpPrintJob).where(
                HaccpPrintJob.scope_key == scope, HaccpPrintJob.label_id == row.id,
            ))
            if existing is not None:
                return _job_response(existing, _job_transport(db, existing))
            station = _station(db, scope)
            if station.last_seen < _now() - timedelta(seconds=30):
                raise HTTPException(409, "Le relais d'impression est hors ligne. Vérifiez qu'il est allumé et connecté.")
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
                return _job_response(existing, _job_transport(db, existing))
            return _job_response(job, _job_transport(db, job))

    @router.post("/prochaine")
    async def claim(
        body: ClaimRequest, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "/prochaine", body)
        if forwarded is not None:
            return forwarded
        with database_errors(db):
            return claim_job(db, scope, str(body.relay_id))

    @router.post("/demandes/{job_id}/confirmation")
    async def acknowledge(
        job_id: uuid.UUID, body: PrintAcknowledgement, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, f"/demandes/{job_id}/confirmation", body)
        if forwarded is not None:
            return forwarded
        with database_errors(db):
            return acknowledge_job(db, scope, str(body.relay_id), job_id, body.status)

    def mobile_kitchen(request: Request, scope: str) -> tuple[str, str]:
        if cloud_link.relay_allowed():
            raise HTTPException(409, "Ouvrez le QR Cuisine sur le site ΣIRIUS, sans relais PC.")
        kitchen = getattr(request.state, "haccp_kitchen", None)
        if kitchen is None:
            raise HTTPException(403, "Impression mobile reservee au QR Cuisine.")
        return _actor(request, scope), kitchen["restaurant_name"]

    def mobile_response(
        db: Session, job: HaccpPrintJob, row: EtiquetteHaccp, actor: str, device_id: uuid.UUID,
    ) -> dict:
        target = db.get(HaccpMobilePrintTarget, job.id)
        response = {"job": _job_response(job, _job_transport(db, job))}
        if (target is not None and target.actor_id == actor and target.device_id == str(device_id)
                and job.status == "pending"):
            response["html"] = construire_etiquette_mobile(_response(row, "/api/haccp/registre"))
        return response

    @router.post("/mobile/demandes")
    async def mobile_enqueue(
        body: MobilePrintRequest, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        actor, restaurant = mobile_kitchen(request, scope)
        if not body.reviewed:
            raise HTTPException(422, "Relisez le produit, les dates et les conditions avant impression.")
        with database_errors(db):
            row = _valid_label(db, scope, body.label_id, restaurant)
            existing = db.scalar(select(HaccpPrintJob).where(
                HaccpPrintJob.scope_key == scope, HaccpPrintJob.label_id == row.id,
            ))
            if existing is not None:
                return mobile_response(db, existing, row, actor, body.device_id)
            job = HaccpPrintJob(
                id=str(uuid.uuid4()), scope_key=scope, label_id=row.id,
                relay_id=str(body.device_id), status="pending", created_at=_now(),
            )
            db.add(job)
            db.add(HaccpMobilePrintTarget(job_id=job.id, device_id=str(body.device_id), actor_id=actor))
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                existing = db.scalar(select(HaccpPrintJob).where(
                    HaccpPrintJob.scope_key == scope, HaccpPrintJob.label_id == row.id,
                ))
                if existing is None:
                    raise
                return mobile_response(db, existing, row, actor, body.device_id)
            return mobile_response(db, job, row, actor, body.device_id)

    @router.post("/mobile/demandes/{job_id}/prise")
    async def mobile_claim(
        job_id: uuid.UUID, body: DeviceIdentity, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        actor, restaurant = mobile_kitchen(request, scope)
        with database_errors(db):
            job = db.scalar(select(HaccpPrintJob).join(
                HaccpMobilePrintTarget, HaccpMobilePrintTarget.job_id == HaccpPrintJob.id,
            ).join(
                EtiquetteHaccp, EtiquetteHaccp.id == HaccpPrintJob.label_id,
            ).where(
                HaccpPrintJob.id == str(job_id), HaccpPrintJob.scope_key == scope,
                EtiquetteHaccp.scope_key == scope, EtiquetteHaccp.restaurant_name == restaurant,
                HaccpMobilePrintTarget.device_id == str(body.device_id),
                HaccpMobilePrintTarget.actor_id == actor,
            ))
            if job is None:
                raise HTTPException(404, "Demande mobile introuvable pour ce telephone.")
            if job.status != "pending":
                return {"job": None, "state": _job_response(job, "mobile")}
            try:
                row = _valid_label(db, scope, job.label_id, restaurant)
                record = _response(row, "/api/haccp/registre")
                now = _now().replace(tzinfo=timezone.utc)
                try:
                    verifier_etiquette_imprimable(record, now)
                except ValueError as error:
                    raise HTTPException(422, str(error)) from error
                valid_for_ms = int((record.dlc_secondaire - now).total_seconds() * 1000)
                if valid_for_ms <= 0:
                    raise HTTPException(422, "DLC depassee : impression d'utilisation refusee.")
                html = construire_etiquette_mobile(record)
            except HTTPException as error:
                db.execute(update(HaccpPrintJob).where(
                    HaccpPrintJob.id == job.id, HaccpPrintJob.status == "pending",
                ).values(status="cancelled", detail=str(error.detail)))
                db.commit()
                db.refresh(job)
                return {"job": None, "state": _job_response(job, "mobile")}
            changed = db.execute(update(HaccpPrintJob).where(
                HaccpPrintJob.id == job.id, HaccpPrintJob.status == "pending",
            ).values(
                status="uncertain", claimed_at=_now(),
                detail="Apercu pret sur le telephone ; sortie papier non confirmee. Verifiez avant toute reimpression.",
            ))
            db.commit()
            db.refresh(job)
            if changed.rowcount != 1:
                return {"job": None, "state": _job_response(job, "mobile")}
            return {"job": _job_response(job, "mobile"), "html": html, "valid_for_ms": valid_for_ms}

    def android_only(request: Request, scope: str) -> str:
        if cloud_link.relay_allowed():
            raise HTTPException(409, "L'impression Android directe utilise le serveur du registre, pas le relais PC.")
        return _actor(request, scope)

    def android_job(db: Session, scope: str, actor: str, job_id: uuid.UUID, device_id: uuid.UUID) -> HaccpPrintJob:
        job = db.scalar(select(HaccpPrintJob).join(
            HaccpAndroidPrintTarget, HaccpAndroidPrintTarget.job_id == HaccpPrintJob.id,
        ).where(
            HaccpPrintJob.id == str(job_id), HaccpPrintJob.scope_key == scope,
            HaccpAndroidPrintTarget.device_id == str(device_id),
            HaccpAndroidPrintTarget.actor_id == actor,
        ))
        if job is None:
            raise HTTPException(404, "Demande directe introuvable pour cet utilisateur et ce telephone.")
        return job

    @router.post("/android/demandes")
    async def android_enqueue(
        body: AndroidPrintRequest, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        actor = android_only(request, scope)
        if not body.reviewed:
            raise HTTPException(422, "Relisez le produit, les dates et les conditions avant impression.")
        with database_errors(db):
            row = _valid_label(db, scope, body.label_id)
            existing = db.scalar(select(HaccpPrintJob).where(
                HaccpPrintJob.scope_key == scope, HaccpPrintJob.label_id == row.id,
            ))
            if existing is not None:
                return _job_response(existing, _job_transport(db, existing))
            job = HaccpPrintJob(
                id=str(uuid.uuid4()), scope_key=scope, label_id=row.id,
                relay_id=str(body.device_id), status="pending", created_at=_now(),
            )
            db.add(job)
            db.add(HaccpAndroidPrintTarget(job_id=job.id, device_id=str(body.device_id), actor_id=actor))
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                existing = db.scalar(select(HaccpPrintJob).where(
                    HaccpPrintJob.scope_key == scope, HaccpPrintJob.label_id == row.id,
                ))
                if existing is None:
                    raise
                return _job_response(existing, _job_transport(db, existing))
            return _job_response(job, "android")

    @router.post("/android/demandes/{job_id}/prise")
    async def android_claim(
        job_id: uuid.UUID, body: DeviceIdentity, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        actor = android_only(request, scope)
        with database_errors(db):
            job = android_job(db, scope, actor, job_id, body.device_id)
            if job.status != "pending":
                return {"job": None, "state": _job_response(job, "android")}
            try:
                row = _valid_label(db, scope, job.label_id)
                payload = _android_payload(row, job.id)
            except HTTPException as error:
                db.execute(update(HaccpPrintJob).where(
                    HaccpPrintJob.id == job.id, HaccpPrintJob.status == "pending",
                ).values(status="cancelled", detail=str(error.detail)))
                db.commit()
                db.refresh(job)
                return {"job": None, "state": _job_response(job, "android")}
            changed = db.execute(update(HaccpPrintJob).where(
                HaccpPrintJob.id == job.id, HaccpPrintJob.status == "pending",
            ).values(status="claimed", claimed_at=_now()))
            db.commit()
            if changed.rowcount != 1:
                return {"job": None}
            return {"job": payload}

    @router.post("/android/demandes/{job_id}/confirmation")
    async def android_acknowledge(
        job_id: uuid.UUID, body: AndroidAcknowledgement, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> dict:
        actor = android_only(request, scope)
        with database_errors(db):
            job = android_job(db, scope, actor, job_id, body.device_id)
            if job.status in {"accepted", "uncertain"}:
                return _job_response(job, "android")
            if job.status != "claimed":
                raise HTTPException(409, "Demande non prise en charge par ce telephone.")
            # Compare-and-set : une confirmation concurrente ne remplace jamais l'incertitude.
            detail = ("SDK Brother sans erreur ; transmission signalee, sortie papier a verifier."
                      if body.status == "accepted" else "Impression Android incertaine ; verifier le papier, aucun nouvel essai automatique.")
            if body.detail:
                detail += " " + body.detail[:250]
            db.execute(update(HaccpPrintJob).where(
                HaccpPrintJob.id == job.id, HaccpPrintJob.status == "claimed",
            ).values(status=body.status, detail=detail[:500],
                     accepted_at=_now() if body.status == "accepted" else None))
            db.commit()
            db.refresh(job)
            return _job_response(job, "android")

    return router
