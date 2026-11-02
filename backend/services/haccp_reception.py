"""Archivage brut et distribution transactionnelle, sans nouvel appel Vision."""
import hashlib
import logging
import os
import re
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import Engine, func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from models.haccp import EtiquetteHaccp
from models.haccp_reception import (
    AllergenObservation, PurchaseReceipt, ReceptionDelivery, ReceptionJournal, ReceptionSource, StockLot,
)
from runtime_paths import data_dir
from schemas.haccp import EtiquetteVisionOutput, ObservationAllergenesEtat
from schemas.haccp_reception import (
    DESTINATIONS, Destination, EtatDestination, EtatDistribution, ImageArchivee, ReceptionDocument,
    canonical_json, fingerprint,
)
from services.haccp_images import IMAGE_FORMATS, validate_source_image
from services.haccp_opening import fin_de_date

logger = logging.getLogger(__name__)
GENESIS_HASH = "0" * 64


class ReceptionIntegrityError(ValueError):
    pass


class ReceptionNotFoundError(LookupError):
    pass


def _utc_naive(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _archive_directory(scope: str) -> Path:
    return data_dir().resolve() / "receptions" / fingerprint(scope)[:24]


def _filename_segment(value: str | None) -> str:
    if not value:
        return "NON_LU"
    plain = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^A-Z0-9]+", "-", plain.upper()).strip("-")[:16].strip("-") or "NON_LU"


def archiver_image_brute(
    content: bytes, mime_type: str, scope: str, etiquette: EtiquetteVisionOutput, instant: datetime,
) -> ImageArchivee:
    """Publie les octets recus par lien atomique, sans ecraser une preuve existante."""
    validate_source_image(content, mime_type)
    scope_directory = _archive_directory(scope)
    # Sous Windows, resolve() peut changer de prefixe si un parent inexistant apparait pendant l'appel.
    for parent in (scope_directory.parent, scope_directory):
        parent.mkdir(mode=0o700, exist_ok=True)
        if parent.resolve(strict=True) != parent:
            raise ReceptionIntegrityError("Le dossier des originaux est redirige hors de son emplacement autorise.")
    directory = scope_directory / uuid.uuid4().hex
    directory.mkdir(mode=0o700, exist_ok=False)
    name = (
        f"REC_{_filename_segment(etiquette.fournisseur_ou_marque)}_"
        f"{instant.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}_"
        f"{_filename_segment(etiquette.numero_lot)}{IMAGE_FORMATS[mime_type][1]}"
    )
    target = directory / name
    temporary = directory / ".en-cours"
    try:
        with temporary.open("xb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        # link est atomique et refuse un nom deja existant (contrairement a replace).
        os.link(temporary, target)
        temporary.unlink()
        if os.name == "posix":
            descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        return ImageArchivee(
            chemin=target.relative_to(data_dir().resolve()).as_posix(),
            sha256=hashlib.sha256(content).hexdigest(),
            taille_octets=len(content), type_mime=mime_type,
        )
    except (OSError, ValueError):
        for path in (temporary, target):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.exception("[HACCP] Nettoyage d'un original provisoire impossible")
        try:
            directory.rmdir()
        except OSError:
            logger.exception("[HACCP] Nettoyage du dossier provisoire impossible")
        raise


def _image_path(image: ImageArchivee, scope: str) -> Path:
    root = _archive_directory(scope)
    path = (data_dir().resolve() / image.chemin).resolve()
    if not root.resolve().is_relative_to(data_dir().resolve() / "receptions") or not path.is_relative_to(root):
        raise ReceptionIntegrityError("Chemin de preuve hors du dossier autorise.")
    return path


def lire_image_verifiee(image: ImageArchivee, scope: str) -> bytes:
    path = _image_path(image, scope)
    with path.open("rb") as stream:
        content = stream.read(image.taille_octets + 1)
    if len(content) != image.taille_octets or hashlib.sha256(content).hexdigest() != image.sha256:
        raise ReceptionIntegrityError("L'empreinte ou la taille de l'original ne correspond plus a l'archive.")
    return content


def nettoyer_image_provisoire(image: ImageArchivee, scope: str) -> None:
    """Seulement pour la preuve propre a une tentative qui n'a jamais ete commitee."""
    path = _image_path(image, scope)
    path.unlink(missing_ok=True)
    path.parent.rmdir()


def preparer_distribution(db: Session, scope: str, document: ReceptionDocument) -> None:
    """Source et outbox sont inserees dans la transaction de la fiche de reception."""
    payload = canonical_json(document.model_dump(mode="json"))
    db.add(ReceptionSource(
        reception_id=document.reception_id, scope_key=scope, payload_json=payload,
        payload_sha256=fingerprint(payload), product_key=document.product_key(),
        allergens_comparable=document.allergens_comparable(),
    ))
    db.flush()
    db.add_all([
        ReceptionDelivery(
            reception_id=document.reception_id, destination=destination, status="pending",
            attempts=0, updated_at=_utc_naive(document.date_scan),
        )
        for destination in DESTINATIONS
    ])


def charger_source(db: Session, scope: str, reception_id: int) -> tuple[ReceptionSource, ReceptionDocument]:
    source = db.scalar(select(ReceptionSource).where(
        ReceptionSource.reception_id == reception_id, ReceptionSource.scope_key == scope,
    ))
    if source is None:
        raise ReceptionNotFoundError("Cette reception ne possede pas de source de distribution.")
    if fingerprint(source.payload_json) != source.payload_sha256:
        raise ReceptionIntegrityError("L'empreinte de la source ne correspond plus a son contenu.")
    document = ReceptionDocument.model_validate_json(source.payload_json)
    if document.reception_id != reception_id or canonical_json(document.model_dump(mode="json")) != source.payload_json:
        raise ReceptionIntegrityError("La source ne correspond pas a la reception ou a son format canonique.")
    if source.product_key != document.product_key() or source.allergens_comparable != document.allergens_comparable():
        raise ReceptionIntegrityError("Les index de la source ne correspondent plus a son contenu.")
    return source, document


def empreinte_journal(scope: str, sequence: int, previous: str, recorded_at: datetime, payload: str) -> str:
    instant = recorded_at.replace(tzinfo=timezone.utc) if recorded_at.tzinfo is None else recorded_at.astimezone(timezone.utc)
    return fingerprint(canonical_json([fingerprint(scope), sequence, previous, instant.isoformat(), payload]))


def _write_journal(db: Session, source: ReceptionSource, document: ReceptionDocument) -> None:
    previous = db.scalar(select(ReceptionJournal).where(
        ReceptionJournal.scope_key == source.scope_key,
    ).order_by(ReceptionJournal.sequence.desc()).limit(1))
    if previous and previous.entry_hash != empreinte_journal(
        source.scope_key, previous.sequence, previous.previous_hash, previous.recorded_at, previous.payload_json,
    ):
        raise ReceptionIntegrityError("La derniere entree du journal a ete alteree.")
    sequence = previous.sequence + 1 if previous else 1
    previous_hash = previous.entry_hash if previous else GENESIS_HASH
    recorded_at = _utc_naive(datetime.now(timezone.utc))
    db.add(ReceptionJournal(
        reception_id=document.reception_id, scope_key=source.scope_key, sequence=sequence,
        previous_hash=previous_hash, payload_json=source.payload_json, recorded_at=recorded_at,
        entry_hash=empreinte_journal(source.scope_key, sequence, previous_hash, recorded_at, source.payload_json),
    ))


def _write_stock(db: Session, source: ReceptionSource, document: ReceptionDocument) -> None:
    label = document.etiquette
    deadline = fin_de_date(label.dlc_ou_ddm) if label.dlc_ou_ddm and label.type_date != "inconnue" else None
    alert_at = document.date_scan
    if deadline and deadline > document.date_scan:
        alert_at = max(document.date_scan, deadline - timedelta(hours=document.alerte_avant_heures))
    db.add(StockLot(
        reception_id=document.reception_id, scope_key=source.scope_key, restaurant_name=document.restaurant_name,
        product=label.nom_produit, supplier=label.fournisseur_ou_marque, lot=label.numero_lot,
        received_at=_utc_naive(document.date_scan), date_type=label.type_date,
        deadline=_utc_naive(deadline) if deadline else None, alert_at=_utc_naive(alert_at),
        declared_weight_kg=str(label.poids_net.en_kilogrammes()) if label.poids_net else None,
        storage=label.temperature_stockage, label_compliant=label.conforme_reception,
    ))


def _write_allergens(db: Session, source: ReceptionSource, document: ReceptionDocument) -> None:
    label = document.etiquette
    baseline = None
    if source.product_key and source.allergens_comparable:
        # La source durable, non l'ordre des retries, determine le precedent connu.
        baseline = db.scalar(select(ReceptionSource).where(
            ReceptionSource.scope_key == source.scope_key,
            ReceptionSource.product_key == source.product_key,
            ReceptionSource.allergens_comparable.is_(True),
            ReceptionSource.reception_id < source.reception_id,
        ).order_by(ReceptionSource.reception_id.desc()).limit(1))
    old_label = charger_source(db, source.scope_key, baseline.reception_id)[1].etiquette if baseline else None
    new_allergens = sorted(set(label.allergenes) - set(old_label.allergenes)) if old_label else []
    new_traces = sorted(
        set(label.traces_allergenes) - set(old_label.traces_allergenes) - set(old_label.allergenes),
    ) if old_label else []
    db.add(AllergenObservation(
        reception_id=document.reception_id, scope_key=source.scope_key, restaurant_name=document.restaurant_name,
        product=label.nom_produit, supplier=label.fournisseur_ou_marque,
        allergens=label.allergenes, traces=label.traces_allergenes, trace_mentions=label.mentions_traces,
        reading_status=label.allergenes_lecture, baseline_id=baseline.reception_id if baseline else None,
        new_allergens=new_allergens, new_traces=new_traces,
        review_required=not old_label or bool(new_allergens or new_traces),
    ))


def _write_purchases(db: Session, source: ReceptionSource, document: ReceptionDocument) -> None:
    label = document.etiquette
    db.add(PurchaseReceipt(
        reception_id=document.reception_id, scope_key=source.scope_key, restaurant_name=document.restaurant_name,
        supplier=label.fournisseur_ou_marque, product=label.nom_produit, lot=label.numero_lot,
        received_at=_utc_naive(document.date_scan),
        net_weight=label.poids_net.model_dump(mode="json") if label.poids_net else None,
        raw_image_path=document.image.chemin, raw_image_sha256=document.image.sha256,
    ))


def etat_distribution(db: Session, scope: str, reception_id: int) -> EtatDistribution:
    charger_source(db, scope, reception_id)
    jobs = {row.destination: row for row in db.scalars(select(ReceptionDelivery).where(
        ReceptionDelivery.reception_id == reception_id,
    ))}
    if set(jobs) != set(DESTINATIONS):
        raise ReceptionIntegrityError("La liste des destinations de cette reception est incomplete.")
    states = [EtatDestination(
        destination=name, statut=jobs[name].status, tentatives=jobs[name].attempts, erreur=jobs[name].error,
    ) for name in DESTINATIONS]
    status = "complete" if all(item.statut == "done" for item in states) else (
        "partial" if any(item.statut != "pending" for item in states) else "pending"
    )
    review = None
    if jobs["allergenes"].status == "done":
        observation = db.scalar(select(AllergenObservation).where(
            AllergenObservation.reception_id == reception_id, AllergenObservation.scope_key == scope,
        ))
        if observation is None:
            raise ReceptionIntegrityError("L'observation d'allergenes distribuee est introuvable.")
        review = ObservationAllergenesEtat(
            lecture=observation.reading_status, verification_requise=observation.review_required,
            reference_reception_id=observation.baseline_id, nouveaux_allergenes=observation.new_allergens,
            nouvelles_traces=observation.new_traces,
        )
    return EtatDistribution(reception_id=reception_id, statut=status, destinations=states, observation_allergenes=review)


class ReceptionDispatcher:
    def __init__(self, engine: Engine):
        self.engine = engine

    def distribuer(self, scope: str, reception_id: int) -> EtatDistribution:
        """Une transaction par destination ; une panne ne defait pas les autres."""
        for destination in DESTINATIONS:
            with Session(self.engine) as db:
                db.execute(text("BEGIN IMMEDIATE"))
                source, document = charger_source(db, scope, reception_id)
                job = db.get(ReceptionDelivery, (reception_id, destination))
                if job is None:
                    raise ReceptionIntegrityError("Une tache de distribution a disparu.")
                if job.status == "done":
                    continue
                if job.status not in ("pending", "error"):
                    raise ReceptionIntegrityError("Etat de distribution invalide.")
                try:
                    with db.begin_nested():
                        lire_image_verifiee(document.image, scope)
                        writer = {
                            "traceabilite": _write_journal, "stock": _write_stock,
                            "allergenes": _write_allergens, "achats": _write_purchases,
                        }[destination]
                        writer(db, source, document)
                        db.flush()
                    job.status, job.error = "done", None
                except (SQLAlchemyError, OSError, ValueError) as error:
                    logger.exception("[HACCP] Echec de distribution %s pour reception %s", destination, reception_id)
                    job.status = "error"
                    job.error = (
                        f"Destination {destination} non distribuee ({type(error).__name__}). "
                        "Consultez les journaux du serveur, puis reprenez la distribution."
                    )
                job.attempts += 1
                job.updated_at = _utc_naive(datetime.now(timezone.utc))
                db.commit()
        with Session(self.engine) as db:
            return etat_distribution(db, scope, reception_id)


_MODELS = {
    "traceabilite": ReceptionJournal, "stock": StockLot, "allergenes": AllergenObservation, "achats": PurchaseReceipt,
}


def consulter_destination(
    db: Session, scope: str, destination: Destination, restaurant_name: str | None, offset: int, limit: int,
) -> dict:
    model = _MODELS[destination]
    statement = select(model).where(model.scope_key == scope)
    if restaurant_name is not None:
        statement = statement.join(EtiquetteHaccp, EtiquetteHaccp.id == model.reception_id).where(
            func.haccp_casefold(EtiquetteHaccp.restaurant_name) == restaurant_name.strip().casefold(),
        )
    total = db.scalar(select(func.count()).select_from(statement.subquery()))
    if destination == "stock":
        statement = statement.order_by(StockLot.deadline.is_(None), StockLot.deadline, StockLot.received_at, StockLot.reception_id)
    else:
        statement = statement.order_by(model.reception_id.desc())
    items = []
    now = _utc_naive(datetime.now(timezone.utc))
    for row in db.scalars(statement.offset(offset).limit(limit)):
        values = {column.name: getattr(row, column.name) for column in model.__table__.columns if column.name != "scope_key"}
        for name, value in values.items():
            if isinstance(value, datetime):
                values[name] = value.replace(tzinfo=timezone.utc).isoformat()
        if isinstance(row, StockLot):
            values.update(
                controle_physique="a_effectuer", quantite_receptionnee_confirmee=False,
                alerte=row.alert_at <= now or not row.label_compliant,
                date_depassee=row.deadline is not None and row.deadline < now,
            )
        if isinstance(row, PurchaseReceipt):
            values.update(statut="a_rapprocher", fournisseur_confirme=False)
        if isinstance(row, ReceptionJournal):
            values["document"] = ReceptionDocument.model_validate_json(row.payload_json).model_dump(mode="json")
            values["empreinte_perimetre"] = fingerprint(scope)
            del values["payload_json"]
        items.append(values)
    return {"destination": destination, "items": items, "total": total, "offset": offset, "limit": limit}


def verifier_integrite(db: Session, scope: str, offset: int, limit: int) -> dict:
    """Verifie une page du journal et ses originaux ; ne certifie pas un stockage WORM."""
    base = select(ReceptionJournal).where(ReceptionJournal.scope_key == scope)
    total = db.scalar(select(func.count()).select_from(base.subquery()))
    source_count = db.scalar(select(func.count()).select_from(ReceptionSource).where(ReceptionSource.scope_key == scope))
    previous = db.scalar(base.order_by(ReceptionJournal.sequence).offset(offset - 1).limit(1)) if offset else None
    previous_hash = previous.entry_hash if previous else GENESIS_HASH
    rows = list(db.scalars(base.order_by(ReceptionJournal.sequence).offset(offset).limit(limit)))
    issues = []
    if source_count != total:
        issues.append("Des sources ne sont pas encore inscrites dans le journal ; reprenez leur distribution.")
    for index, row in enumerate(rows, start=offset + 1):
        if row.sequence != index or row.previous_hash != previous_hash or row.entry_hash != empreinte_journal(
            scope, row.sequence, row.previous_hash, row.recorded_at, row.payload_json,
        ):
            issues.append(f"Chaine du journal invalide a la reception {row.reception_id}.")
        try:
            source, document = charger_source(db, scope, row.reception_id)
            if source.payload_json != row.payload_json:
                raise ReceptionIntegrityError("Le journal differe de la source archivee.")
            lire_image_verifiee(document.image, scope)
        except (OSError, ValueError, ReceptionNotFoundError) as error:
            logger.warning("[HACCP] Integrite reception %s : %s", row.reception_id, error)
            issues.append(f"Source ou image invalide a la reception {row.reception_id} ({type(error).__name__}).")
        previous_hash = row.entry_hash
    return {
        "ok": not issues, "perimetre": "pipeline_receptions", "total": total, "sources": source_count,
        "offset": offset, "verifiees": len(rows),
        "prochain_offset": offset + len(rows) if offset + len(rows) < total else None,
        "derniere_empreinte": previous_hash, "erreurs": issues,
        "empreinte_perimetre": fingerprint(scope),
        "archivage_certifie": False,
    }
