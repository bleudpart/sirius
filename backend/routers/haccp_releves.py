"""Relevés manuscrits et relais d'impression Word du poste Windows."""

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated, Awaitable, Callable, Literal
from zipfile import BadZipFile

from docx.opc.exceptions import PackageNotFoundError
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, StringConstraints
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

import cloud_link
from haccp_database import get_db
from models.haccp import EtiquetteHaccp
from models.haccp_printing import HaccpRelevePrintJob, HaccpRelevePrintStation
from routers.haccp import image_directory, reception_directory
from routers.haccp_printing import database_errors
from runtime_paths import data_dir
from schemas.haccp_releves import FORMS, ReleveInput, validate_fields
from services.haccp_signature import decode_signature
from services.haccp_word import print_haccp_document
from work_draft_recordings import digest, insert_once


logger = logging.getLogger(__name__)
NATURE = "releve_haccp_signe"


class RelayIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    relay_id: uuid.UUID


class PrintRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: uuid.UUID
    previous_job_id: uuid.UUID | None = None


class PrintConfirmation(RelayIdentity):
    status: Literal["accepted", "uncertain"]
    detail: Annotated[str, StringConstraints(max_length=500)] = ""


def _scope_filter(scope: str) -> dict[str, str]:
    prefix, separator, identity = scope.partition(":")
    if not separator or not identity or prefix not in {"user", "company"}:
        raise HTTPException(500, "Périmètre HACCP invalide.")
    return {f"{prefix}_id": identity}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _job_response(job: HaccpRelevePrintJob) -> dict:
    return {"id": job.id, "releve_id": job.releve_id, "status": job.status, "detail": job.detail}


def _public_record(row: dict, *, include_signature: bool = False) -> dict:
    hidden = {"_id", "user_id", "company_id", "created_by", "request_digest", "snapshot_digest"}
    if not include_signature:
        hidden.add("signature_image")
    return {key: value for key, value in row.items() if key not in hidden}


def _payload_digest(record: dict) -> str:
    return digest({key: record[key] for key in (
        "type_releve", "etablissement", "operateur", "champs", "signature_image",
    )})


def _snapshot_digest(record: dict) -> str:
    return digest({key: record[key] for key in (
        "id", "type_releve", "titre", "etablissement", "operateur", "created_at",
        "champs", "colonnes", "lignes", "signature_image",
    )})


def _record_filter(request: Request, scope: str) -> dict[str, str]:
    filters = _scope_filter(scope)
    kitchen = getattr(request.state, "haccp_kitchen", None)
    if kitchen:
        filters["etablissement"] = kitchen["restaurant_name"]
    return filters


async def _find_record(docstore, request: Request, scope: str, identity: str) -> dict:
    row = await docstore.haccp_sheets.find_one({
        **_record_filter(request, scope), "id": identity, "nature": NATURE,
    }, {"_id": 0})
    if not row:
        raise HTTPException(404, "Relevé introuvable.")
    return row


def _check_record(row: dict) -> None:
    try:
        if row.get("request_digest") != _payload_digest(row) or row.get("snapshot_digest") != _snapshot_digest(row):
            raise ValueError("Le contenu du relevé ne correspond plus à la version signée.")
        decode_signature(row["signature_image"])
    except (KeyError, TypeError, ValueError) as error:
        raise HTTPException(409, "Relevé signé illisible ou modifié ; impression refusée.") from error


def _check_photo(session: Session, scope: str, identity: str, establishment: str) -> None:
    row = session.scalar(select(EtiquetteHaccp).where(
        EtiquetteHaccp.id == int(identity), EtiquetteHaccp.scope_key == scope,
    ))
    if row is None or (row.restaurant_name and row.restaurant_name != establishment):
        raise HTTPException(422, "Étiquette introuvable pour cet établissement.")
    roots = (
        image_directory().resolve(),
        reception_directory().resolve(),
        (data_dir() / "uploads").resolve(),
    )
    path = (data_dir() / row.image_path).resolve()
    if not any(path.is_relative_to(root) for root in roots) or not path.is_file():
        raise HTTPException(422, "La photo de cette étiquette n'est plus disponible.")


def _station(session: Session, scope: str, relay_id: str | None = None) -> HaccpRelevePrintStation:
    station = session.get(HaccpRelevePrintStation, scope)
    if station is None:
        raise HTTPException(409, "Ouvrez ΣIRIUS sur le PC Windows relié au même compte.")
    if relay_id is not None and station.relay_id != relay_id:
        raise HTTPException(409, "Un autre PC est associé à l'impression des relevés.")
    return station


def make_haccp_releves_router(
    docstore,
    resolve_scope: Callable[[Request], Awaitable[str]],
    is_direct_local: Callable[[Request], bool],
) -> APIRouter:
    router = APIRouter(prefix="/haccp/releves", tags=["releves-haccp"])

    async def proxy(request: Request, method: str, path: str, body: BaseModel | None = None) -> dict | None:
        if not cloud_link.relay_allowed():
            return None
        if not is_direct_local(request):
            raise HTTPException(403, "Le relais des relevés est réservé à ce PC.")
        if not cloud_link.linked():
            raise HTTPException(409, "Reliez d'abord le PC au compte ΣIRIUS Cloud.")
        response = await cloud_link.relay_haccp_registry(
            method, "/releves" + path,
            **({"json": body.model_dump(mode="json")} if body is not None else {}),
        )
        try:
            result = response.json()
        except ValueError as error:
            raise HTTPException(502, "Réponse des relevés Cloud illisible.") from error
        if not isinstance(result, dict):
            raise HTTPException(502, "Réponse des relevés Cloud invalide.")
        return result

    @router.get("/modeles")
    async def models(request: Request, scope: str = Depends(resolve_scope)) -> dict:
        forwarded = await proxy(request, "GET", "/modeles")
        if forwarded is not None:
            return forwarded
        return {"modeles": [{"id": key, **value} for key, value in FORMS.items()]}

    @router.get("")
    async def list_records(request: Request, scope: str = Depends(resolve_scope)) -> dict:
        forwarded = await proxy(request, "GET", "")
        if forwarded is not None:
            return forwarded
        rows = await docstore.haccp_sheets.find(
            {**_record_filter(request, scope), "nature": NATURE}, {"_id": 0},
        ).sort("created_at", -1).to_list(101)
        return {"items": [_public_record(row) for row in rows[:100]], "truncated": len(rows) > 100}

    @router.post("")
    async def save_record(
        body: ReleveInput, request: Request,
        scope: str = Depends(resolve_scope), session: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "POST", "", body)
        if forwarded is not None:
            return forwarded
        try:
            fields = validate_fields(body.type_releve, body.champs)
            decode_signature(body.signature_image)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        kitchen = getattr(request.state, "haccp_kitchen", None)
        if kitchen and body.etablissement != kitchen["restaurant_name"]:
            raise HTTPException(422, "L'établissement ne correspond pas au QR cuisine.")
        definition = FORMS[body.type_releve]
        identity = {**_scope_filter(scope), "id": str(body.capture_id)}
        record = {
            **identity,
            "nature": NATURE,
            "modele": f"releve_{body.type_releve}",
            "type_releve": body.type_releve,
            "titre": definition["titre"],
            "etablissement": body.etablissement,
            "operateur": body.operateur,
            "champs": fields,
            "colonnes": [item["label"] for item in definition["champs"]],
            "lignes": [[fields[item["key"]] for item in definition["champs"]]],
            "signature_image": body.signature_image,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "created_by": getattr(request.state, "haccp_actor", ""),
            "source": "qr_cuisine" if kitchen else "compte",
        }
        record["request_digest"] = _payload_digest(record)
        record["snapshot_digest"] = _snapshot_digest(record)
        existing = await docstore.haccp_sheets.find_one({**identity, "nature": NATURE}, {"_id": 0})
        if existing:
            _check_record(existing)
            if existing.get("request_digest") != record["request_digest"]:
                raise HTTPException(409, "Cet identifiant correspond déjà à un autre relevé.")
            return {"releve": _public_record(existing)}
        photo_id = fields.get("etiquette_id", "")
        if photo_id:
            _check_photo(session, scope, photo_id, body.etablissement)
        saved, created = await insert_once(docstore, "haccp_sheets", record, identity=identity)
        if not created and (saved.get("nature") != NATURE or saved.get("request_digest") != record["request_digest"]):
            raise HTTPException(409, "Cet identifiant correspond déjà à un autre relevé.")
        if not created:
            _check_record(saved)
        return {"releve": _public_record(saved)}

    @router.get("/impression/{job_id}")
    async def print_state(
        job_id: uuid.UUID, request: Request,
        scope: str = Depends(resolve_scope), session: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "GET", f"/impression/{job_id}")
        if forwarded is not None:
            return forwarded
        with database_errors(session):
            job = session.scalar(select(HaccpRelevePrintJob).where(
                HaccpRelevePrintJob.id == str(job_id), HaccpRelevePrintJob.scope_key == scope,
            ))
            if job is None:
                raise HTTPException(404, "Demande d'impression introuvable.")
            await _find_record(docstore, request, scope, job.releve_id)
            session.execute(update(HaccpRelevePrintJob).where(
                HaccpRelevePrintJob.id == str(job_id), HaccpRelevePrintJob.scope_key == scope,
                HaccpRelevePrintJob.status == "claimed",
                HaccpRelevePrintJob.claimed_at < _now() - timedelta(minutes=2),
            ).values(status="uncertain", detail="Confirmation absente. Vérifiez le papier avant toute nouvelle demande."))
            session.commit()
            session.refresh(job)
            return _job_response(job)

    @router.post("/impression/{job_id}/annulation")
    async def cancel_pending(
        job_id: uuid.UUID, request: Request,
        scope: str = Depends(resolve_scope), session: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "POST", f"/impression/{job_id}/annulation")
        if forwarded is not None:
            return forwarded
        with database_errors(session):
            job = session.scalar(select(HaccpRelevePrintJob).where(
                HaccpRelevePrintJob.id == str(job_id), HaccpRelevePrintJob.scope_key == scope,
            ))
            if job is None:
                raise HTTPException(404, "Demande d'impression introuvable.")
            await _find_record(docstore, request, scope, job.releve_id)
            if job.status == "cancelled":
                return _job_response(job)
            changed = session.execute(update(HaccpRelevePrintJob).where(
                HaccpRelevePrintJob.id == str(job_id), HaccpRelevePrintJob.scope_key == scope,
                HaccpRelevePrintJob.status == "pending",
            ).values(status="cancelled", detail="Demande annulée avant transmission au PC."))
            session.commit()
            session.refresh(job)
            if changed.rowcount != 1 and job.status != "cancelled":
                raise HTTPException(409, "La demande est déjà prise en charge. Vérifiez la sortie papier.")
            return _job_response(job)

    @router.post("/impression/poste")
    async def configure_station(
        body: RelayIdentity, request: Request,
        scope: str = Depends(resolve_scope), session: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "POST", "/impression/poste", body)
        if forwarded is not None:
            return forwarded
        with database_errors(session):
            station = session.get(HaccpRelevePrintStation, scope)
            if station and station.relay_id != str(body.relay_id):
                raise HTTPException(409, "Un autre PC est déjà associé à l'impression des relevés.")
            if station is None:
                station = HaccpRelevePrintStation(scope_key=scope, relay_id=str(body.relay_id))
                session.add(station)
            station.last_seen = _now()
            try:
                session.commit()
            except IntegrityError:
                session.rollback()
                station = session.get(HaccpRelevePrintStation, scope)
                if station is None or station.relay_id != str(body.relay_id):
                    raise HTTPException(409, "Un autre PC est déjà associé à l'impression des relevés.")
                station.last_seen = _now()
                session.commit()
        return {"configured": True}

    @router.post("/impression/prochaine")
    async def claim(
        body: RelayIdentity, request: Request,
        scope: str = Depends(resolve_scope), session: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "POST", "/impression/prochaine", body)
        if forwarded is not None:
            return forwarded
        with database_errors(session):
            station = _station(session, scope, str(body.relay_id))
            station.last_seen = _now()
            session.commit()
            job = session.scalar(select(HaccpRelevePrintJob).where(
                HaccpRelevePrintJob.scope_key == scope, HaccpRelevePrintJob.relay_id == station.relay_id,
                HaccpRelevePrintJob.status == "pending",
            ).order_by(HaccpRelevePrintJob.created_at, HaccpRelevePrintJob.id).limit(1))
            if job is None:
                return {"job": None}
            updated = session.execute(update(HaccpRelevePrintJob).where(
                HaccpRelevePrintJob.id == job.id, HaccpRelevePrintJob.status == "pending",
            ).values(status="claimed", claimed_at=_now()))
            session.commit()
            if updated.rowcount != 1:
                return {"job": None}
            try:
                row = await _find_record(docstore, request, scope, job.releve_id)
                _check_record(row)
            except HTTPException as error:
                session.execute(update(HaccpRelevePrintJob).where(
                    HaccpRelevePrintJob.id == job.id, HaccpRelevePrintJob.status == "claimed",
                ).values(status="cancelled", detail=str(error.detail)))
                session.commit()
                return {"job": None}
            return {"job": {"id": job.id, "releve": _public_record(row, include_signature=True)}}

    @router.post("/impression/{job_id}/confirmation")
    async def acknowledge(
        job_id: uuid.UUID, body: PrintConfirmation, request: Request,
        scope: str = Depends(resolve_scope), session: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "POST", f"/impression/{job_id}/confirmation", body)
        if forwarded is not None:
            return forwarded
        with database_errors(session):
            _station(session, scope, str(body.relay_id))
            job = session.scalar(select(HaccpRelevePrintJob).where(
                HaccpRelevePrintJob.id == str(job_id), HaccpRelevePrintJob.scope_key == scope,
                HaccpRelevePrintJob.relay_id == str(body.relay_id),
            ))
            if job is None:
                raise HTTPException(404, "Demande d'impression introuvable.")
            if job.status in {"accepted", "uncertain"}:
                return _job_response(job)
            if job.status != "claimed":
                raise HTTPException(409, "Cette demande n'a pas été prise en charge par le PC.")
            detail = (
                "Commande transmise à Windows ; vérifiez la sortie papier."
                if body.status == "accepted"
                else "Impression incertaine ; vérifiez le papier avant toute nouvelle demande."
            )
            if body.detail:
                detail += " " + body.detail[:250]
            session.execute(update(HaccpRelevePrintJob).where(
                HaccpRelevePrintJob.id == job.id, HaccpRelevePrintJob.status == "claimed",
            ).values(status=body.status, detail=detail[:500]))
            session.commit()
            session.refresh(job)
            return _job_response(job)

    @router.post("/impression/traiter")
    async def process_on_windows(
        body: RelayIdentity, request: Request, scope: str = Depends(resolve_scope),
    ) -> dict:
        if os.name != "nt" or not cloud_link.relay_allowed() or not is_direct_local(request):
            raise HTTPException(403, "L'impression Word est réservée au PC Windows local.")
        await proxy(request, "POST", "/impression/poste", body)
        response = await proxy(request, "POST", "/impression/prochaine", body)
        job = response.get("job") if response else None
        if job is None:
            return {"job": None}
        job_id = None
        try:
            job_id = uuid.UUID(job["id"])
            record = job["releve"]
            if not isinstance(record, dict):
                raise ValueError("Relevé reçu invalide.")
            await run_in_threadpool(print_haccp_document, record, job_id)
        except (KeyError, TypeError, ValueError, OSError, PackageNotFoundError, BadZipFile) as error:
            logger.warning("[HACCP-WORD] Impression non confirmée : %s", error)
            if job_id is None:
                raise HTTPException(502, "Demande Cloud invalide ; vérifiez le poste.") from error
            confirmation = PrintConfirmation(
                relay_id=body.relay_id, status="uncertain", detail=str(error)[:250],
            )
            try:
                await proxy(request, "POST", f"/impression/{job_id}/confirmation", confirmation)
            except HTTPException as failure:
                raise HTTPException(502, "Confirmation perdue. Vérifiez le papier ; aucune réimpression automatique.") from failure
            raise HTTPException(502, f"Impression non confirmée : {error}") from error
        confirmation = PrintConfirmation(relay_id=body.relay_id, status="accepted")
        try:
            result = await proxy(request, "POST", f"/impression/{job_id}/confirmation", confirmation)
        except HTTPException as error:
            raise HTTPException(502, "Commande lancée mais confirmation perdue. Vérifiez le papier.") from error
        return {"job": result}

    @router.post("/{identity}/impression")
    async def enqueue(
        identity: uuid.UUID, body: PrintRequest, request: Request,
        scope: str = Depends(resolve_scope), session: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "POST", f"/{identity}/impression", body)
        if forwarded is not None:
            return forwarded
        row = await _find_record(docstore, request, scope, str(identity))
        _check_record(row)

        def create_job() -> dict:
            with database_errors(session):
                try:
                    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
                    existing = session.get(HaccpRelevePrintJob, str(body.id))
                    if existing:
                        if existing.scope_key != scope or existing.releve_id != str(identity):
                            raise HTTPException(409, "Cet identifiant d'impression est déjà utilisé.")
                        return _job_response(existing)
                    latest = session.scalar(select(HaccpRelevePrintJob).where(
                        HaccpRelevePrintJob.scope_key == scope, HaccpRelevePrintJob.releve_id == str(identity),
                    ).order_by(HaccpRelevePrintJob.created_at.desc(), HaccpRelevePrintJob.id.desc()).limit(1))
                    if latest is not None and str(body.previous_job_id or "") != latest.id:
                        return _job_response(latest)
                    if latest is None and body.previous_job_id is not None:
                        raise HTTPException(409, "L'historique d'impression a changé. Vérifiez le relevé.")
                    if latest is not None and latest.status in {"pending", "claimed"}:
                        return _job_response(latest)
                    station = _station(session, scope)
                    if station.last_seen < _now() - timedelta(seconds=30):
                        raise HTTPException(409, "Le PC d'impression est hors ligne. Ouvrez ΣIRIUS Windows.")
                    job = HaccpRelevePrintJob(
                        id=str(body.id), scope_key=scope, relay_id=station.relay_id,
                        releve_id=str(identity), status="pending", created_at=_now(),
                    )
                    session.add(job)
                    try:
                        session.commit()
                    except IntegrityError:
                        session.rollback()
                        existing = session.get(HaccpRelevePrintJob, str(body.id))
                        if existing is not None:
                            if existing.scope_key != scope or existing.releve_id != str(identity):
                                raise HTTPException(409, "Cet identifiant d'impression est déjà utilisé.")
                            return _job_response(existing)
                        active = session.scalar(select(HaccpRelevePrintJob).where(
                            HaccpRelevePrintJob.scope_key == scope, HaccpRelevePrintJob.releve_id == str(identity),
                            HaccpRelevePrintJob.status.in_(["pending", "claimed"]),
                        ))
                        if active is None:
                            raise
                        return _job_response(active)
                    return _job_response(job)
                finally:
                    session.rollback()

        return await run_in_threadpool(create_job)

    @router.get("/{identity}/impression")
    async def latest_print(
        identity: uuid.UUID, request: Request,
        scope: str = Depends(resolve_scope), session: Session = Depends(get_db),
    ) -> dict:
        forwarded = await proxy(request, "GET", f"/{identity}/impression")
        if forwarded is not None:
            return forwarded
        await _find_record(docstore, request, scope, str(identity))
        with database_errors(session):
            session.execute(update(HaccpRelevePrintJob).where(
                HaccpRelevePrintJob.scope_key == scope, HaccpRelevePrintJob.releve_id == str(identity),
                HaccpRelevePrintJob.status == "claimed",
                HaccpRelevePrintJob.claimed_at < _now() - timedelta(minutes=2),
            ).values(status="uncertain", detail="Confirmation absente. Vérifiez le papier avant toute nouvelle demande."))
            session.commit()
            job = session.scalar(select(HaccpRelevePrintJob).where(
                HaccpRelevePrintJob.scope_key == scope, HaccpRelevePrintJob.releve_id == str(identity),
            ).order_by(HaccpRelevePrintJob.created_at.desc(), HaccpRelevePrintJob.id.desc()).limit(1))
            return {"job": _job_response(job) if job else None}

    @router.get("/{identity}")
    async def get_record(
        identity: uuid.UUID, request: Request, scope: str = Depends(resolve_scope),
    ) -> dict:
        forwarded = await proxy(request, "GET", f"/{identity}")
        if forwarded is not None:
            return forwarded
        row = await _find_record(docstore, request, scope, str(identity))
        _check_record(row)
        return {"releve": _public_record(row, include_signature=True)}

    return router
