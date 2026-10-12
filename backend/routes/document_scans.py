"""Camera documents and human-reviewed accounting drafts, stored with the original."""
import logging
import uuid
from datetime import date as Date, datetime, timezone
from decimal import Decimal
from typing import Annotated, Literal, TypeAlias

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError, field_validator

from storage import _safe_local_path, put_object

logger = logging.getLogger(__name__)
Money: TypeAlias = Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=2, allow_inf_nan=False)]


class ScanAccounting(BaseModel):
    model_config = ConfigDict(extra="forbid")
    supplier: str = Field(default="", max_length=160)
    date: Date | None = None
    total_ttc: Money | None = None
    tva: Money | None = None
    currency: Literal["EUR", "CHF", "USD", "GBP"] = "EUR"
    fiscal_identifiers: str = Field(default="", max_length=2000)
    ticket_number: str = Field(default="", max_length=120)


class ScanPresentation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    template: Literal["classique", "professionnel"] = "professionnel"
    seller: str = Field(default="", max_length=2000)
    customer: str = Field(default="", max_length=2000)
    description: str = Field(default="", max_length=10000)


class ScanMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dossier: str = Field(min_length=1, max_length=120)
    work_dossier_id: str | None = Field(default=None, max_length=80)
    kind: Literal["document", "purchase", "sale"] = "document"
    accounting: ScanAccounting | None = None
    reviewed: StrictBool = False
    text: str = Field(default="", max_length=30000)
    draft: str = Field(default="", max_length=30000)
    presentation: ScanPresentation | None = None

    @field_validator("dossier")
    @classmethod
    def clean_dossier(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Le dossier de destination est obligatoire.")
        return value


def make_document_scans_router(db, require_user, validate_upload):
    router = APIRouter(prefix="/api/document-scans", tags=["document-scans"])

    @router.post("")
    async def save_scan(request: Request, file: UploadFile = File(...), metadata: str = Form(...)):
        uid = (await require_user(request, db))["user_id"]
        try:
            body = ScanMetadata.model_validate_json(metadata)
        except ValidationError as error:
            raise HTTPException(status_code=422, detail="Les informations du document sont invalides.") from error
        if not body.reviewed:
            raise HTTPException(status_code=422, detail="Relisez et validez le document avant de l'enregistrer.")
        if body.kind != "document" and body.accounting is None:
            raise HTTPException(status_code=422, detail="Les champs comptables à relire sont manquants.")
        if body.kind == "document" and (body.accounting is not None or body.draft):
            raise HTTPException(status_code=422, detail="Choisissez Achat ou Vente pour joindre une fiche comptable.")
        if body.accounting and body.accounting.tva is not None and body.accounting.total_ttc is not None:
            if body.accounting.tva > body.accounting.total_ttc:
                raise HTTPException(status_code=422, detail="Le montant de TVA ne peut pas dépasser le total TTC.")
        folder = body.dossier
        if body.work_dossier_id:
            dossier = await db.sirius_work_dossiers.find_one({"id": body.work_dossier_id, "user_id": uid})
            if not dossier:
                raise HTTPException(status_code=404, detail="Dossier de travail introuvable.")
            folder = dossier["title"]
        content_type = (file.content_type or "").split(";", 1)[0].lower().strip()
        extensions = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
        if content_type not in extensions:
            raise HTTPException(status_code=415, detail="Le scanner accepte les images JPEG, PNG et WebP.")
        data = await file.read(20 * 1048576 + 1)
        if not data:
            raise HTTPException(status_code=400, detail="Document vide.")
        if len(data) > 20 * 1048576:
            raise HTTPException(status_code=413, detail="Document limité à 20 Mo.")
        extension = extensions[content_type]
        validate_upload(extension, content_type, data)
        file_id = str(uuid.uuid4())
        storage_path = f"sirius/uploads/{file_id}.{extension}"
        now = datetime.now(timezone.utc).isoformat()
        name = (file.filename or f"document.{extension}").replace("\\", "/").rsplit("/", 1)[-1][:180]
        record = {
            "id": file_id, "user_id": uid, "storage_path": storage_path,
            "original_filename": name or f"document.{extension}", "content_type": content_type,
            "size": len(data), "dossier": folder, "created_at": now, "is_deleted": False,
            "scan": {**body.model_dump(mode="json"), "dossier": folder, "reviewed_at": now,
                     "status": "draft" if body.kind == "sale" else "reviewed",
                     "invoice_issued": False},
        }
        stored = False
        try:
            put_object(storage_path, data, content_type)
            stored = True
            await db.files.insert_one(dict(record))
        except Exception as error:
            logger.error("[DOCUMENT-SCAN] Enregistrement échoué (%s)", type(error).__name__)
            if stored:
                try:
                    _safe_local_path(storage_path).unlink(missing_ok=True)
                except OSError as cleanup_error:
                    logger.error("[DOCUMENT-SCAN] Nettoyage du fichier échoué (%s)", type(cleanup_error).__name__)
            raise HTTPException(status_code=502, detail="Le document n'a pas pu être conservé. Réessayez.") from error
        return {key: value for key, value in record.items() if key not in ("storage_path", "user_id")}

    @router.get("")
    async def list_scans(request: Request, work_dossier_id: str):
        uid = (await require_user(request, db))["user_id"]
        dossier = await db.sirius_work_dossiers.find_one({"id": work_dossier_id, "user_id": uid})
        if not dossier:
            raise HTTPException(status_code=404, detail="Dossier de travail introuvable.")
        items = await db.files.find(
            {"user_id": uid, "is_deleted": False, "scan.work_dossier_id": work_dossier_id},
            {"_id": 0, "storage_path": 0, "user_id": 0},
        ).sort("created_at", -1).to_list(200)
        return {"items": items}

    @router.get("/{file_id}/draft.pdf")
    async def draft_pdf(file_id: str, request: Request):
        uid = (await require_user(request, db))["user_id"]
        record = await db.files.find_one({"id": file_id, "user_id": uid, "is_deleted": False}, {"_id": 0})
        if not record:
            raise HTTPException(status_code=404, detail="Document introuvable.")
        scan = record.get("scan") or {}
        if scan.get("kind") not in ("sale", "purchase") or not scan.get("reviewed"):
            raise HTTPException(status_code=422, detail="Relisez les données comptables avant de préparer le PDF.")
        from document_scan_pdf import build_scan_pdf
        from email_signature import load_signature_identity
        try:
            identity = await load_signature_identity(db, uid)
            data = build_scan_pdf(record, **identity)
        except Exception as error:
            logger.error("[DOCUMENT-SCAN] Génération PDF échouée (%s)", type(error).__name__)
            raise HTTPException(status_code=502, detail="Le PDF n'a pas pu être généré.") from error
        return Response(data, media_type="application/pdf", headers={
            "Content-Disposition": f'attachment; filename="document-{file_id}.pdf"',
            "Cache-Control": "private, no-store",
        })

    return router
