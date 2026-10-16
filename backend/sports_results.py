"""Selected multisport scoreboards. ESPN's public feeds have no availability SLA."""

import asyncio
import logging
import re
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx

logger = logging.getLogger(__name__)
PARIS = ZoneInfo("Europe/Paris")
BASE_URL = "https://site.api.espn.com/apis/site/v2/sports"
LEAGUES = (
    ("Football", "Ligue 1", "soccer/fra.1"),
    ("Football", "Premier League", "soccer/eng.1"),
    ("Football", "Liga", "soccer/esp.1"),
    ("Football", "Bundesliga", "soccer/ger.1"),
    ("Football", "Serie A", "soccer/ita.1"),
    ("Football", "Ligue des champions", "soccer/uefa.champions"),
    ("Rugby", "Top 14", "rugby/270559"),
    ("Rugby", "Premiership", "rugby/267979"),
    ("Basket", "NBA", "basketball/nba"),
    ("Basket", "WNBA", "basketball/wnba"),
    ("Tennis", "ATP", "tennis/atp"),
    ("Tennis", "WTA", "tennis/wta"),
)
_cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}
_SPORT = re.compile(
    r"\b(?:sports?|sportifs?|sportives?|football|foot|rugby|tennis|basket(?:ball)?|nba|wnba|"
    r"ligue 1|premier league|liga|bundesliga|serie a|ligue des champions|top 14|atp|wta|"
    r"handball|volley(?:ball)?|athletisme|cyclisme|natation|hockey)\b"
)
_RESULT = re.compile(r"\b(?:resultats?|scores?|gagne|gagnants?|vainqueurs?|matchs?|matches|rencontres?)\b")


def sports_question(prompt: str) -> str:
    return re.split(
        r"CONTEXTE\s+(?:DU DERNIER BRIEFING|[—-]\s*BULLETIN)",
        str(prompt or ""), maxsplit=1, flags=re.I,
    )[0].strip()


def _normalize(text: str) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFD", text.lower())
        if unicodedata.category(char) != "Mn"
    ).replace("’", "'")


def is_sports_results_question(prompt: str) -> bool:
    text = _normalize(sports_question(prompt))
    return bool((_SPORT.search(text) and _RESULT.search(text)) or re.fullmatch(
        r"(?:(?:sirius[, ]*|donne[- ]moi |affiche |quels sont )*)"
        r"(?:les? )?resultats?(?: sportifs?)?(?: (?:du jour|d'aujourd'hui|aujourd'hui|hier))?[ ?.!]*", text,
    ))


def _requested_day(question: str, now: datetime) -> date | None:
    text = _normalize(question)
    if re.search(r"\b(?:entre|depuis|jusqu|du\s+\d+.*\bau\s+\d+|et\s+le\s+\d+)\b", text):
        return None
    explicit = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", text)
    if explicit:
        try:
            return date.fromisoformat(explicit[1])
        except ValueError:
            return None
    numeric = re.search(r"\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?\b", text)
    if numeric:
        try:
            return date(int(numeric[3] or now.astimezone(PARIS).year), int(numeric[2]), int(numeric[1]))
        except ValueError:
            return None
    months = ("janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet",
              "aout", "septembre", "octobre", "novembre", "decembre")
    named = re.search(r"\b(\d{1,2})(?:er)?\s+(" + "|".join(months) + r")(?:\s+(\d{4}))?\b", text)
    if named:
        try:
            return date(int(named[3] or now.astimezone(PARIS).year), months.index(named[2]) + 1, int(named[1]))
        except ValueError:
            return None
    if re.search(r"\b(?:week[- ]?end|semaine|mois|demain|\d{4}|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|le\s+\d+|"
                 + "|".join(months) + r")\b", text):
        return None
    if re.search(r"\bavant[- ]hier\b", text):
        return now.astimezone(PARIS).date() - timedelta(days=2)
    return now.astimezone(PARIS).date() - timedelta(days=bool(re.search(r"\bhier\b", text)))


def _selected_leagues(question: str) -> list[tuple[str, str, str]]:
    text = _normalize(question)
    explicit = [league for league in LEAGUES if re.search(
        r"\b" + re.escape(_normalize(league[1])) + r"\b", text,
    )]
    if explicit:
        return explicit
    groups = [
        sport for sport, pattern in (
            ("Football", r"\b(?:foot(?:ball)?|ligue 1|premier league|liga|bundesliga|serie a|ligue des champions)\b"),
            ("Rugby", r"\b(?:rugby|top 14)\b"),
            ("Basket", r"\b(?:basket(?:ball)?|nba|wnba)\b"),
            ("Tennis", r"\b(?:tennis|atp|wta)\b"),
        ) if re.search(pattern, text)
    ]
    if not groups and re.search(r"\b(?:handball|volley(?:ball)?|athletisme|cyclisme|natation|hockey)\b", text):
        return []
    return [league for league in LEAGUES if not groups or league[0] in groups]


def _name(competitor: dict) -> str:
    entity = competitor.get("team") or competitor.get("athlete") or {}
    return str(entity.get("displayName") or "").strip()


def _score(value) -> str | None:
    if isinstance(value, dict):
        value = value.get("displayValue", value.get("value"))
    if isinstance(value, bool) or value is None or not re.fullmatch(r"\d+(?:\.\d+)?", str(value)):
        return None
    return re.sub(r"\.0+$", "", str(value))


def parse_scoreboard(payload: dict, sport: str, league: str, day: date, now: datetime) -> list[dict]:
    matches = []
    seen = set()
    for event in payload.get("events", []):
        competitions = event.get("competitions", [])
        if sport == "Tennis":
            competitions = [match for group in event.get("groupings", []) for match in group.get("competitions", [])]
        for match in competitions:
            try:
                start = datetime.fromisoformat(str(
                    match.get("date") or (event.get("date") if sport != "Tennis" else "") or ""
                ).replace("Z", "+00:00"))
            except ValueError:
                continue
            if start.tzinfo is None or start.astimezone(PARIS).date() != day:
                continue
            competitors = match.get("competitors", [])
            if len(competitors) != 2 or not all(_name(player) and _name(player) != "TBD" for player in competitors):
                continue
            # Team scores are conventionally presented home first; tennis keeps the feed order.
            if sport != "Tennis":
                competitors = sorted(competitors, key=lambda player: player.get("homeAway") != "home")
            status = (match.get("status") or event.get("status") or {}).get("type", {})
            status_name = status.get("name", "")
            if any(word in status_name for word in ("POSTPONED", "CANCELED", "CANCELLED", "SUSPENDED", "DELAYED")):
                state = "reporté/interrompu"
            elif status.get("completed") and status.get("state") == "post":
                state = "terminé"
            elif status.get("state") == "in":
                state = "en cours"
            elif status.get("state") == "pre":
                state = "à venir"
            else:
                continue
            if start > now and state in ("terminé", "en cours"):
                continue
            scores = [_score(player.get("score")) for player in competitors]
            score = None
            if state in ("terminé", "en cours"):
                if sport == "Tennis":
                    sets = [player.get("linescores", []) for player in competitors]
                    if len(sets[0]) == len(sets[1]) and sets[0]:
                        pairs = [(_score(a.get("value")), _score(b.get("value"))) for a, b in zip(*sets)]
                        if all(a is not None and b is not None for a, b in pairs):
                            score = ", ".join(f"{a}-{b}" for a, b in pairs)
                elif all(value is not None for value in scores):
                    score = " – ".join(scores)
                    penalties = [_score(player.get("shootoutScore")) for player in competitors]
                    if all(value is not None for value in penalties):
                        score += " (t.a.b. " + " – ".join(penalties) + ")"
            identifier = str(match.get("id") or f"{start.isoformat()}:{[_name(p) for p in competitors]}")
            if identifier in seen:
                continue
            seen.add(identifier)
            matches.append({
                "sport": sport, "competition": f"{league} — {event.get('name', '')}" if sport == "Tennis" else league,
                "participants": " / ".join(_name(player) for player in competitors),
                "score": score, "state": state, "date": start.astimezone(PARIS).isoformat(),
            })
    return matches


async def sports_results_context(prompt: str, *, timeout: float = 5.5, now: datetime | None = None) -> str:
    question = sports_question(prompt)
    current = now or datetime.now(timezone.utc)
    day = _requested_day(question, current)
    if day is None:
        return "RÉSULTATS SPORTIFS : période non couverte par les flux quotidiens ; vérifier la période demandée avec les sources web."
    dates = ((day - timedelta(days=1)).strftime("%Y%m%d"), day.strftime("%Y%m%d"))
    leagues = _selected_leagues(question)
    if not leagues:
        return "RÉSULTATS SPORTIFS : ce sport n'est pas couvert par les flux de scores ; résultats à vérifier avec les sources web."

    async def load(client, sport, league, path):
        key = (path, day.isoformat())
        cached = _cache.get(key)
        if cached and time.monotonic() - cached[0] < 60:
            return cached[1], []

        async def fetch(requested):
            response = await client.get(
                f"{BASE_URL}/{path}/scoreboard", params={"dates": requested, "limit": 100},
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or not isinstance(payload.get("events"), list):
                raise ValueError(f"Scoreboard invalide : {league}")
            return payload

        # Some leagues reject date ranges. Fetch both UTC days to cover the Paris day.
        payloads = await asyncio.gather(*(fetch(requested) for requested in dates), return_exceptions=True)
        events = []
        unavailable = []
        for requested, payload in zip(dates, payloads):
            if isinstance(payload, BaseException):
                logger.warning("[SPORT] %s indisponible (%s) : %r", league, requested, payload)
                unavailable.append(requested)
            else:
                events.extend(payload["events"])
        if len(unavailable) == len(dates):
            raise ValueError(f"Scoreboard indisponible : {league}")
        matches = parse_scoreboard({"events": events}, sport, league, day, current)
        if not unavailable:
            if len(_cache) >= 64:
                _cache.pop(next(iter(_cache)))
            _cache[key] = (time.monotonic(), matches)
        return matches, unavailable

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        outcomes = await asyncio.gather(
            *(asyncio.wait_for(load(client, *league), timeout=timeout) for league in leagues),
            return_exceptions=True,
        )
    lines = [
        f"RÉSULTATS SPORTIFS STRUCTURÉS — {day:%d/%m/%Y}, journée Europe/Paris.",
        f"Consultation : {current.astimezone(PARIS):%d/%m/%Y %H:%M} (Europe/Paris).",
        "Périmètre par défaut : principales compétitions françaises ET internationales, pas uniquement la ville du profil.",
        "Source : flux publics ESPN, couverture partielle et disponibilité non garantie.",
        "Un programme à venir n'est PAS un résultat. Un score absent reste non vérifié. Ne pas déduire qu'il n'y a eu aucun match.",
    ]
    per_sport: dict[str, list[dict]] = {}
    for (sport, league, path), outcome in zip(leagues, outcomes):
        source = f"{BASE_URL}/{path}/scoreboard?dates={dates[1]} (veille UTC : {BASE_URL}/{path}/scoreboard?dates={dates[0]})"
        if isinstance(outcome, BaseException):
            logger.warning("[SPORT] %s indisponible : %r", league, outcome)
            lines.append(f"{league} : source indisponible. {source}")
        else:
            matches, unavailable = outcome
            if unavailable:
                lines.append(f"{league} : couverture incomplète, source indisponible pour {', '.join(unavailable)}.")
            if not matches:
                lines.append(f"{league} : aucune rencontre exploitable pour cette date dans ce flux. {source}")
                continue
            lines.append(f"Source {league} : {source}")
            per_sport.setdefault(sport, []).extend(matches)
    priority = {"terminé": 0, "en cours": 1, "à venir": 2, "reporté/interrompu": 3}
    for sport, matches in per_sport.items():
        matches.sort(key=lambda match: (priority[match["state"]], match["date"]))
        lines.append(f"\n{sport} — sélection de {min(6, len(matches))} rencontres sur {len(matches)} trouvées :")
        for match in matches[:6]:
            score = match["score"] or ("score non vérifié" if match["state"] in ("terminé", "en cours") else "pas de résultat")
            lines.append(f"- {match['competition']} | {match['date']} | {match['participants']} | {score} | {match['state']}")
    return "\n".join(lines)
