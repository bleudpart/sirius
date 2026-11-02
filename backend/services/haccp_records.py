"""Persistance commune des captures, preparations et ouvertures depuis une reception."""
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from models.haccp import EtiquetteHaccp
from schemas.haccp import EtiquetteResponse, EtiquetteVisionOutput, OperationEtiquette
from schemas.haccp_reception import ImageArchivee, ReceptionDocument
from services.haccp_reception import etat_distribution, preparer_distribution


def record_response(row: EtiquetteHaccp, photo_prefix: str, *, db: Session | None = None) -> EtiquetteResponse:
    values = {name: getattr(row, name) for name in EtiquetteVisionOutput.model_fields}
    response = EtiquetteResponse(
        **values, id=row.id, created_at=row.created_at, operateur=row.operateur,
        image_url=f"{photo_prefix}/{row.id}/photo" if row.image_path else None,
        **{name: getattr(row, name) for name in OperationEtiquette.model_fields},
        date_ouverture=row.date_ouverture, dlc_secondaire=row.dlc_secondaire,
        date_fabrication=row.date_fabrication, conditions_conservation=row.conditions_conservation,
        restaurant_name=row.restaurant_name,
        chemin_photo=row.image_path or None,
        chemin_donnees=f"haccp.sqlite3#etiquettes_haccp/{row.id}",
        donnees_url=f"{photo_prefix}/{row.id}/donnees",
        fournisseur=row.fournisseur_ou_marque,
        dlc_dluo=row.dlc_ou_ddm,
        date_reception=row.created_at if row.type_operation == "reception" else None,
        chemin_image_brute=row.raw_image_path, empreinte_image_brute=row.raw_image_sha256,
        image_brute_url=(
            f"{photo_prefix.removesuffix('/registre')}/receptions/{row.reception_source_id}/original"
            if row.reception_source_id else None
        ),
        reception_source_id=row.reception_source_id,
    )
    if db is not None and row.type_operation == "reception" and row.reception_source_id:
        response.distribution = etat_distribution(db, row.scope_key, row.id)
    return response


def save_record(
    db: Session, result: EtiquetteVisionOutput, scope: str, operateur: str,
    relative_path: str, photo_prefix: str,
    operation: OperationEtiquette, maintenant: datetime, limite: datetime | None,
    capture_id: str | None, capture_hash: str,
    *, date_fabrication: datetime | None = None, conditions_conservation: str | None = None,
    restaurant_name: str | None = None, raw_image: ImageArchivee | None = None,
    reception_source_id: int | None = None,
) -> EtiquetteResponse:
    values = result.model_dump()
    # Les decimaux restent exacts dans les colonnes JSON, sous forme de chaines.
    values["poids_net"] = result.poids_net.model_dump(mode="json") if result.poids_net else None
    row = EtiquetteHaccp(
        **values, scope_key=scope, operateur=operateur, image_path=relative_path,
        **operation.model_dump(),
        date_ouverture=maintenant.replace(tzinfo=None) if operation.type_operation == "ouverture" else None,
        date_fabrication=date_fabrication.replace(tzinfo=None) if date_fabrication else None,
        conditions_conservation=conditions_conservation, restaurant_name=restaurant_name,
        dlc_secondaire=limite.replace(tzinfo=None) if limite else None,
        capture_id=capture_id, capture_hash=capture_hash,
        created_at=maintenant.replace(tzinfo=None),
        raw_image_path=raw_image.chemin if raw_image else None,
        raw_image_sha256=raw_image.sha256 if raw_image else None,
        reception_source_id=reception_source_id,
    )
    try:
        db.add(row)
        db.flush()
        if operation.type_operation == "reception" and raw_image:
            row.reception_source_id = row.id
            document = ReceptionDocument(
                reception_id=row.id, date_scan=maintenant, operateur=operateur,
                restaurant_name=restaurant_name, image=raw_image, etiquette=result,
            )
            preparer_distribution(db, scope, document)
        response = record_response(row, photo_prefix, db=db)
        db.commit()
        return response
    except (SQLAlchemyError, ValueError):
        db.rollback()
        raise


def existing_capture(
    db: Session, scope: str, capture_id: str | None, digest: str, prefix: str,
) -> EtiquetteResponse | None:
    if capture_id is None:
        return None
    row = db.scalar(select(EtiquetteHaccp).where(
        EtiquetteHaccp.scope_key == scope, EtiquetteHaccp.capture_id == capture_id,
    ))
    if row is None:
        return None
    if row.capture_hash != digest:
        raise HTTPException(409, "Cette capture est deja archivee avec un contenu different. "
                            "Creez une nouvelle fiche pour changer son contenu.")
    return record_response(row, prefix)
