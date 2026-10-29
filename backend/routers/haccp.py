"""Scan, consultation privee et export du registre des receptions."""
import csv
import io
import logging
import uuid
import hashlib
import json
import os
import re
import unicodedata
from collections.abc import Awaitable, Callable, Iterator
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Path as PathParam, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError
from sqlalchemy import Select, func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
import cloud_link

from haccp_database import get_db
from models.haccp import EtiquetteHaccp
from runtime_paths import data_dir
from schemas.haccp import CategorieProduit, EtiquetteResponse, EtiquetteVisionOutput, OperationCapture
from services.haccp_opening import PARIS, calculer_ouverture, construire_etiquette
from services.haccp_vision import (
    VisionAnalysisError,
    VisionConfigurationError,
    VisionServiceError,
    analyser_etiquette_vision,
)

logger = logging.getLogger(__name__)
MAX_IMAGE_BYTES = 20 * 1024 * 1024
IMAGE_FORMATS = {"image/jpeg": ("JPEG", ".jpg"), "image/png": ("PNG", ".png"), "image/webp": ("WEBP", ".webp")}


def image_directory() -> Path:
    return data_dir() / "storage" / "etiquettes_haccp"


def reception_directory() -> Path:
    return data_dir() / "receptions"


def _filename_part(value: str, limit: int = 60) -> str:
    plain = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", plain).strip("-")[:limit] or "non-lu"


def _reception_path(result: EtiquetteVisionOutput, scope: str, maintenant: datetime, extension: str) -> Path:
    # Le suffixe unique evite toute collision de lots ; le scope n'apparait pas en clair sur disque.
    owner = hashlib.sha256(scope.encode("utf-8")).hexdigest()
    filename = (
        f"{maintenant.astimezone(PARIS):%Y-%m-%d}_"
        f"{_filename_part(result.nom_produit)}_{_filename_part(result.numero_lot, 40)}_{uuid.uuid4().hex}{extension}"
    )
    return reception_directory() / _filename_part(result.categorie) / owner / filename


def validate_image(content: bytes, mime_type: str) -> None:
    try:
        with Image.open(io.BytesIO(content)) as image:
            if image.format != IMAGE_FORMATS[mime_type][0]:
                raise HTTPException(400, "Le format reel de l'image ne correspond pas au type annonce.")
            if image.width * image.height > 25_000_000:
                raise HTTPException(400, "Image trop grande : maximum 25 millions de pixels.")
            image.verify()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
        raise HTTPException(400, "Le fichier ne contient pas une image valide et lisible.") from error


def _write_image(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as destination:
        destination.write(content)
        destination.flush()
        os.fsync(destination.fileno())


def _response(row: EtiquetteHaccp, photo_prefix: str) -> EtiquetteResponse:
    values = {name: getattr(row, name) for name in EtiquetteVisionOutput.model_fields}
    return EtiquetteResponse(
        **values, id=row.id, created_at=row.created_at, operateur=row.operateur,
        image_url=f"{photo_prefix}/{row.id}/photo",
        **{name: getattr(row, name) for name in OperationCapture.model_fields},
        date_ouverture=row.date_ouverture, dlc_secondaire=row.dlc_secondaire,
        chemin_photo=row.image_path,
        chemin_donnees=f"haccp.sqlite3#etiquettes_haccp/{row.id}",
        donnees_url=f"{photo_prefix}/{row.id}/donnees",
        fournisseur=row.fournisseur_ou_marque,
        dlc_dluo=row.dlc_ou_ddm,
        date_reception=row.created_at if row.type_operation == "reception" else None,
    )


def _save_record(
    db: Session, result: EtiquetteVisionOutput, scope: str, operateur: str,
    relative_path: str, photo_prefix: str,
    operation: OperationCapture, maintenant: datetime, limite: datetime | None,
    capture_id: str | None, capture_hash: str,
) -> EtiquetteResponse:
    row = EtiquetteHaccp(
        **result.model_dump(), scope_key=scope, operateur=operateur, image_path=relative_path,
        **operation.model_dump(),
        date_ouverture=maintenant.replace(tzinfo=None) if operation.type_operation == "ouverture" else None,
        dlc_secondaire=limite.replace(tzinfo=None) if limite else None,
        capture_id=capture_id, capture_hash=capture_hash,
        created_at=maintenant.replace(tzinfo=None),
    )
    try:
        db.add(row)
        db.flush()
        response = _response(row, photo_prefix)
        db.commit()
        return response
    except SQLAlchemyError:
        db.rollback()
        raise


def _query(
    scope: str, date_debut: date | None, date_fin: date | None,
    terme: str | None = None, non_conforme_seul: bool = False,
    categorie: CategorieProduit | None = None,
) -> Select[tuple[EtiquetteHaccp]]:
    if date_debut and date_fin and date_debut > date_fin:
        raise HTTPException(422, "La date de debut doit preceder ou egaler la date de fin.")
    statement = select(EtiquetteHaccp).where(EtiquetteHaccp.scope_key == scope)
    if date_debut:
        statement = statement.where(EtiquetteHaccp.created_at >= datetime.combine(date_debut, time.min))
    if date_fin and date_fin != date.max:
        statement = statement.where(
            EtiquetteHaccp.created_at < datetime.combine(date_fin + timedelta(days=1), time.min),
        )
    if terme and terme.strip():
        # Les caracteres SQL % et _ sont recherches litteralement.
        statement = statement.where(or_(*[
            func.haccp_casefold(column).contains(terme.strip().casefold(), autoescape=True)
            for column in (
                EtiquetteHaccp.numero_lot, EtiquetteHaccp.nom_produit,
                EtiquetteHaccp.fournisseur_ou_marque, EtiquetteHaccp.agrement_sanitaire,
            )
        ]))
    if non_conforme_seul:
        statement = statement.where(EtiquetteHaccp.conforme_reception.is_(False))
    if categorie is not None:
        statement = statement.where(EtiquetteHaccp.categorie == categorie)
    return statement.order_by(EtiquetteHaccp.created_at.desc(), EtiquetteHaccp.id.desc())


def _existing_capture(db: Session, scope: str, capture_id: str | None, digest: str, prefix: str) -> EtiquetteResponse | None:
    if capture_id is None:
        return None
    row = db.scalar(select(EtiquetteHaccp).where(
        EtiquetteHaccp.scope_key == scope, EtiquetteHaccp.capture_id == capture_id,
    ))
    if row is None:
        return None
    if row.capture_hash != digest:
        raise HTTPException(409, "Cette capture est deja archivee avec un contenu different. "
                            "Reprenez une photo pour creer une nouvelle fiche.")
    return _response(row, prefix)


CSV_COLUMNS = [
    "id", "created_at", "nom_produit", "fournisseur_ou_marque", "numero_lot",
    "dlc_ou_ddm", "type_date", "agrement_sanitaire", "temperature_stockage",
    "allergenes", "conforme_reception", "commentaire_anomalie", "operateur", "image_url",
    "type_operation", "date_ouverture", "dlc_secondaire", "duree_conservation_heures",
    "justification_duree", "regle_confirmee",
    "categorie", "date_reception", "temperature_conforme", "chemin_photo", "chemin_donnees",
]


def _csv_cell(value: object) -> str:
    text = "" if value is None else str(value)
    if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r", "\n")):
        return "'" + text
    return text


def _csv_lines(records: list[EtiquetteResponse]) -> Iterator[str]:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
    writer.writerow(CSV_COLUMNS)
    yield "\ufeff" + buffer.getvalue()
    for record in records:
        buffer.seek(0)
        buffer.truncate(0)
        values = record.model_dump(mode="json")
        values["allergenes"] = ", ".join(record.allergenes)
        values["conforme_reception"] = "Oui" if record.conforme_reception else "Non"
        writer.writerow([_csv_cell(values[column]) for column in CSV_COLUMNS])
        yield buffer.getvalue()


def make_haccp_router(resolve_scope: Callable[[Request], Awaitable[str]]) -> APIRouter:
    router = APIRouter(prefix="/haccp", tags=["haccp-etiquettes"])

    @router.post("/etiquettes/scan", response_model=EtiquetteResponse, status_code=201)
    async def scan(
        request: Request,
        file: UploadFile = File(...),
        operateur: Annotated[str, Form(max_length=100)] = "Cuisine",
        operation: Annotated[str, Form(max_length=2000)] = "{}",
        capture_id: Annotated[uuid.UUID | None, Form()] = None,
        scope: str = Depends(resolve_scope),
        db: Session = Depends(get_db),
    ) -> EtiquetteResponse:
        mime_type = (file.content_type or "").split(";", 1)[0].strip().lower()
        if mime_type not in IMAGE_FORMATS:
            raise HTTPException(400, "Formats autorises : JPEG, PNG et WebP.")
        if not operateur.strip():
            raise HTTPException(422, "Le nom de l'operateur ne peut pas etre vide.")
        try:
            capture = OperationCapture.model_validate_json(operation)
        except ValidationError as error:
            raise HTTPException(422, "Operation invalide : fournissez une duree en heures entieres, "
                                "une justification fabricant/PMS et la confirmation de la regle, "
                                "ou archivez l'ouverture sans regle.") from error
        maintenant = datetime.now(timezone.utc)
        content = await file.read(MAX_IMAGE_BYTES + 1)
        if not content:
            raise HTTPException(400, "L'image est vide.")
        if len(content) > MAX_IMAGE_BYTES:
            raise HTTPException(400, "L'image ne doit pas depasser 20 Mo.")
        await run_in_threadpool(validate_image, content, mime_type)
        if cloud_link.relay_allowed():
            response = await cloud_link.relay_haccp_registry(
                "POST", "/etiquettes/scan",
                files={"file": ("etiquette" + IMAGE_FORMATS[mime_type][1], content, mime_type)},
                data={"operateur": operateur.strip(), "operation": capture.model_dump_json(),
                      **({"capture_id": str(capture_id)} if capture_id else {})},
            )
            return EtiquetteResponse.model_validate(response.json())
        filename = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f") + "_" + uuid.uuid4().hex + IMAGE_FORMATS[mime_type][1]
        path = image_directory() / filename
        saved = False
        prefix = str(request.url_for("haccp_search")).removesuffix("/recherche")
        digest = hashlib.sha256(
            content + json.dumps(
                {"operation": capture.model_dump(), "operateur": operateur.strip()},
                sort_keys=True, ensure_ascii=False,
            ).encode("utf-8"),
        ).hexdigest()
        capture_key = str(capture_id) if capture_id else None
        try:
            previous = await run_in_threadpool(_existing_capture, db, scope, capture_key, digest, prefix)
            if previous is not None:
                return previous
            await run_in_threadpool(_write_image, path, content)
            result = await analyser_etiquette_vision(content, mime_type)
            try:
                result, limite = calculer_ouverture(result, capture, maintenant)
            except ValueError as error:
                raise HTTPException(422, str(error)) from error
            if capture.type_operation == "reception":
                classified = _reception_path(result, scope, maintenant, IMAGE_FORMATS[mime_type][1])
                await run_in_threadpool(classified.parent.mkdir, parents=True, exist_ok=True)
                await run_in_threadpool(path.rename, classified)
                path = classified
            relative_path = path.relative_to(data_dir()).as_posix()
            try:
                response = await run_in_threadpool(
                    _save_record, db, result, scope, operateur.strip(),
                    relative_path, prefix,
                    capture, maintenant, limite, capture_key, digest,
                )
            except IntegrityError:
                previous = await run_in_threadpool(_existing_capture, db, scope, capture_key, digest, prefix)
                if previous is None:
                    raise
                return previous
            saved = True
            return response
        except VisionConfigurationError as error:
            raise HTTPException(500, str(error)) from error
        except VisionServiceError as error:
            raise HTTPException(500, str(error)) from error
        except VisionAnalysisError as error:
            raise HTTPException(422, str(error)) from error
        except (OSError, SQLAlchemyError) as error:
            logger.exception("[HACCP] Archivage de l'etiquette impossible")
            raise HTTPException(500, "L'etiquette n'a pas pu etre archivee. Reessayez.") from error
        finally:
            if not saved:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    logger.exception("[HACCP] Nettoyage de la photo non archivee impossible")

    @router.get("/registre/recherche", response_model=list[EtiquetteResponse], name="haccp_search")
    async def recherche(
        request: Request,
        terme: Annotated[str | None, Query(max_length=255)] = None,
        date_debut: date | None = None,
        date_fin: date | None = None,
        non_conforme_seul: bool = False,
        categorie: CategorieProduit | None = None,
        scope: str = Depends(resolve_scope),
        db: Session = Depends(get_db),
    ) -> list[EtiquetteResponse]:
        statement = _query(scope, date_debut, date_fin, terme, non_conforme_seul, categorie)
        if cloud_link.relay_allowed():
            response = await cloud_link.relay_haccp_registry(
                "GET", "/registre/recherche", params=dict(request.query_params),
            )
            return [EtiquetteResponse.model_validate(record) for record in response.json()]
        try:
            return await run_in_threadpool(lambda: [
                _response(row, str(request.url_for("haccp_search")).removesuffix("/recherche"))
                for row in db.scalars(statement)
            ])
        except SQLAlchemyError as error:
            logger.exception("[HACCP] Recherche impossible")
            raise HTTPException(500, "La recherche dans le registre a echoue.") from error

    @router.get("/registre/export-csv")
    async def export_csv(
        request: Request,
        date_debut: date | None = None,
        date_fin: date | None = None,
        scope: str = Depends(resolve_scope),
        db: Session = Depends(get_db),
    ) -> StreamingResponse:
        statement = _query(scope, date_debut, date_fin)
        if cloud_link.relay_allowed():
            response = await cloud_link.relay_haccp_registry(
                "GET", "/registre/export-csv", params=dict(request.query_params),
            )
            return StreamingResponse(iter([response.content]), media_type="text/csv; charset=utf-8",
                                     headers={"Content-Disposition": 'attachment; filename="registre-haccp.csv"',
                                              "Cache-Control": "private, no-store"})
        try:
            records = await run_in_threadpool(lambda: [
                _response(row, str(request.url_for("haccp_search")).removesuffix("/recherche"))
                for row in db.scalars(statement)
            ])
        except SQLAlchemyError as error:
            logger.exception("[HACCP] Export impossible")
            raise HTTPException(500, "L'export du registre a echoue.") from error
        return StreamingResponse(
            _csv_lines(records), media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="registre-haccp.csv"',
                     "Cache-Control": "private, no-store"},
        )

    @router.get("/registre/{id}/etiquette", response_class=HTMLResponse)
    async def etiquette(
        id: Annotated[int, PathParam(ge=1)],
        scope: str = Depends(resolve_scope),
        db: Session = Depends(get_db),
    ) -> HTMLResponse:
        if cloud_link.relay_allowed():
            response = await cloud_link.relay_haccp_registry("GET", f"/registre/{id}/etiquette")
            return HTMLResponse(response.text, headers={"Cache-Control": "private, no-store",
                                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"})
        try:
            row = await run_in_threadpool(db.scalar, select(EtiquetteHaccp).where(
                EtiquetteHaccp.id == id, EtiquetteHaccp.scope_key == scope,
            ))
        except SQLAlchemyError as error:
            logger.exception("[HACCP] Lecture de l'etiquette d'ouverture impossible")
            raise HTTPException(500, "L'etiquette d'ouverture est indisponible.") from error
        if row is None:
            raise HTTPException(404, "Etiquette introuvable.")
        if row.type_operation != "ouverture" or not row.dlc_secondaire or not row.conforme_reception:
            raise HTTPException(422, "Aucune etiquette d'utilisation : regle ou verification manquante, "
                                "ou anomalie sur l'ouverture.")
        record = _response(row, "/api/haccp/registre")
        if record.dlc_secondaire is not None and record.dlc_secondaire <= datetime.now(timezone.utc):
            raise HTTPException(422, "DLC secondaire depassee : impression d'utilisation refusee.")
        return HTMLResponse(construire_etiquette(record), headers={
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
            "X-Content-Type-Options": "nosniff",
        })

    @router.get("/registre/{id}/photo", name="haccp_photo", response_model=None)
    async def photo(
        id: Annotated[int, PathParam(ge=1)],
        scope: str = Depends(resolve_scope),
        db: Session = Depends(get_db),
    ) -> Response:
        if cloud_link.relay_allowed():
            response = await cloud_link.relay_haccp_registry("GET", f"/registre/{id}/photo")
            return Response(response.content, media_type=response.headers.get("content-type", "application/octet-stream"),
                            headers={"Cache-Control": "private, no-store"})
        try:
            row = await run_in_threadpool(db.scalar, select(EtiquetteHaccp).where(
                EtiquetteHaccp.id == id, EtiquetteHaccp.scope_key == scope,
            ))
        except SQLAlchemyError as error:
            logger.exception("[HACCP] Lecture de photo impossible")
            raise HTTPException(500, "La lecture du registre a echoue.") from error
        if row is None:
            raise HTTPException(404, "Etiquette introuvable.")
        roots = (image_directory().resolve(), reception_directory().resolve())
        path = (data_dir() / row.image_path).resolve()
        if not any(path.is_relative_to(root) for root in roots) or not path.is_file():
            logger.error("[HACCP] Photo archivee absente ou chemin invalide (id=%s)", id)
            raise HTTPException(404, "La photo originale est introuvable sur disque.")
        mime_type = next((mime for mime, (_, ext) in IMAGE_FORMATS.items() if ext == path.suffix), None)
        return FileResponse(path, media_type=mime_type, headers={"Cache-Control": "private, no-store"})

    @router.get("/registre/{id}/donnees", response_model=EtiquetteResponse)
    async def donnees(
        id: Annotated[int, PathParam(ge=1)],
        request: Request,
        response: Response,
        scope: str = Depends(resolve_scope),
        db: Session = Depends(get_db),
    ) -> EtiquetteResponse:
        response.headers["Cache-Control"] = "private, no-store"
        if cloud_link.relay_allowed():
            forwarded = await cloud_link.relay_haccp_registry("GET", f"/registre/{id}/donnees")
            return EtiquetteResponse.model_validate(forwarded.json())
        try:
            row = await run_in_threadpool(db.scalar, select(EtiquetteHaccp).where(
                EtiquetteHaccp.id == id, EtiquetteHaccp.scope_key == scope,
            ))
        except SQLAlchemyError as error:
            logger.exception("[HACCP] Lecture des metadonnees impossible")
            raise HTTPException(500, "Les metadonnees de reception sont indisponibles.") from error
        if row is None:
            raise HTTPException(404, "Etiquette introuvable.")
        return _response(row, str(request.url_for("haccp_search")).removesuffix("/recherche"))

    return router
