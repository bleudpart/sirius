# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Sections ajoutées au briefing du jour : HACCP, agenda et veille locale.

Chaque section lit une source autorisée pour le compte connecté, avec un délai maximal.
Une source absente ou en panne est signalée telle quelle ; rien n'est déduit ni exécuté.
"""

import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import HTTPException

import osiris_watch
from routes.veille import load_veille_settings

logger = logging.getLogger("sirius.briefing")
PARIS = ZoneInfo("Europe/Paris")
SECTION_TIMEOUT = 7.0
MAX_AGENDA_ITEMS = 5
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


@dataclass
class BriefingExtras:
    payload: dict
    lead: list = field(default_factory=list)
    tail: list = field(default_factory=list)


def _clean(value, limit=120) -> str:
    text = " ".join(_CONTROL.sub(" ", value if isinstance(value, str) else "").split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


async def _guard(label, coroutine) -> dict:
    try:
        return await asyncio.wait_for(coroutine, SECTION_TIMEOUT)
    except asyncio.TimeoutError:
        return {"available": False, "detail": f"{label} n'a pas répondu à temps."}
    except HTTPException as error:
        return {"available": False, "detail": f"{label} est indisponible : {error.detail}"}
    except Exception:
        logger.exception("[BRIEFING] Section indisponible : %s", label)
        return {"available": False, "detail": f"{label} est indisponible pour le moment."}


def _closing_summary(report) -> dict:
    return {
        "date": report.date.isoformat(),
        "etiquettes": report.etiquettes_enregistrees,
        "impressions_confirmees": report.impressions_confirmees,
        "priorites": [{"code": item.code, "niveau": item.niveau, "titre": item.titre, "total": item.total}
                      for item in report.priorites],
    }


async def _haccp_section(request, today, haccp_scope, load_closing) -> dict:
    try:
        scope = await haccp_scope(request)
    except HTTPException as error:
        return {"available": False, "detail": f"Registre HACCP des étiquettes non accessible : {error.detail}"}
    current, previous = await asyncio.gather(
        load_closing(scope, today), load_closing(scope, today - timedelta(days=1)),
    )
    return {"available": True, "today": _closing_summary(current), "yesterday": _closing_summary(previous)}


def _priorities(items) -> str:
    return " ; ".join(f"{item['titre']} ({item['total']})" for item in items)


def haccp_lines(section) -> list[str]:
    if not section["available"]:
        return ["", f"HACCP : {section['detail']}"]
    today, yesterday = section["today"], section["yesterday"]
    lines = ["", (
        f"HACCP — registre des étiquettes : aujourd'hui {today['etiquettes']} étiquette(s) enregistrée(s) "
        f"et {today['impressions_confirmees']} impression(s) confirmée(s)."
    )]
    if today["priorites"]:
        lines.append(f"- À vérifier aujourd'hui : {_priorities(today['priorites'])}.")
    if yesterday["priorites"]:
        day = datetime.fromisoformat(yesterday["date"])
        lines.append(f"- Bilan d'hier ({day:%d/%m}), recalculé maintenant : {_priorities(yesterday['priorites'])}.")
    if today["priorites"] or yesterday["priorites"]:
        lines.append("- Détail et validation dans HACCP > Fin de service ; les contrôles physiques restent humains.")
    else:
        lines.append("- Aucune alerte enregistrée hier ni aujourd'hui ; les contrôles physiques restent à réaliser par le responsable.")
    return lines


def _ms_event(item) -> dict:
    start = item.get("debut") or ""
    return {"provider": "Outlook", "title": _clean(item.get("titre")) or "(sans titre)", "all_day": bool(item.get("journee")),
            "time": "" if item.get("journee") else start[11:16], "location": _clean(item.get("lieu"))}


def _google_event(item) -> dict:
    time = ""
    if not item.get("all_day"):
        try:
            time = datetime.fromisoformat(item["start"].replace("Z", "+00:00")).astimezone(PARIS).strftime("%H:%M")
        except (KeyError, TypeError, ValueError):
            time = ""
    return {"provider": "Google Agenda", "title": _clean(item.get("title")) or "(sans titre)",
            "all_day": bool(item.get("all_day")), "time": time, "location": _clean(item.get("location"))}


async def _agenda_section(db, uid) -> dict:
    from google_connection import read_tokens
    from microsoft_graph import microsoft_connection, ms_today_events
    import google_calendar

    jobs = {}
    if await microsoft_connection(db, uid):
        jobs["Outlook"] = ms_today_events(db, uid)
    google = await db.google_calendar.find_one({"_id": uid})
    try:
        google_connected = bool(read_tokens(google))
    except HTTPException:
        google_connected = True
    if google_connected:
        jobs["Google Agenda"] = google_calendar.google_today_events(db, uid)
    results = await asyncio.gather(*jobs.values(), return_exceptions=True)
    connected, events, errors = [], [], []
    for provider, result in zip(jobs, results):
        if isinstance(result, BaseException):
            if not isinstance(result, HTTPException):
                logger.error("[BRIEFING] Agenda %s illisible", provider, exc_info=result)
            errors.append({"provider": provider, "detail": str(result.detail) if isinstance(result, HTTPException)
                           else "lecture impossible pour le moment."})
            continue
        connected.append(provider)
        events.extend(_ms_event(item) if provider == "Outlook" else _google_event(item) for item in result)
    events.sort(key=lambda item: (not item["all_day"], item["time"]))
    return {"available": True, "connected": connected, "events": events, "errors": errors}


def agenda_lines(section) -> list[str]:
    if not section["available"]:
        return ["", f"Agenda : {section['detail']}"]
    connected, events = section["connected"], section["events"]
    if not connected and not section["errors"]:
        return ["", "Agenda : aucun agenda Google ou Outlook connecté."]
    lines = [""]
    if connected:
        count = f"{len(events)} rendez-vous" if events else "aucun rendez-vous"
        lines.append(f"Agenda du jour ({', '.join(connected)}) : {count}.")
    for item in events[:MAX_AGENDA_ITEMS]:
        when = "Toute la journée" if item["all_day"] or not item["time"] else item["time"].replace(":", " h ")
        place = f" — {item['location']}" if item["location"] else ""
        origin = f" ({item['provider']})" if len(connected) > 1 else ""
        lines.append(f"- {when} : {item['title']}{place}{origin}.")
    if len(events) > MAX_AGENDA_ITEMS:
        lines.append(f"- {len(events) - MAX_AGENDA_ITEMS} autre(s) rendez-vous dans l'agenda.")
    for error in section["errors"]:
        lines.append(f"- Agenda {error['provider']} indisponible : {error['detail']}")
    return lines


async def _veille_section(db, uid) -> dict:
    return {"available": True, "report": await osiris_watch.build_watch(await load_veille_settings(db, uid))}


def veille_lines(section) -> list[str]:
    if not section["available"]:
        return ["", f"Veille : {section['detail']}"]
    return osiris_watch.watch_lines(section["report"])


def make_briefing_extras(db, *, haccp_scope, load_closing):
    async def extras(request, uid, today) -> BriefingExtras:
        haccp, agenda, veille = await asyncio.gather(
            _guard("Le registre HACCP", _haccp_section(request, today, haccp_scope, load_closing)),
            _guard("L'agenda", _agenda_section(db, uid)),
            _guard("La veille", _veille_section(db, uid)),
        )
        return BriefingExtras(
            payload={"haccp": haccp, "agenda": agenda, "veille": veille},
            lead=haccp_lines(haccp) + agenda_lines(agenda),
            tail=veille_lines(veille),
        )

    return extras
