"""Comptages du registre et des confirmations d'impression, sans appel a un modele."""
import logging
import re
import unicodedata
from datetime import date, datetime, time, timedelta, timezone
from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import and_, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

import cloud_link
from haccp_database import get_engine
from models.haccp import EtiquetteHaccp
from models.haccp_printing import HaccpPrintJob
from schemas.haccp import PARIS

logger = logging.getLogger(__name__)
MAX_REPORT_DAYS = 366
Count = Annotated[int, Field(strict=True, ge=0)]


def validate_period(start: date, end: date) -> None:
    if start > end:
        raise ValueError("La date de début doit précéder ou égaler la date de fin.")
    if (end - start).days >= MAX_REPORT_DAYS:
        raise ValueError("Demande une période de 366 jours maximum pour le détail quotidien.")
    if start == date.min or end == date.max:
        raise ValueError("Cette période dépasse les limites du calendrier.")


class HaccpActivityDay(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: date
    etiquettes_enregistrees: Count
    impressions_confirmees: Count


class HaccpActivity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date_debut: date
    date_fin: date
    fuseau: Literal["Europe/Paris"]
    genere_le: AwareDatetime
    jours: list[HaccpActivityDay] = Field(min_length=1, max_length=MAX_REPORT_DAYS)
    etiquettes_enregistrees: Count
    impressions_confirmees: Count
    impressions_sans_date: Count

    @model_validator(mode="after")
    def consistent(self) -> "HaccpActivity":
        validate_period(self.date_debut, self.date_fin)
        expected = [self.date_debut + timedelta(days=i) for i in range((self.date_fin - self.date_debut).days + 1)]
        if [item.date for item in self.jours] != expected:
            raise ValueError("Le bilan doit contenir chaque jour de la période, dans l'ordre.")
        if (self.etiquettes_enregistrees != sum(item.etiquettes_enregistrees for item in self.jours)
                or self.impressions_confirmees != sum(item.impressions_confirmees for item in self.jours)):
            raise ValueError("Les totaux ne correspondent pas au détail quotidien.")
        return self


def read_activity(scope: str, start: date, end: date) -> HaccpActivity:
    validate_period(start, end)
    first = datetime.combine(start, time.min, PARIS).astimezone(timezone.utc).replace(tzinfo=None)
    after_last = datetime.combine(end + timedelta(days=1), time.min, PARIS).astimezone(timezone.utc).replace(tzinfo=None)
    days = {
        start + timedelta(days=i): HaccpActivityDay(
            date=start + timedelta(days=i), etiquettes_enregistrees=0, impressions_confirmees=0,
        )
        for i in range((end - start).days + 1)
    }
    try:
        with Session(get_engine()) as db:
            # Un meme instantane SQLite pour les deux compteurs, meme pendant une impression.
            db.connection().exec_driver_sql("BEGIN")
            for timestamp, predicate, field in (
                (EtiquetteHaccp.created_at, EtiquetteHaccp.scope_key == scope, "etiquettes_enregistrees"),
                (HaccpPrintJob.accepted_at, and_(
                    HaccpPrintJob.scope_key == scope, HaccpPrintJob.status == "accepted",
                ), "impressions_confirmees"),
            ):
                # Le fuseau metier, et non celui du PC ou du serveur, definit chaque jour.
                day = func.haccp_paris_day(timestamp)
                rows = db.execute(select(day, func.count()).where(
                    predicate, timestamp >= first, timestamp < after_last,
                ).group_by(day))
                for local_day, count in rows:
                    item = days[date.fromisoformat(local_day)]
                    setattr(item, field, getattr(item, field) + count)
            undated = db.scalar(select(func.count()).select_from(HaccpPrintJob).where(
                HaccpPrintJob.scope_key == scope, HaccpPrintJob.status == "accepted",
                HaccpPrintJob.accepted_at.is_(None),
            ))
    except (OSError, SQLAlchemyError) as error:
        logger.exception("[HACCP-ACTIVITY] Lecture des compteurs impossible")
        raise HTTPException(503, "Le bilan HACCP est indisponible. Aucun chiffre n'a été calculé.") from error
    return HaccpActivity(
        date_debut=start, date_fin=end, fuseau="Europe/Paris",
        genere_le=datetime.now(timezone.utc), jours=list(days.values()),
        etiquettes_enregistrees=sum(item.etiquettes_enregistrees for item in days.values()),
        impressions_confirmees=sum(item.impressions_confirmees for item in days.values()),
        impressions_sans_date=undated,
    )


async def load_activity(scope: str, start: date, end: date) -> HaccpActivity:
    try:
        validate_period(start, end)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    if cloud_link.relay_allowed():
        response = await cloud_link.relay_haccp_registry("GET", "/registre/activite", params={
            "date_debut": start.isoformat(), "date_fin": end.isoformat(),
        })
        try:
            report = HaccpActivity.model_validate(response.json())
            if report.date_debut != start or report.date_fin != end:
                raise ValueError("Période reçue différente de la période demandée.")
        except ValueError as error:
            logger.error("[HACCP-ACTIVITY] Bilan Cloud invalide")
            raise HTTPException(502, "Le bilan HACCP Cloud est invalide. Aucun chiffre ne peut être confirmé.") from error
        return report
    return await run_in_threadpool(read_activity, scope, start, end)


def _normalized(text: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFD", text.casefold())
                   if not unicodedata.combining(char)).replace("’", "'").replace("σirius", "sirius").strip()


def is_haccp_activity_request(text: str) -> bool:
    value = _normalized(text)
    return (
        re.search(r"\betiquettes?\b", value) is not None
        and (re.search(r"\b(?:combien|nombre|total)(?:\s+total)?\s+(?:(?:d[' ]|des?\s+)(?:(?:mes|nos|les)\s+)?)?etiquettes?\b", value) is not None
             or re.search(r"\b(?:compteurs?|comptage|statistiques?|stats|bilan|rapport)\b", value) is not None
             or re.search(r"\bcombien\b.*\b(?:edite\w*|imprime\w*|enregistre\w*|cree\w*)\b.*\betiquettes?\b", value) is not None
             or re.search(r"\bcompte\s+(?:les|mes|nos|toutes les)\s+etiquettes?\b", value) is not None)
        and re.search(r"\b(?:prix|couts?|coute\w*)\b|\bcombien\s+(?:de\s+)?(?:temps|jours?|heures?)\b", value) is None
    )


_DATE = r"(?:\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{4})"
_PERIOD = re.compile(
    rf"(?P<range>\bdu\s+{_DATE}\s+au\s+{_DATE}\b)"
    rf"|(?P<date>\b{_DATE}\b)"
    r"|(?P<day>\b(?:avant[- ]hier|hier|aujourd[' ]?hui|ce jour|du jour)\b)"
    r"|(?P<week>\b(?:cette semaine|semaine derniere)\b)"
    r"|(?P<month>\b(?:ce mois(?:[- ]ci)?|mois dernier)\b)"
    r"|(?P<rolling>(?<![\w.+-])(?:\d+|sept|quatorze|quinze|trente)\s+derniers?\s+jours?\b)"
)
_REPORT_WORDS = set("""
    sirius zirius zeus bonjour salut merci svp s il te vous plait
    je j tu nous on ils elles ai as a avez avons ont est sont ete combien nombre total
    compte compteur compteurs comptage statistiques statistique stats bilan rapport
    etiquette etiquettes haccp impression impressions
    cree creee crees creees creer genere generee generes generees generer
    enregistre enregistree enregistres enregistrees enregistrer
    edite editee edites editees editer imprime imprimee imprimes imprimees imprimer
    envoye envoyee envoyes envoyees envoyer confirme confirmee confirmes confirmees
    fait faite faits faites le la les l de d du des au aux pour par en et ou un une
    ce cette ces mon ma mes notre nos tout tous toutes moi me dis dit dire donne donner sur
    montre montrer affiche afficher fais faire veux voudrais souhaite savoir sais peux
    peut pourrais pouvez que qui t y jour jours chaque detail detaille quotidien quotidiennement
""".split())
_PERIOD_HELP = (
    "Précise une période pour les deux compteurs HACCP : aujourd'hui, hier, cette semaine, "
    "ce mois-ci, les 7 derniers jours, ou du JJ/MM/AAAA au JJ/MM/AAAA."
)
_PERIOD_REPLY_WORDS = set("pour sur et le la les merci svp s il te vous plait".split())


def activity_question(text: str, history: list[dict]) -> str | None:
    if is_haccp_activity_request(text):
        return text
    if len(history) < 2:
        return None
    question, answer = history[-2:]
    previous = question.get("content", "")
    if (question.get("role") != "user" or answer.get("role") != "assistant"
            or answer.get("content") != _PERIOD_HELP
            or not is_haccp_activity_request(previous) or _PERIOD.search(_normalized(previous))):
        return None
    value = _normalized(text)
    periods = list(_PERIOD.finditer(value))
    if len(periods) != 1:
        return None
    period = periods[0]
    remaining = value[:period.start()] + " " + value[period.end():]
    if set(re.findall(r"[a-z0-9]+", remaining)) - _PERIOD_REPLY_WORDS:
        return None
    return f"{previous} {text}"


def _date(value: str) -> date:
    if "/" in value:
        day, month, year = (int(part) for part in value.split("/"))
        return date(year, month, day)
    return date.fromisoformat(value)


def activity_period(text: str, today: date | None = None) -> tuple[date, date]:
    value = _normalized(text)
    matches = list(_PERIOD.finditer(value))
    if len(matches) != 1:
        raise ValueError(_PERIOD_HELP)
    match = matches[0]
    today = today if today is not None else datetime.now(PARIS).date()
    remaining = value[:match.start()] + " " + value[match.end():]
    if set(re.findall(r"[a-z0-9]+", remaining)) - _REPORT_WORDS:
        raise ValueError("Ce bilan compte toutes les étiquettes du registre accessible, sans filtre produit, opérateur ou restaurant. " + _PERIOD_HELP)
    try:
        if match.lastgroup == "range":
            start, end = (_date(token) for token in re.findall(_DATE, match.group()))
        elif match.lastgroup == "date":
            if re.search(r"\b(?:du|au|entre)\s*$", value[:match.start()]):
                raise ValueError(_PERIOD_HELP)
            start = end = _date(match.group())
        elif match.lastgroup == "day":
            offset = 2 if match.group().startswith("avant") else 1 if match.group() == "hier" else 0
            start = end = today - timedelta(days=offset)
        elif match.lastgroup == "week":
            monday = today - timedelta(days=today.weekday())
            start, end = (monday - timedelta(days=7), monday - timedelta(days=1)) if match.group() == "semaine derniere" else (monday, today)
        elif match.lastgroup == "month":
            first = today.replace(day=1)
            end = first - timedelta(days=1) if match.group() == "mois dernier" else today
            start = end.replace(day=1)
        else:
            token = match.group().split()[0]
            count = {"sept": 7, "quatorze": 14, "quinze": 15, "trente": 30}.get(token)
            if count is None:
                count = int(token)
            if not 1 <= count <= MAX_REPORT_DAYS:
                raise ValueError("Demande entre 1 et 366 jours pour ce bilan.")
            start, end = today - timedelta(days=count - 1), today
    except (ValueError, OverflowError) as error:
        raise ValueError("La période demandée n'est pas valide. " + _PERIOD_HELP) from error
    validate_period(start, end)
    return start, end


def activity_answer(report: HaccpActivity) -> str:
    start, end = report.date_debut, report.date_fin
    period = f"Le {start:%d/%m/%Y}" if start == end else f"Du {start:%d/%m/%Y} au {end:%d/%m/%Y}"
    lines = [
        f"{period}, dans ton registre HACCP (heure de Paris) :",
        f"- Étiquettes enregistrées : {report.etiquettes_enregistrees}.",
        f"- Envois d'impression confirmés et datés : {report.impressions_confirmees}.",
    ]
    if len(report.jours) > 1:
        lines += ["", "Détail par jour — enregistrées / envois confirmés :"]
        lines += [f"- {item.date:%d/%m/%Y} : {item.etiquettes_enregistrees} / {item.impressions_confirmees}."
                  for item in report.jours]
    if report.impressions_sans_date:
        lines += ["", f"Dans ce registre, {report.impressions_sans_date} ancien(s) envoi(s) confirmé(s) "
                  "n'ont pas de date de confirmation : ils ne peuvent pas être répartis par jour et sont exclus de ce bilan."]
    lines += ["", "Un envoi confirmé par Windows ou le SDK Brother ne garantit pas la sortie papier. "
              "Les impressions manuelles du navigateur et les étiquettes TEST hors registre ne sont pas comptées."]
    return "\n".join(lines)


async def answer_activity_question(text: str, scope: str) -> dict:
    try:
        start, end = activity_period(text)
    except ValueError as error:
        result = {"answer": str(error), "state": "CLARIFICATION_REQUIRED"}
        if str(error) == _PERIOD_HELP and not _PERIOD.search(_normalized(text)):
            result["haccp_activity_pending"] = text
        return result
    report = await load_activity(scope, start, end)
    return {"answer": activity_answer(report), "state": "READ_ONLY", "haccp_activity": report.model_dump(mode="json")}
