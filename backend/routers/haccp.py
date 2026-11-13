"""Scan, preparations declarees, consultation privee et export du registre."""
import asyncio
import csv
import io
import logging
import uuid
import hashlib
import json
import os
import re
import sqlite3
import unicodedata
from collections.abc import Awaitable, Callable, Iterator
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from PIL import Image, ImageOps, UnidentifiedImageError
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Path as PathParam, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from pydantic import ValidationError
from sqlalchemy import Select, func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
import cloud_link

from haccp_database import get_db, get_engine
from haccp_activity import HaccpActivity, load_activity
from haccp_closing import (
    ClosingPdfRequest, ClosingReport, generate_closing_pdf, load_closing_report,
)
from models.haccp import EtiquetteHaccp
from runtime_paths import data_dir
from schemas.haccp import (
    CategorieProduit, EtiquetteResponse, EtiquetteVisionOutput, OperationCapture, OperationEtiquette, PreparationCreate,
)
from schemas.haccp_reception import ImageArchivee
from services.haccp_images import IMAGE_FORMATS, MAX_IMAGE_BYTES, ImageValidationError, validate_source_image
from services.haccp_opening import (
    PARIS, calculer_ouverture, calculer_preparation, construire_etiquette, verifier_etiquette_imprimable,
)
from services.haccp_manufacturer import manufacturer_operation, read_manufacturer_instruction
from services.haccp_vision import (
    VisionAnalysisError,
    VisionConfigurationError,
    VisionServiceError,
    analyser_etiquette_vision,
)
from services.haccp_records import (
    existing_capture as _existing_capture, record_response as _response, save_record as _save_record,
)
from services.haccp_reception import (
    ReceptionDispatcher, ReceptionIntegrityError, archiver_image_brute, nettoyer_image_provisoire,
)
from routers.haccp_reception import make_haccp_reception_router
from tri_cortex.schemas import QueueUnavailable

logger = logging.getLogger(__name__)


def image_directory() -> Path:
    return data_dir() / "storage" / "etiquettes_haccp"


def reception_directory() -> Path:
    return data_dir() / "receptions"


def _restaurant_slug(value: str) -> str:
    plain = unicodedata.normalize("NFKD", value.strip()).encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", plain).strip("-")[:80].strip("-")
    if not slug:
        raise HTTPException(422, "Le nom de l'établissement doit contenir au moins une lettre ou un chiffre.")
    return slug


def _ensure_reception_directory(scope: str, restaurant_name: str) -> tuple[Path, str, bool]:
    slug = _restaurant_slug(restaurant_name)
    directory = data_dir() / "uploads" / slug / hashlib.sha256(scope.encode("utf-8")).hexdigest()
    existed = directory.exists()
    os.makedirs(directory, exist_ok=True)
    return directory, slug, existed


def _reception_filename(slug: str, type_operation: str, maintenant: datetime) -> str:
    timestamp = maintenant.astimezone(PARIS).strftime("%Y%m%d_%H%M%S")
    return f"{slug}_{type_operation}_{timestamp}_{uuid.uuid4().hex[:8]}.jpg"


def _jpeg_bytes(content: bytes) -> bytes:
    try:
        with Image.open(io.BytesIO(content)) as source:
            image = ImageOps.exif_transpose(source)
            if "A" in image.getbands():
                background = Image.new("RGB", image.size, "white")
                background.paste(image.convert("RGB"), mask=image.getchannel("A"))
                image = background
            else:
                image = image.convert("RGB")
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=95)
            return output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
        raise HTTPException(400, "Le fichier ne contient pas une image valide et lisible.") from error


def _reception_dossier(scope: str, restaurant_name: str) -> dict:
    directory, slug, existed = _ensure_reception_directory(scope, restaurant_name)
    filename_pattern = re.compile(
        rf"{re.escape(slug)}_(?:(?:reception|ouverture)_\d{{8}}_\d{{6}}_[a-f0-9]{{8}}\.jpg"
        rf"|(?:facture|bon_livraison|inconnu)_[0-9a-f-]{{36}}\.(?:jpg|png|webp))"
    )
    files = []
    for path in directory.iterdir():
        if not path.is_file() or not filename_pattern.fullmatch(path.name):
            continue
        stat = path.stat()
        files.append({
            "name": path.name,
            "size": stat.st_size,
            "updated_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        })
    files.sort(key=lambda item: (item["updated_at"], item["name"]), reverse=True)
    return {
        "restaurant_name": restaurant_name.strip(),
        "restaurant_slug": slug,
        "directory": f"uploads/{slug}",
        "directory_existed": existed,
        "items": files,
        "total": len(files),
    }


def validate_image(content: bytes, mime_type: str) -> None:
    try:
        validate_source_image(content, mime_type)
    except ImageValidationError as error:
        raise HTTPException(400, str(error)) from error


def _write_image(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    destination = path.open("xb")
    try:
        with destination:
            destination.write(content)
            destination.flush()
            os.fsync(destination.fileno())
    except OSError:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.exception("[HACCP] Nettoyage de la photo partiellement ecrite impossible")
        raise


def _cleanup_failed_capture(scope: str, path: Path | None, raw_image: ImageArchivee | None) -> None:
    if path is None and raw_image is None:
        return
    try:
        with Session(get_engine()) as db:
            predicate = (EtiquetteHaccp.raw_image_path == raw_image.chemin) if raw_image else (
                EtiquetteHaccp.image_path == path.relative_to(data_dir()).as_posix()
            )
            referenced = db.scalar(select(EtiquetteHaccp.id).where(
                EtiquetteHaccp.scope_key == scope, predicate,
            ).limit(1))
            if referenced is not None:
                logger.warning("[HACCP] Commit retrouve : conservation des preuves de la fiche %s", referenced)
                return
    except (OSError, SQLAlchemyError):
        logger.exception("[HACCP] Commit incertain : preuves conservees, nettoyage manuel a verifier")
        return
    if path is not None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.exception("[HACCP] Nettoyage de la photo non archivee impossible")
    if raw_image is not None:
        try:
            nettoyer_image_provisoire(raw_image, scope)
        except (OSError, ReceptionIntegrityError):
            logger.exception("[HACCP] Nettoyage de l'original non archive impossible")


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


def _distribute_saved(db: Session, scope: str, record: EtiquetteResponse) -> EtiquetteResponse:
    db.rollback()
    if record.type_operation == "reception" and record.reception_source_id:
        try:
            record.distribution = ReceptionDispatcher(get_engine()).distribuer(scope, record.id)
        except (SQLAlchemyError, OSError, ValueError) as error:
            logger.exception("[HACCP] Fiche archivee, distribution interrompue (id=%s)", record.id)
            raise HTTPException(503, f"Fiche {record.id} archivee, mais distribution interrompue. "
                                "Reprenez-la depuis le suivi des receptions, sans refaire de photo.") from error
    return record


CSV_COLUMNS = [
    "id", "created_at", "nom_produit", "fournisseur_ou_marque", "numero_lot",
    "dlc_ou_ddm", "type_date", "agrement_sanitaire", "temperature_stockage",
    "allergenes", "conforme_reception", "commentaire_anomalie", "operateur", "image_url",
    "type_operation", "date_ouverture", "dlc_secondaire", "duree_conservation_heures",
    "justification_duree", "regle_confirmee",
    "categorie", "date_reception", "temperature_conforme", "chemin_photo", "chemin_donnees",
    "date_fabrication", "conditions_conservation", "restaurant_name",
    "origines", "poids_net", "traces_allergenes", "mentions_traces", "allergenes_lecture",
    "champs_incertains", "chemin_image_brute", "empreinte_image_brute", "reception_source_id",
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
        values["traces_allergenes"] = ", ".join(record.traces_allergenes)
        values["champs_incertains"] = ", ".join(record.champs_incertains)
        for field in ("origines", "poids_net"):
            values[field] = json.dumps(values[field], ensure_ascii=False) if values[field] is not None else ""
        values["conforme_reception"] = "Oui" if record.conforme_reception else "Non"
        writer.writerow([_csv_cell(values[column]) for column in CSV_COLUMNS])
        yield buffer.getvalue()


def make_haccp_router(
    resolve_scope: Callable[[Request], Awaitable[str]], *,
    vision_analyser: Callable[[bytes, str, str, str, str | None], Awaitable[EtiquetteVisionOutput]] | None = None,
    on_received: Callable[[str, int], Awaitable[None]] | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/haccp", tags=["haccp-etiquettes"])

    @router.get("/receptions/dossier")
    async def dossier_reception(
        restaurant_name: Annotated[str, Query(min_length=1, max_length=160)],
        scope: str = Depends(resolve_scope),
    ) -> dict:
        if cloud_link.relay_allowed():
            response = await cloud_link.relay_haccp_registry(
                "GET", "/receptions/dossier", params={"restaurant_name": restaurant_name},
            )
            return response.json()
        try:
            return await run_in_threadpool(_reception_dossier, scope, restaurant_name)
        except HTTPException:
            raise
        except OSError as error:
            logger.exception("[HACCP] Ouverture du dossier de reception impossible")
            raise HTTPException(500, "Le dossier de réception n'a pas pu être ouvert.") from error

    @router.post("/preparations", response_model=EtiquetteResponse, status_code=201)
    async def preparation(
        body: PreparationCreate, request: Request,
        scope: str = Depends(resolve_scope), db: Session = Depends(get_db),
    ) -> EtiquetteResponse:
        kitchen = getattr(request.state, "haccp_kitchen", None)
        if kitchen is not None:
            body = body.model_copy(update={"operateur": "Cuisine", "restaurant_name": kitchen["restaurant_name"]})
        _restaurant_slug(body.restaurant_name)
        if cloud_link.relay_allowed():
            response = await cloud_link.relay_haccp_registry(
                "POST", "/preparations", json=body.model_dump(mode="json"),
            )
            return EtiquetteResponse.model_validate(response.json())
        prefix = str(request.url_for("haccp_search")).removesuffix("/recherche")
        capture_key = str(body.capture_id)
        digest = hashlib.sha256(json.dumps(
            body.model_dump(mode="json", exclude={"capture_id"}), sort_keys=True, ensure_ascii=False,
        ).encode("utf-8")).hexdigest()
        try:
            previous = await run_in_threadpool(_existing_capture, db, scope, capture_key, digest, prefix)
            if previous is not None:
                return previous
            maintenant = datetime.now(timezone.utc)
            try:
                limite = calculer_preparation(body, maintenant)
            except ValueError as error:
                raise HTTPException(422, str(error)) from error
            result = EtiquetteVisionOutput(
                nom_produit=body.nom_produit,
                numero_lot=body.numero_lot or (
                    f"PREP-{body.date_fabrication.astimezone(PARIS):%Y%m%d}-{body.capture_id.hex[:8].upper()}"
                ),
                categorie=body.categorie,
            )
            operation = OperationEtiquette.model_validate(
                body.model_dump(include=set(OperationEtiquette.model_fields)),
            )
            try:
                return await run_in_threadpool(
                    _save_record, db, result, scope, body.operateur, "", prefix,
                    operation, maintenant, limite, capture_key, digest,
                    date_fabrication=body.date_fabrication,
                    conditions_conservation=body.conditions_conservation, restaurant_name=body.restaurant_name,
                )
            except IntegrityError:
                previous = await run_in_threadpool(_existing_capture, db, scope, capture_key, digest, prefix)
                if previous is None:
                    raise
                return previous
        except SQLAlchemyError as error:
            logger.exception("[HACCP] Archivage de la preparation impossible")
            raise HTTPException(500, "La preparation n'a pas pu etre archivee.") from error

    @router.post("/etiquettes/scan", response_model=EtiquetteResponse, status_code=201)
    async def scan(
        request: Request,
        file: UploadFile = File(...),
        operateur: Annotated[str, Form(max_length=100)] = "Cuisine",
        restaurant_name: Annotated[str, Form(max_length=160)] = "Restaurant",
        operation: Annotated[str, Form(max_length=2000)] = "{}",
        capture_id: Annotated[uuid.UUID | None, Form()] = None,
        ouverture_automatique: Annotated[bool, Form()] = False,
        scope: str = Depends(resolve_scope),
        db: Session = Depends(get_db),
    ) -> EtiquetteResponse:
        mime_type = (file.content_type or "").split(";", 1)[0].strip().lower()
        if mime_type not in IMAGE_FORMATS:
            raise HTTPException(400, "Formats autorises : JPEG, PNG et WebP.")
        kitchen = getattr(request.state, "haccp_kitchen", None)
        if kitchen is not None:
            operateur, restaurant_name = "Cuisine", kitchen["restaurant_name"]
        if not operateur.strip():
            raise HTTPException(422, "Le nom de l'operateur ne peut pas etre vide.")
        if not restaurant_name.strip():
            raise HTTPException(422, "Le nom de l'établissement ne peut pas être vide.")
        restaurant_slug = _restaurant_slug(restaurant_name)
        try:
            capture = OperationCapture.model_validate_json(operation)
        except ValidationError as error:
            raise HTTPException(422, "Operation invalide : fournissez une duree en heures entieres, "
                                "une justification fabricant/PMS et la confirmation de la regle, "
                                "ou archivez l'ouverture sans regle.") from error
        automatic = capture.type_operation == "ouverture" and (kitchen is not None or ouverture_automatique)
        if automatic:
            capture = OperationCapture(type_operation="ouverture")
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
                data={"operateur": operateur.strip(), "restaurant_name": restaurant_name.strip(),
                      "operation": capture.model_dump_json(),
                      "ouverture_automatique": str(automatic).lower(),
                      **({"capture_id": str(capture_id)} if capture_id else {})},
            )
            return EtiquetteResponse.model_validate(response.json())
        path: Path | None = None
        raw_image: ImageArchivee | None = None
        saved = False
        prefix = str(request.url_for("haccp_search")).removesuffix("/recherche")
        digest = hashlib.sha256(
            content + json.dumps(
                {"operation": capture.model_dump(), "operateur": operateur.strip(),
                 "restaurant_slug": restaurant_slug, **({"ouverture_automatique": True} if automatic else {})},
                sort_keys=True, ensure_ascii=False,
            ).encode("utf-8"),
        ).hexdigest()
        capture_key = str(capture_id) if capture_id else None
        try:
            previous = await run_in_threadpool(_existing_capture, db, scope, capture_key, digest, prefix)
            if previous is not None:
                return await run_in_threadpool(_distribute_saved, db, scope, previous)
            label_read = (
                vision_analyser(content, mime_type, scope, capture_key or uuid.uuid4().hex,
                                getattr(request.state, "haccp_actor", None))
                if vision_analyser is not None else analyser_etiquette_vision(content, mime_type)
            )
            if automatic:
                result, instruction = await asyncio.gather(
                    label_read, read_manufacturer_instruction(content, mime_type),
                )
                capture = manufacturer_operation(instruction)
                if capture.regle_confirmee and instruction.conditions:
                    result = result.model_copy(update={"temperature_stockage": instruction.conditions})
            else:
                result = await label_read
            try:
                result, limite = calculer_ouverture(result, capture, maintenant)
            except ValueError as error:
                raise HTTPException(422, str(error)) from error
            if automatic and not capture.regle_confirmee:
                result = result.model_copy(update={
                    "conforme_reception": False,
                    "commentaire_anomalie": (
                        "DLC non calculable : consigne fabricant apres ouverture absente, illisible "
                        "ou non exploitable automatiquement. Aucune etiquette d'utilisation. "
                        + (result.commentaire_anomalie or "")
                    )[:500],
                })
            directory, _, _ = await run_in_threadpool(_ensure_reception_directory, scope, restaurant_name)
            candidate_path = directory / _reception_filename(restaurant_slug, capture.type_operation, maintenant)
            stored_image = await run_in_threadpool(_jpeg_bytes, content)
            await run_in_threadpool(_write_image, candidate_path, stored_image)
            path = candidate_path
            relative_path = path.relative_to(data_dir()).as_posix()
            if capture.type_operation == "reception":
                raw_image = await run_in_threadpool(archiver_image_brute, content, mime_type, scope, result, maintenant)
            try:
                response = await run_in_threadpool(
                    _save_record, db, result, scope, operateur.strip(),
                    relative_path, prefix,
                    capture, maintenant, limite, capture_key, digest,
                    restaurant_name=restaurant_name.strip(),
                    raw_image=raw_image,
                )
            except IntegrityError:
                previous = await run_in_threadpool(_existing_capture, db, scope, capture_key, digest, prefix)
                if previous is None:
                    raise
                return await run_in_threadpool(_distribute_saved, db, scope, previous)
            saved = True
            response = await run_in_threadpool(_distribute_saved, db, scope, response)
            if on_received is not None and capture.type_operation == "reception":
                try:
                    await on_received(scope, response.id)
                except (QueueUnavailable, OSError, SQLAlchemyError, sqlite3.Error) as error:
                    logger.error("[HACCP] Reception enregistree ; controles Sentinel differes (%s)",
                                 type(error).__name__)
            return response
        except VisionConfigurationError as error:
            raise HTTPException(500, str(error)) from error
        except VisionServiceError as error:
            raise HTTPException(500, str(error)) from error
        except VisionAnalysisError as error:
            raise HTTPException(422, str(error)) from error
        except (OSError, SQLAlchemyError, ReceptionIntegrityError) as error:
            logger.exception("[HACCP] Archivage de l'etiquette impossible")
            raise HTTPException(500, "L'archivage de l'etiquette n'a pas pu etre confirme. "
                                "Verifiez le registre et reessayez la meme photo sans doublon.") from error
        finally:
            if not saved:
                await run_in_threadpool(_cleanup_failed_capture, scope, path, raw_image)

    @router.get("/registre/activite", response_model=HaccpActivity)
    async def activity(
        date_debut: date, date_fin: date, scope: str = Depends(resolve_scope),
    ) -> HaccpActivity:
        return await load_activity(scope, date_debut, date_fin)

    @router.get("/registre/cloture", response_model=ClosingReport)
    async def closing_report(
        date: date, scope: str = Depends(resolve_scope),
    ) -> ClosingReport:
        return await load_closing_report(scope, date)

    @router.post("/registre/cloture/pdf")
    async def closing_pdf(
        body: ClosingPdfRequest, scope: str = Depends(resolve_scope),
    ) -> Response:
        pdf = await generate_closing_pdf(scope, body)
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="bilan-cloture-haccp-{body.date.isoformat()}.pdf"',
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

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
                _response(row, str(request.url_for("haccp_search")).removesuffix("/recherche"), db=db)
                for row in db.scalars(statement)
            ])
        except (SQLAlchemyError, ReceptionIntegrityError, ValidationError) as error:
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
                _response(row, str(request.url_for("haccp_search")).removesuffix("/recherche"), db=db)
                for row in db.scalars(statement)
            ])
        except (SQLAlchemyError, ReceptionIntegrityError, ValidationError) as error:
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
            logger.exception("[HACCP] Lecture de l'etiquette d'utilisation impossible")
            raise HTTPException(500, "L'etiquette d'utilisation est indisponible.") from error
        if row is None:
            raise HTTPException(404, "Etiquette introuvable.")
        try:
            record = _response(row, "/api/haccp/registre")
            verifier_etiquette_imprimable(record, datetime.now(timezone.utc))
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
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
        if not row.image_path:
            raise HTTPException(404, "Cette fiche a ete declaree sans photo.")
        roots = (
            image_directory().resolve(),
            reception_directory().resolve(),
            (data_dir() / "uploads").resolve(),
        )
        path = (data_dir() / row.image_path).resolve()
        if not any(path.is_relative_to(root) for root in roots) or not path.is_file():
            logger.error("[HACCP] Photo archivee absente ou chemin invalide (id=%s)", id)
            raise HTTPException(404, "La photo archivée est introuvable sur disque.")
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
        try:
            return await run_in_threadpool(
                _response, row, str(request.url_for("haccp_search")).removesuffix("/recherche"), db=db,
            )
        except (SQLAlchemyError, ReceptionIntegrityError, ValidationError) as error:
            logger.exception("[HACCP] Lecture de la distribution impossible")
            raise HTTPException(503, "L'etat de distribution de cette fiche est indisponible.") from error

    router.include_router(make_haccp_reception_router(resolve_scope))
    from routers.haccp_documents import make_haccp_documents_router
    router.include_router(make_haccp_documents_router(resolve_scope))
    return router
