"""Synthese HACCP de fin de service, limitee aux donnees enregistrees."""
import hashlib
import json
import logging
import re
import unicodedata
from datetime import date, datetime, time, timedelta, timezone
from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, StrictBool, field_validator, model_validator
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

import cloud_link
from haccp_activity import HaccpActivity, load_activity, read_activity
from haccp_database import get_engine
from models.haccp import EtiquetteHaccp
from models.haccp_printing import HaccpPrintJob
from schemas.haccp import PARIS

logger = logging.getLogger(__name__)
MAX_PRIORITY_ITEMS = 20
DATE_ALERT_DAYS = 3


class ClosingItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    etiquette_id: Annotated[int, Field(strict=True, ge=1)]
    produit: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=255)]
    lot: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=128)]
    type_operation: Literal["reception", "ouverture", "preparation", "impression"]
    motif: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=300)]
    date_cible: date | None = None
    statut_impression: Literal["pending", "claimed", "uncertain"] | None = None


class ClosingPriority(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: Literal["non_conformites", "dates", "impressions", "lectures"]
    niveau: Literal["urgent", "attention", "verification"]
    titre: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=100)]
    action: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=300)]
    total: Annotated[int, Field(strict=True, ge=1)]
    fiches: list[ClosingItem] = Field(max_length=MAX_PRIORITY_ITEMS)
    autres_fiches: Annotated[int, Field(strict=True, ge=0)]


class ClosingReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: date
    fuseau: Literal["Europe/Paris"]
    genere_le: AwareDatetime
    etiquettes_enregistrees: Annotated[int, Field(strict=True, ge=0)]
    impressions_confirmees: Annotated[int, Field(strict=True, ge=0)]
    impressions_sans_date: Annotated[int, Field(strict=True, ge=0)]
    statut: Literal["attention", "aucune_alerte_enregistree"]
    priorites: list[ClosingPriority] = Field(max_length=4)
    limites: list[Annotated[str, StringConstraints(strict=True, min_length=1, max_length=300)]]
    revision: Annotated[str, StringConstraints(strict=True, pattern=r"^[a-f0-9]{64}$")]

    @model_validator(mode="after")
    def consistent(self) -> "ClosingReport":
        if self.statut != ("attention" if self.priorites else "aucune_alerte_enregistree"):
            raise ValueError("Le statut du bilan doit correspondre aux priorites.")
        return self


class ClosingPdfRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    date: date
    revision: Annotated[str, StringConstraints(strict=True, pattern=r"^[a-f0-9]{64}$")]
    nom_responsable: Annotated[str, StringConstraints(strict=True, min_length=2, max_length=100)]
    confirme_verification_humaine: StrictBool

    @field_validator("nom_responsable")
    @classmethod
    def manager_name(cls, value: str) -> str:
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("Le nom du responsable contient des caracteres de controle.")
        if len(re.sub(r"[\W_]", "", value, flags=re.UNICODE)) < 2:
            raise ValueError("Indiquez le nom complet du responsable.")
        return value

    @model_validator(mode="after")
    def require_human_confirmation(self) -> "ClosingPdfRequest":
        if self.confirme_verification_humaine is not True:
            raise ValueError("La validation humaine du bilan est obligatoire avant de produire le PDF.")
        return self


def _utc_bounds(day: date) -> tuple[datetime, datetime]:
    start = datetime.combine(day, time.min, PARIS).astimezone(timezone.utc).replace(tzinfo=None)
    end = datetime.combine(day + timedelta(days=1), time.min, PARIS).astimezone(timezone.utc).replace(tzinfo=None)
    return start, end


def _expiry_day(row: EtiquetteHaccp) -> date | None:
    if row.dlc_secondaire is not None:
        value = row.dlc_secondaire
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(PARIS).date()
    return row.dlc_ou_ddm


def _closing_item(row: EtiquetteHaccp, motive: str, due: date | None = None) -> ClosingItem:
    return ClosingItem(
        etiquette_id=row.id,
        produit=row.nom_produit,
        lot=row.numero_lot,
        type_operation=row.type_operation,
        motif=motive,
        date_cible=due,
    )


def _priority(code, level, title, action, total, records) -> ClosingPriority:
    items = records[:MAX_PRIORITY_ITEMS]
    return ClosingPriority(
        code=code, niveau=level, titre=title, action=action, total=total,
        fiches=items, autres_fiches=max(0, total - len(items)),
    )


def _revision(scope: str, data: dict) -> str:
    encoded = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(scope.encode("utf-8") + b"\0" + encoded).hexdigest()


def read_closing_report(scope: str, day: date) -> ClosingReport:
    if day == date.max:
        raise HTTPException(422, "Cette date depasse les limites du calendrier.")
    start, end = _utc_bounds(day)
    horizon = day + timedelta(days=DATE_ALERT_DAYS)
    horizon_end = datetime.combine(horizon + timedelta(days=1), time.min, PARIS).astimezone(timezone.utc).replace(tzinfo=None)
    due_predicate = or_(
        and_(EtiquetteHaccp.dlc_secondaire.is_not(None), EtiquetteHaccp.dlc_secondaire < horizon_end),
        and_(EtiquetteHaccp.dlc_secondaire.is_(None), EtiquetteHaccp.dlc_ou_ddm.is_not(None),
             EtiquetteHaccp.dlc_ou_ddm <= horizon),
    )
    labels_today = and_(EtiquetteHaccp.scope_key == scope, EtiquetteHaccp.created_at >= start,
                        EtiquetteHaccp.created_at < end)
    priorities: list[ClosingPriority] = []
    try:
        daily = read_activity(scope, day, day)
        with Session(get_engine()) as db:
            # Only records entered for this service day are inspected; registry history is not stock state.
            nonconforming_count = db.scalar(select(func.count()).select_from(EtiquetteHaccp).where(
                labels_today, EtiquetteHaccp.conforme_reception.is_(False),
            )) or 0
            if nonconforming_count:
                rows = db.scalars(select(EtiquetteHaccp).where(
                    labels_today, EtiquetteHaccp.conforme_reception.is_(False),
                ).order_by(EtiquetteHaccp.created_at.desc(), EtiquetteHaccp.id.desc()).limit(MAX_PRIORITY_ITEMS))
                priorities.append(_priority(
                    "non_conformites", "urgent", "Anomalies déjà signalées",
                    "Relire les fiches et appliquer la procédure interne; ΣIRIUS ne décide pas de la mise à l'écart.",
                    nonconforming_count,
                    [_closing_item(row, row.commentaire_anomalie or "Fiche enregistrée comme non conforme.")
                     for row in rows],
                ))

            due_count = db.scalar(select(func.count()).select_from(EtiquetteHaccp).where(
                labels_today, due_predicate,
            )) or 0
            if due_count:
                rows = db.scalars(select(EtiquetteHaccp).where(
                    labels_today, due_predicate,
                ).order_by(EtiquetteHaccp.created_at.desc(), EtiquetteHaccp.id.desc()).limit(MAX_PRIORITY_ITEMS))
                due_items = []
                for row in rows:
                    due = _expiry_day(row)
                    if due is None:
                        continue
                    remaining = (due - day).days
                    motive = "Date portee sur la fiche deja depassee." if remaining < 0 else (
                        "Date a verifier aujourd'hui." if remaining == 0 else
                        f"Date a verifier dans {remaining} jour(s)."
                    )
                    due_items.append(_closing_item(row, motive, due))
                priorities.append(_priority(
                    "dates", "urgent" if any(item.date_cible and item.date_cible < day for item in due_items) else "attention",
                    "Dates proches ou dépassées sur les fiches du jour",
                    "Comparer à l'étiquette et vérifier physiquement le produit; le registre ne confirme ni stock ni retrait.",
                    due_count, due_items,
                ))

            unresolved = select(HaccpPrintJob, EtiquetteHaccp).outerjoin(
                EtiquetteHaccp, and_(
                    EtiquetteHaccp.id == HaccpPrintJob.label_id,
                    EtiquetteHaccp.scope_key == HaccpPrintJob.scope_key,
                ),
            ).where(
                HaccpPrintJob.scope_key == scope, HaccpPrintJob.created_at >= start,
                HaccpPrintJob.created_at < end, HaccpPrintJob.status.in_(("pending", "claimed", "uncertain")),
            ).order_by(HaccpPrintJob.created_at, HaccpPrintJob.id)
            unresolved_count = db.scalar(select(func.count()).select_from(HaccpPrintJob).where(
                HaccpPrintJob.scope_key == scope, HaccpPrintJob.created_at >= start,
                HaccpPrintJob.created_at < end, HaccpPrintJob.status.in_(("pending", "claimed", "uncertain")),
            )) or 0
            if unresolved_count:
                rows = db.execute(unresolved.limit(MAX_PRIORITY_ITEMS))
                items = []
                for job, row in rows:
                    if row is None:
                        logger.error("[HACCP-CLOSING] Job %s sans fiche de son scope", job.id)
                        continue
                    status_text = {
                        "pending": "En attente de prise en charge.",
                        "claimed": "Pris en charge, confirmation non reçue.",
                        "uncertain": "Envoi incertain, vérifier l'imprimante et le papier; ne pas relancer automatiquement.",
                    }[job.status]
                    items.append(ClosingItem(
                        etiquette_id=row.id, produit=row.nom_produit, lot=row.numero_lot,
                        type_operation="impression", motif=status_text, statut_impression=job.status,
                    ))
                priorities.append(_priority(
                    "impressions", "urgent" if any(item.statut_impression == "uncertain" for item in items) else "attention",
                    "Envois d'impression à vérifier",
                    "Ne pas interpréter une confirmation technique comme une preuve de sortie papier et ne pas réimprimer sans contrôle.",
                    unresolved_count, items,
                ))

            incomplete_predicate = or_(
                EtiquetteHaccp.type_date == "inconnue",
                and_(EtiquetteHaccp.dlc_ou_ddm.is_(None), EtiquetteHaccp.dlc_secondaire.is_(None)),
                EtiquetteHaccp.champs_incertains != [],
                EtiquetteHaccp.allergenes_lecture != "complete",
            )
            incomplete_count = db.scalar(select(func.count()).select_from(EtiquetteHaccp).where(
                labels_today, incomplete_predicate,
            )) or 0
            if incomplete_count:
                rows = db.scalars(select(EtiquetteHaccp).where(
                    labels_today, incomplete_predicate,
                ).order_by(EtiquetteHaccp.created_at.desc(), EtiquetteHaccp.id.desc()).limit(MAX_PRIORITY_ITEMS))
                priorities.append(_priority(
                    "lectures", "verification", "Lectures ou dates à compléter",
                    "Relire les informations à partir de la fiche et de l'étiquette originale; aucune donnée manquante n'est déduite.",
                    incomplete_count,
                    [_closing_item(row, (
                        "Date non connue ou absente." if row.type_date == "inconnue" or
                        (row.dlc_ou_ddm is None and row.dlc_secondaire is None) else
                        "Lecture allergènes non complète." if row.allergenes_lecture != "complete" else
                        "Certains champs demandent une vérification."
                    )) for row in rows],
                ))
    except (OSError, SQLAlchemyError) as error:
        logger.exception("[HACCP-CLOSING] Lecture du bilan impossible")
        raise HTTPException(503, "Le bilan de clôture HACCP est indisponible. Aucun résultat n'a été calculé.") from error

    priorities.sort(key=lambda item: (
        {"urgent": 0, "attention": 1, "verification": 2}[item.niveau],
        {"non_conformites": 0, "dates": 1, "impressions": 2, "lectures": 3}[item.code],
    ))
    details = {
        "date": day.isoformat(),
        "etiquettes_enregistrees": daily.etiquettes_enregistrees,
        "impressions_confirmees": daily.impressions_confirmees,
        "impressions_sans_date": daily.impressions_sans_date,
        "statut": "attention" if priorities else "aucune_alerte_enregistree",
        "priorites": [item.model_dump(mode="json") for item in priorities],
        "limites": [
            "Les alertes de date portent seulement sur les fiches créées ce jour; le registre ne prouve pas la présence ou le retrait d'un produit du stock.",
            "Les envois pending, claimed ou uncertain ne sont pas des impressions confirmées; un statut accepted ne prouve pas la sortie papier.",
            "Les contrôles physiques et procédures manuelles doivent être réalisés et validés par le responsable.",
        ],
    }
    return ClosingReport(
        date=day, fuseau="Europe/Paris", genere_le=datetime.now(timezone.utc),
        etiquettes_enregistrees=daily.etiquettes_enregistrees,
        impressions_confirmees=daily.impressions_confirmees,
        impressions_sans_date=daily.impressions_sans_date,
        statut=details["statut"], priorites=priorities, limites=details["limites"],
        revision=_revision(scope, details),
    )


async def load_closing_report(scope: str, day: date) -> ClosingReport:
    if cloud_link.relay_allowed():
        response = await cloud_link.relay_haccp_registry("GET", "/registre/cloture", params={"date": day.isoformat()})
        try:
            report = ClosingReport.model_validate(response.json())
            if report.date != day:
                raise ValueError("Date Cloud différente de la date demandée.")
        except ValueError as error:
            logger.error("[HACCP-CLOSING] Réponse Cloud invalide")
            raise HTTPException(502, "Le bilan HACCP Cloud est invalide. Aucun résultat ne peut être confirmé.") from error
        return report
    return await run_in_threadpool(read_closing_report, scope, day)


def _closing_pdf_bytes(report: ClosingReport, manager: str) -> bytes:
    lines = [
        f"Service du {report.date:%d/%m/%Y} — fuseau Europe/Paris.",
        f"Étiquettes enregistrées : {report.etiquettes_enregistrees}.",
        f"Envois d'impression confirmés : {report.impressions_confirmees}.",
        f"Anciennes confirmations sans date : {report.impressions_sans_date}.",
        "",
    ]
    if report.priorites:
        for number, item in enumerate(report.priorites, start=1):
            lines.extend([f"PRIORITÉ {number} — {item.titre} ({item.total})", item.action])
            for record in item.fiches:
                target = f" — date {record.date_cible:%d/%m/%Y}" if record.date_cible else ""
                lines.append(
                    f"Fiche {record.etiquette_id} — {record.produit} — lot {record.lot}{target} : {record.motif}"
                )
            if item.autres_fiches:
                lines.append(f"{item.autres_fiches} autre(s) fiche(s) du même type.")
            lines.append("")
    else:
        lines.append("Aucune alerte n'est enregistrée pour cette journée. Cela ne constitue pas une attestation de conformité.")
    lines.extend(["", *report.limites, "",
                  f"Vérification humaine déclarée par : {manager}.",
                  f"Date de validation : {datetime.now(PARIS):%d/%m/%Y à %H:%M} (Europe/Paris).",
                  "Cette déclaration nominative n'est pas une signature électronique ni une certification officielle."])
    from themis_pdf import build_consult_pdf
    document = build_consult_pdf(
        "PANTHÉON", "Bilan de clôture HACCP", "\n".join(lines),
        report.date.strftime("%d/%m/%Y"), signature_name=manager,
    )
    return document.getvalue()


def build_closing_pdf(scope: str, body: ClosingPdfRequest) -> bytes:
    report = read_closing_report(scope, body.date)
    if report.revision != body.revision:
        raise HTTPException(409, "Le registre a changé depuis le bilan. Rechargez-le, vérifiez les nouvelles données puis confirmez à nouveau.")
    try:
        return _closing_pdf_bytes(report, body.nom_responsable)
    except (OSError, ValueError) as error:
        logger.exception("[HACCP-CLOSING] Création du PDF impossible")
        raise HTTPException(503, "Le PDF de clôture n'a pas pu être généré.") from error


async def generate_closing_pdf(scope: str, body: ClosingPdfRequest) -> bytes:
    if cloud_link.relay_allowed():
        response = await cloud_link.relay_haccp_registry(
            "POST", "/registre/cloture/pdf", json=body.model_dump(mode="json"),
        )
        if response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/pdf":
            logger.error("[HACCP-CLOSING] Le relais a retourné un contenu autre qu'un PDF")
            raise HTTPException(502, "Le PDF de clôture Cloud est invalide.")
        if not response.content.startswith(b"%PDF-"):
            logger.error("[HACCP-CLOSING] Le relais a retourné un fichier PDF illisible")
            raise HTTPException(502, "Le PDF de clôture Cloud est invalide.")
        return response.content
    return await run_in_threadpool(build_closing_pdf, scope, body)


def _normalize(text: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFD", text.casefold())
                   if not unicodedata.combining(char)).replace("’", "'").strip()


def is_haccp_closing_request(text: str) -> bool:
    value = _normalize(text)
    return bool(
        re.search(r"\b(?:bilan|rapport|point|cloture)\b.*\b(?:fin de service|fermeture|cloture)\b", value)
        or re.search(r"\b(?:fais|faites|faire|prepare|preparer)\s+(?:le\s+)?point\s+(?:avant|de)\s+(?:la\s+)?(?:fermeture|fin de service)\b", value)
        or re.search(r"\b(?:bilan|rapport)\s+haccp\s+(?:du jour|journalier|quotidien)\b", value)
    )


def closing_report_day(text: str, today: date | None = None) -> date:
    from haccp_activity import _PERIOD, _date

    value = _normalize(text)
    matches = list(_PERIOD.finditer(value))
    today = today or datetime.now(PARIS).date()
    if not matches:
        if re.search(r"\b(?:demain|apres[- ]demain|semaine|mois|derniers? jours?)\b", value):
            raise ValueError("Le bilan de clôture est quotidien. Précise une seule date : aujourd'hui, hier ou JJ/MM/AAAA.")
        return today
    if len(matches) != 1 or matches[0].lastgroup not in {"date", "day"}:
        raise ValueError("Le bilan de clôture est quotidien. Précise une seule date : aujourd'hui, hier ou JJ/MM/AAAA.")
    match = matches[0]
    try:
        if match.lastgroup == "date":
            return _date(match.group())
        offset = 2 if match.group().startswith("avant") else 1 if match.group() == "hier" else 0
        return today - timedelta(days=offset)
    except (ValueError, OverflowError) as error:
        raise ValueError("Date de clôture invalide. Précise aujourd'hui, hier ou JJ/MM/AAAA.") from error


def closing_answer(report: ClosingReport) -> str:
    lines = [
        f"Bilan HACCP de fin de service — {report.date:%d/%m/%Y} (heure de Paris).",
        f"- Étiquettes enregistrées : {report.etiquettes_enregistrees}.",
        f"- Envois d'impression confirmés : {report.impressions_confirmees}.",
    ]
    if report.impressions_sans_date:
        lines.append(f"- Anciennes confirmations impossibles à répartir par jour : {report.impressions_sans_date}.")
    if report.priorites:
        lines.extend(["", "Priorités enregistrées :"])
        for item in report.priorites[:3]:
            lines.append(f"- {item.titre} ({item.total}) : {item.action}")
            lines.extend(
                f"  Fiche {record.etiquette_id} — {record.produit}, lot {record.lot} : {record.motif}"
                for record in item.fiches[:3]
            )
            if item.autres_fiches:
                lines.append(f"  {item.autres_fiches} autre(s) fiche(s) de ce type.")
    else:
        lines.extend(["", "Aucune alerte n'est enregistrée pour cette journée. Les contrôles physiques restent à réaliser et valider par le responsable."])
    lines.extend(["", "Le registre ne confirme pas le stock réel. Les dates proches concernent les fiches créées ce jour.",
                  "Un envoi confirmé par Windows ou le SDK n'est pas une preuve de sortie papier.",
                  "Ouvre le module HACCP > Fin de service pour consulter les fiches et valider un PDF après vérification humaine."])
    return "\n".join(lines)


async def answer_closing_question(text: str, scope: str) -> dict:
    try:
        day = closing_report_day(text)
    except ValueError as error:
        return {"answer": str(error), "state": "CLARIFICATION_REQUIRED"}
    report = await load_closing_report(scope, day)
    return {
        "answer": closing_answer(report),
        "state": "READ_ONLY",
        "haccp_closing_report": report.model_dump(mode="json"),
    }
