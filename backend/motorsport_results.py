"""Résultats officiels de sport auto pour les questions « qui a gagné », « classement », etc.

Les titres d'actualité donnent rarement un classement complet : pour la F1 (API Jolpica,
successeur d'Ergast) et le MotoGP/Moto2/Moto3 (API publique de motogp.com), on lit les
données structurées. Les autres disciplines restent couvertes par la recherche d'actualités.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
import unicodedata
from datetime import date, datetime, timezone

import httpx

logger = logging.getLogger(__name__)

JOLPICA_F1 = "https://api.jolpi.ca/ergast/f1"
MOTOGP_RESULTS = "https://api.motogp.pulselive.com/motogp/v1/results"
_CACHE_SECONDS = 10 * 60
_cache: dict[str, tuple[float, str]] = {}

_JOURS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
_MOIS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet",
         "août", "septembre", "octobre", "novembre", "décembre")

_F1_RE = re.compile(r"\b(?:f1|formule\s*(?:1|un)|formula\s*(?:1|one))\b")
_MOTOGP_RE = re.compile(r"\bmoto\s*gp\b")
_MOTO2_RE = re.compile(r"\bmoto\s*2\b")
_MOTO3_RE = re.compile(r"\bmoto\s*3\b")
_GRAND_PRIX_RE = re.compile(r"\b(?:grand\s*prix|gp)\b")
_OTHER_MOTORSPORT_RE = re.compile(
    r"\b(?:sport\s*auto|course\s*auto|rallye|wrc|endurance|wec|24\s*heures\s*du\s*mans|le\s*mans|"
    r"formule\s*e|formula\s*e|indycar|nascar|dakar|dtm|superbike|wsbk|gt\s*world|elms|imsa|"
    r"formule\s*2|formule\s*3|f2|f3)\b"
)


def _normalize(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", str(text or "").lower())
    return "".join(char for char in decomposed if unicodedata.category(char) != "Mn")


def requested_series(prompt: str) -> list[str]:
    """Séries disposant d'une source officielle structurée et citées dans la question."""
    text = _normalize(prompt)
    if _OTHER_MOTORSPORT_RE.search(text) and not (_F1_RE.search(text) or _MOTOGP_RE.search(text)):
        return []
    series = []
    if _F1_RE.search(text):
        series.append("f1")
    for name, pattern in (("motogp", _MOTOGP_RE), ("moto2", _MOTO2_RE), ("moto3", _MOTO3_RE)):
        if pattern.search(text):
            series.append(name)
    if not series and _GRAND_PRIX_RE.search(text):
        series = ["f1", "motogp"]
    return series


def is_motorsport_question(prompt: str) -> bool:
    text = _normalize(prompt)
    return bool(requested_series(prompt) or _OTHER_MOTORSPORT_RE.search(text))


def _french_date(value) -> str:
    if isinstance(value, str):
        value = date.fromisoformat(value[:10])
    if isinstance(value, datetime):
        value = value.date()
    return f"{_JOURS[value.weekday()]} {value.day} {_MOIS[value.month - 1]} {value.year}"


async def _get_json(client: httpx.AsyncClient, url: str, **params):
    response = await client.get(url, params=params or None)
    response.raise_for_status()
    return response.json()


async def _f1_summary(client: httpx.AsyncClient) -> str:
    last, drivers, teams, upcoming = await asyncio.gather(
        _get_json(client, f"{JOLPICA_F1}/current/last/results.json"),
        _get_json(client, f"{JOLPICA_F1}/current/driverStandings.json"),
        _get_json(client, f"{JOLPICA_F1}/current/constructorStandings.json"),
        _get_json(client, f"{JOLPICA_F1}/current/next.json"),
    )
    lines = []
    races = last["MRData"]["RaceTable"]["Races"]
    if races:
        race = races[0]
        lines.append(
            f"FORMULE 1 {race['season']} — dernière course disputée : {race['raceName']}, "
            f"{_french_date(race['date'])} (manche {race['round']})."
        )
        for result in race["Results"][:10]:
            driver = result["Driver"]
            position = result["positionText"]
            status = "" if position.isdigit() else f" ({result.get('status', 'non classé')})"
            lines.append(
                f"  {position}. {driver['givenName']} {driver['familyName']} "
                f"({result['Constructor']['name']}) — {result['points']} pts{status}"
            )
    standings = drivers["MRData"]["StandingsTable"]["StandingsLists"]
    if standings:
        table = standings[0]
        ranking = ", ".join(
            f"{row['position']}. {row['Driver']['givenName']} {row['Driver']['familyName']} {row['points']} pts"
            for row in table["DriverStandings"][:10]
        )
        lines.append(f"Championnat pilotes F1 après la manche {table['round']} : {ranking}.")
    team_standings = teams["MRData"]["StandingsTable"]["StandingsLists"]
    if team_standings:
        ranking = ", ".join(
            f"{row['position']}. {row['Constructor']['name']} {row['points']} pts"
            for row in team_standings[0]["ConstructorStandings"][:5]
        )
        lines.append(f"Championnat constructeurs F1 : {ranking}.")
    next_races = upcoming["MRData"]["RaceTable"]["Races"]
    if next_races:
        race = next_races[0]
        lines.append(f"Prochaine course F1 : {race['raceName']}, {_french_date(race['date'])} (manche {race['round']}).")
    return "\n".join(lines)


_MOTOGP_CATEGORY = {"motogp": "MotoGP", "moto2": "Moto2", "moto3": "Moto3"}


def _category_name(raw: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", str(raw or ""))


async def _motogp_summary(client: httpx.AsyncClient, series: str) -> str:
    wanted = _MOTOGP_CATEGORY[series]
    seasons = await _get_json(client, f"{MOTOGP_RESULTS}/seasons")
    season = next((item for item in seasons if item.get("current")), None)
    if not season:
        return ""
    events = await _get_json(client, f"{MOTOGP_RESULTS}/events", seasonUuid=season["id"])
    races = [event for event in events if not event.get("test")]
    finished = sorted(
        (event for event in races if str(event.get("status", "")).upper() == "FINISHED"),
        key=lambda event: event.get("date_end") or "",
    )
    lines = []
    if finished:
        event = finished[-1]
        categories = await _get_json(client, f"{MOTOGP_RESULTS}/categories", eventUuid=event["id"])
        category = next((item for item in categories if _category_name(item.get("name")) == wanted), None)
        if category:
            sessions = await _get_json(
                client, f"{MOTOGP_RESULTS}/sessions", eventUuid=event["id"], categoryUuid=category["id"],
            )
            race = next((item for item in reversed(sessions) if item.get("type") == "RAC"), None)
            if race:
                classification = await _get_json(client, f"{MOTOGP_RESULTS}/session/{race['id']}/classification", test="false")
                lines.append(
                    f"{wanted} {season['year']} — dernière course disputée : {str(event.get('name', '')).title()}, "
                    f"{_french_date(event['date_end'])}."
                )
                for row in classification.get("classification", [])[:10]:
                    rider = row.get("rider") or {}
                    team = (row.get("team") or {}).get("name", "")
                    position = row.get("position") or row.get("status") or "-"
                    lines.append(f"  {position}. {rider.get('full_name', '?')} ({team}) — {row.get('points', 0)} pts")
            standings = await _get_json(
                client, f"{MOTOGP_RESULTS}/standings", seasonUuid=season["id"], categoryUuid=category["id"],
            )
            ranking = ", ".join(
                f"{row.get('position')}. {(row.get('rider') or {}).get('full_name', '?')} {row.get('points', 0)} pts"
                for row in (standings.get("classification") or [])[:10]
            )
            if ranking:
                lines.append(f"Championnat {wanted} : {ranking}.")
    upcoming = sorted(
        (event for event in races if str(event.get("status", "")).upper() != "FINISHED"
         and (event.get("date_start") or "") >= datetime.now(timezone.utc).date().isoformat()),
        key=lambda event: event.get("date_start") or "",
    )
    if upcoming:
        event = upcoming[0]
        lines.append(f"Prochain Grand Prix {wanted} : {str(event.get('name', '')).title()}, à partir du {_french_date(event['date_start'])}.")
    return "\n".join(lines)


async def _series_summary(client: httpx.AsyncClient, series: str) -> str:
    cached = _cache.get(series)
    if cached and time.monotonic() - cached[0] < _CACHE_SECONDS:
        return cached[1]
    summary = await (_f1_summary(client) if series == "f1" else _motogp_summary(client, series))
    if summary:
        _cache[series] = (time.monotonic(), summary)
    return summary


async def motorsport_context(prompt: str, *, timeout: float = 5.0) -> str:
    """Bloc de données officielles à placer avant les articles, ou "" si non applicable."""
    series = requested_series(prompt)
    if not series:
        return ""
    async with httpx.AsyncClient(
        timeout=timeout, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0 SIRIUS"},
    ) as client:
        outcomes = await asyncio.gather(
            *(_series_summary(client, name) for name in series), return_exceptions=True,
        )
    blocks = []
    for name, outcome in zip(series, outcomes):
        if isinstance(outcome, BaseException):
            logger.warning("[SPORT AUTO] source officielle %s indisponible : %r", name, outcome)
        elif outcome:
            blocks.append(outcome)
    if not blocks:
        return ""
    return (
        "DONNÉES OFFICIELLES SPORT AUTO (résultats et classements structurés, à utiliser en priorité ; "
        "elles prévalent sur les titres d'articles en cas de divergence ; ignore-les si la question "
        "ne porte pas sur ces courses) :\n" + "\n\n".join(blocks)
    )
