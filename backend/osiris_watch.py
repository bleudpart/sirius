# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Veille locale du briefing : flux publics OSIRIS filtrés autour de l'établissement.

OSIRIS (https://www.osirisai.live, licence MIT) agrège des sources publiques. ΣIRIUS lit
trois flux sans clé ni IA : événements naturels (NASA EONET, NOAA/NWS), séismes (USGS)
et repères de marché. Ces flux sont mondiaux : le tri par distance est fait ici et aucune
position n'est envoyée à OSIRIS. La prévision locale vient d'Open-Meteo, comme le bulletin
météo. Une source en panne est signalée ; aucune valeur n'est remplacée.
"""

import asyncio
import json
import logging
import math
import os
import re
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import httpx

import weather_bulletin

logger = logging.getLogger("sirius.veille")

PARIS = ZoneInfo("Europe/Paris")
DEFAULT_BASE_URL = "https://www.osirisai.live"
FEED_TTL = 10 * 60
FAILURE_TTL = 60
MAX_FEED_AGE = timedelta(hours=6)
MAX_MARKET_AGE = timedelta(days=5)
MAX_PAYLOAD_BYTES = 1_000_000
MAX_ROWS = 5000
RADIUS_KM = 300
MIN_MAGNITUDE = 3.0
QUAKE_WINDOW = timedelta(days=7)
MAX_LISTED_EVENTS = 5
HEAT_THRESHOLD_C = 30
TIMEOUT = httpx.Timeout(6.0, connect=3.0)
HEADERS = {"Accept": "application/json", "User-Agent": "SIRIUS-Veille/1.0 (+https://sirius-assistant.fr)"}
TOGGLES = ("meteo_locale", "evenements", "marches")
SEVERITY = {
    "extreme": (0, "gravité extrême"), "severe": (1, "gravité forte"), "high": (1, "gravité élevée"),
    "medium": (2, "gravité moyenne"), "moderate": (2, "gravité moyenne"), "low": (3, "gravité faible"),
}
MARKETS = (
    ("oil", "Brent Crude", "pétrole Brent"),
    ("commodities", "Wheat", "blé (Chicago)"),
    ("fx", "EUR/USD", "euro/dollar"),
)
UNITS = {"USD": "dollars", "USX": "cents US", "EUR": "euros"}
SOURCES = {
    "meteo": ("Météo locale", "Open-Meteo", "https://open-meteo.com/"),
    "evenements": ("Événements naturels", "OSIRIS — NASA EONET, NOAA/NWS", "https://www.osirisai.live/docs"),
    "seismes": ("Séismes", "OSIRIS — USGS", "https://www.osirisai.live/docs"),
    "marches": ("Repères de marché", "OSIRIS — cours publics", "https://www.osirisai.live/docs"),
}
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_cache: dict = {}


class FeedUnavailable(Exception):
    """Flux injoignable, illisible ou trop ancien ; le message est affichable."""


def clear_watch_cache():
    _cache.clear()


def base_url() -> str:
    value = (os.environ.get("OSIRIS_BASE_URL") or DEFAULT_BASE_URL).strip().rstrip("/")
    parsed = urlparse(value)
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.query
            or parsed.fragment or (parsed.scheme == "http" and not local)):
        raise FeedUnavailable("Adresse OSIRIS mal configurée (OSIRIS_BASE_URL).")
    return value


def _number(value, low, high) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Nombre attendu.")
    value = float(value)
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError("Nombre hors limites.")
    return value


def _text(value, limit) -> str:
    if not isinstance(value, str):
        raise ValueError("Texte attendu.")
    value = " ".join(_CONTROL.sub(" ", value).split())
    if not value:
        raise ValueError("Texte vide.")
    return value if len(value) <= limit else value[:limit - 1].rstrip() + "…"


def _instant(value) -> datetime:
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError("Date attendue.")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Fuseau horaire absent.")
    return parsed.astimezone(timezone.utc)


def _epoch(value, scale) -> datetime:
    return datetime.fromtimestamp(_number(value, 0, 4_102_444_800 * scale) / scale, timezone.utc)


def _link(value):
    if not isinstance(value, str) or len(value) > 500:
        return None
    parsed = urlparse(value)
    return value if parsed.scheme == "https" and parsed.hostname else None


def distance_km(lat1, lon1, lat2, lon2) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    half = (math.sin((phi2 - phi1) / 2) ** 2
            + math.cos(phi1) * math.cos(phi2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 6371.0 * 2 * math.asin(math.sqrt(min(1.0, half)))


def valid_location(value):
    try:
        country = value.get("country") or ""
        return {
            "name": _text(value["name"], 120),
            "country": _text(country, 80) if country else "",
            "latitude": _number(value["latitude"], -90, 90),
            "longitude": _number(value["longitude"], -180, 180),
        }
    except (AttributeError, KeyError, TypeError, ValueError):
        return None


async def _download(client, url) -> dict:
    try:
        async with client.stream("GET", url, headers=HEADERS) as response:
            if response.status_code != 200:
                raise FeedUnavailable(f"OSIRIS a répondu HTTP {response.status_code}.")
            declared = response.headers.get("content-length", "")
            if declared.isdigit() and int(declared) > MAX_PAYLOAD_BYTES:
                raise FeedUnavailable("Réponse OSIRIS trop volumineuse.")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_PAYLOAD_BYTES:
                    raise FeedUnavailable("Réponse OSIRIS trop volumineuse.")
    except httpx.HTTPError as error:
        logger.warning("[VEILLE] OSIRIS injoignable (%s) : %s", url, type(error).__name__)
        raise FeedUnavailable("OSIRIS ne répond pas pour le moment.") from error
    try:
        payload = json.loads(bytes(body))
    except ValueError as error:
        raise FeedUnavailable("Réponse OSIRIS illisible.") from error
    if not isinstance(payload, dict) or payload.get("ok") is False or payload.get("error"):
        raise FeedUnavailable("OSIRIS signale une source amont indisponible.")
    return payload


def _feed_time(payload, now):
    try:
        stamp = _instant(payload.get("timestamp"))
    except ValueError:
        return None
    if stamp > now + timedelta(minutes=15):
        return None
    if stamp < now - MAX_FEED_AGE:
        raise FeedUnavailable(f"Flux OSIRIS trop ancien (mis à jour {_moment(stamp, now)}).")
    return stamp


async def _read_feed(client, path, now):
    url = base_url() + path
    entry = _cache.get(url)
    if entry and time.monotonic() - entry[0] < entry[1]:
        if isinstance(entry[2], str):
            raise FeedUnavailable(entry[2])
        return entry[2]
    try:
        payload = await _download(client, url)
        result = (payload, _feed_time(payload, now))
    except FeedUnavailable as error:
        _cache[url] = (time.monotonic(), FAILURE_TTL, str(error))
        raise
    _cache[url] = (time.monotonic(), FEED_TTL, result)
    return result


def parse_events(payload, origin, now):
    rows = payload.get("events")
    if not isinstance(rows, list):
        raise FeedUnavailable("Flux d'événements OSIRIS sans liste exploitable.")
    found, ignored = [], 0
    for row in rows[:MAX_ROWS]:
        try:
            expires = _instant(row["expires"]) if row.get("expires") else None
            if expires is not None and expires <= now:
                continue
            latitude, longitude = _number(row["lat"], -90, 90), _number(row["lng"], -180, 180)
            distance = distance_km(origin["latitude"], origin["longitude"], latitude, longitude)
            if distance > RADIUS_KM:
                continue
            severity = row.get("severity") if row.get("severity") in SEVERITY else None
            found.append({
                "kind": "evenement",
                "title": _text(row["title"], 200),
                "type": _text(row.get("type") or row.get("category") or "Événement", 80),
                "severity": severity,
                "distance_km": round(distance),
                "date": _instant(row["date"]).isoformat(),
                "expires": expires.isoformat() if expires else None,
                "provider": _text(row["provider"], 60),
                "url": _link(row.get("source")),
                "_rank": SEVERITY[severity][0] if severity else 4,
            })
        except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
            ignored += 1
    return found, ignored


def parse_quakes(payload, origin, now):
    rows = payload.get("earthquakes")
    if not isinstance(rows, list):
        raise FeedUnavailable("Flux sismique OSIRIS sans liste exploitable.")
    found, ignored = [], 0
    for row in rows[:MAX_ROWS]:
        try:
            magnitude = _number(row["magnitude"], -2, 10)
            if magnitude < MIN_MAGNITUDE:
                continue
            latitude, longitude = _number(row["lat"], -90, 90), _number(row["lng"], -180, 180)
            distance = distance_km(origin["latitude"], origin["longitude"], latitude, longitude)
            if distance > RADIUS_KM:
                continue
            when = _epoch(row["time"], 1000)
            if not now - QUAKE_WINDOW <= when <= now + timedelta(minutes=15):
                continue
            found.append({
                "kind": "seisme",
                "title": f"Séisme de magnitude {_fr(magnitude, 1)}",
                "place": _text(row["place"], 160),
                "magnitude": magnitude,
                "distance_km": round(distance),
                "date": when.isoformat(),
                "provider": "USGS",
                "url": _link(row.get("url")),
                "_rank": 1 if magnitude >= 5 else 2 if magnitude >= 4 else 3,
            })
        except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
            ignored += 1
    return found, ignored


def parse_markets(payload, now):
    found, missing = [], []
    for group, name, label in MARKETS:
        try:
            row = payload[group][name]
            at = _epoch(row["time"], 1)
            if not now - MAX_MARKET_AGE <= at <= now + timedelta(minutes=15):
                raise ValueError("Cours trop ancien.")
            found.append({
                "label": label,
                "symbol": _text(row.get("symbol") or name, 20),
                "price": _number(row["price"], 0, 1e7),
                "currency": _text(row["currency"], 8),
                "change_percent": _number(row["change_percent"], -100, 1000),
                "at": at.isoformat(),
            })
        except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
            missing.append(label)
    if not found:
        raise FeedUnavailable("Aucun repère de marché exploitable dans le flux OSIRIS.")
    return found, missing


async def _local_weather(location):
    bulletin = await weather_bulletin.fetch_weather_at(
        location["name"], location["country"], location["latitude"], location["longitude"],
    )
    today = bulletin["days"][0]
    observed = datetime.fromisoformat(bulletin["current"]["time"]).replace(tzinfo=ZoneInfo(bulletin["timezone"]))
    return {
        "date": today["date"],
        "min_c": today["temperature_2m_min"],
        "max_c": today["temperature_2m_max"],
        "rain_percent": today["precipitation_probability_max"],
        "wind_max_kmh": today["wind_speed_10m_max"],
        "heat": today["temperature_2m_max"] >= HEAT_THRESHOLD_C,
        "updated_at": observed.astimezone(timezone.utc).isoformat(),
    }


async def _feed_items(client, path, parser, origin, now):
    payload, stamp = await _read_feed(client, path, now)
    items, ignored = parser(payload, origin, now)
    return {"items": items, "ignored": ignored, "updated_at": stamp.isoformat() if stamp else None}


async def _feed_markets(client, now):
    payload, stamp = await _read_feed(client, "/api/markets", now)
    items, missing = parse_markets(payload, now)
    return {"items": items, "missing": missing, "updated_at": stamp.isoformat() if stamp else None}


def _failure(source_id, error) -> str:
    if isinstance(error, FeedUnavailable):
        return str(error)
    if isinstance(error, weather_bulletin.WeatherRateLimitedError):
        return "Limite de requêtes Open-Meteo atteinte."
    if isinstance(error, httpx.HTTPError):
        return "Open-Meteo ne répond pas pour le moment."
    if source_id == "meteo" and isinstance(error, (KeyError, LookupError, TypeError, ValueError)):
        return "Prévision Open-Meteo invalide ou périmée."
    logger.error("[VEILLE] Source %s illisible", source_id, exc_info=error)
    return "Source illisible."


async def build_watch(settings, *, now=None, transport=None) -> dict:
    """Rapport de veille en lecture seule pour les réglages d'un utilisateur."""
    now = now or datetime.now(timezone.utc)
    base = {"read_only": True, "generated_at": now.isoformat(), "radius_km": RADIUS_KM}
    if not settings:
        return {**base, "enabled": False, "status": "not_configured"}
    if settings.get("enabled") is not True:
        return {**base, "enabled": False, "status": "disabled"}
    location = valid_location(settings.get("location"))
    if location is None:
        return {**base, "enabled": True, "status": "not_configured"}
    wanted = {key: settings.get(key, True) is not False for key in TOGGLES}
    jobs = {}
    async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport, follow_redirects=False) as client:
        if wanted["meteo_locale"]:
            jobs["meteo"] = _local_weather(location)
        if wanted["evenements"]:
            jobs["evenements"] = _feed_items(client, "/api/weather", parse_events, location, now)
            jobs["seismes"] = _feed_items(client, "/api/earthquakes", parse_quakes, location, now)
        if wanted["marches"]:
            jobs["marches"] = _feed_markets(client, now)
        results = dict(zip(jobs, await asyncio.gather(*jobs.values(), return_exceptions=True)))
    sources, events = [], []
    report = {
        **base, "enabled": True, "location": {"name": location["name"], "country": location["country"]},
        "min_magnitude": MIN_MAGNITUDE, "meteo": None, "events": [], "other_events": 0,
        "markets": [], "missing_markets": [], "sources": sources,
    }
    for source_id, result in results.items():
        label, provider, url = SOURCES[source_id]
        entry = {"id": source_id, "label": label, "provider": provider, "url": url,
                 "ok": not isinstance(result, BaseException), "updated_at": None, "detail": None}
        sources.append(entry)
        if isinstance(result, BaseException):
            entry["detail"] = _failure(source_id, result)
            continue
        entry["updated_at"] = result["updated_at"]
        if source_id == "meteo":
            report["meteo"] = result
        elif source_id == "marches":
            report["markets"], report["missing_markets"] = result["items"], result["missing"]
        else:
            events.extend(result["items"])
            if result["ignored"]:
                entry["detail"] = f"{result['ignored']} entrée(s) incomplète(s) ignorée(s)."
    events.sort(key=lambda item: (item["_rank"], item["distance_km"]))
    report["events"] = [{k: v for k, v in item.items() if k != "_rank"} for item in events[:MAX_LISTED_EVENTS]]
    report["other_events"] = max(0, len(events) - MAX_LISTED_EVENTS)
    failed = sum(not item["ok"] for item in sources)
    report["status"] = "ok" if not failed else "unavailable" if failed == len(sources) else "partial"
    return report


def _fr(value, digits) -> str:
    return f"{value:,.{digits}f}".replace(",", " ").replace(".", ",")


def _moment(instant, now) -> str:
    local = instant.astimezone(PARIS)
    hour = f"{local:%H} h {local:%M}"
    return f"aujourd'hui à {hour}" if local.date() == now.astimezone(PARIS).date() else f"le {local:%d/%m} à {hour}"


def _trend(change) -> str:
    if abs(change) < 0.05:
        return "stable"
    return f"en {'hausse' if change > 0 else 'baisse'} de {_fr(abs(change), 1)} %"


def _event_line(item, now) -> str:
    when = _moment(datetime.fromisoformat(item["date"]), now)
    if item["kind"] == "seisme":
        return f"  - {item['title']} — {item['place']}, à {item['distance_km']} km, {when} (USGS)."
    severity = SEVERITY[item["severity"]][1] if item["severity"] else "gravité non précisée"
    until = ""
    if item.get("expires"):
        until = f", jusqu'au {datetime.fromisoformat(item['expires']).astimezone(PARIS):%d/%m à %H h %M}"
    return (f"  - « {item['title']} » — {item['provider']}, {severity}, à {item['distance_km']} km, "
            f"signalé {when}{until}.")


def _market_text(item, now) -> str:
    at = datetime.fromisoformat(item["at"])
    when = "" if at.astimezone(PARIS).date() == now.astimezone(PARIS).date() else f", cours du {at.astimezone(PARIS):%d/%m}"
    if item["label"] == "euro/dollar":
        return f"{item['label']} {_fr(item['price'], 4)}, {_trend(item['change_percent'])}{when}"
    unit = UNITS.get(item["currency"], item["currency"])
    return f"{item['label']} {_fr(item['price'], 2)} {unit}, {_trend(item['change_percent'])}{when}"


def watch_lines(report) -> list[str]:
    """Section « Veille » du briefing, prête à être lue à voix haute."""
    status = report.get("status")
    if status == "disabled":
        return []
    if status == "not_configured":
        return ["", "Veille locale non configurée : indiquez la ville de l'établissement dans Réveil matinal, section Veille."]
    now = datetime.fromisoformat(report["generated_at"])
    location = report["location"]
    country = f" ({location['country']})" if location["country"] else ""
    lines = ["", f"Veille autour de {location['name']}{country} — informations publiques, aucune action déclenchée :"]
    sources = {item["id"]: item for item in report["sources"]}
    meteo = report.get("meteo")
    if meteo:
        lines.append(
            f"- Météo locale aujourd'hui (prévision Open-Meteo) : {_fr(meteo['min_c'], 0)} à {_fr(meteo['max_c'], 0)} °C, "
            f"pluie jusqu'à {_fr(meteo['rain_percent'], 0)} %, vent jusqu'à {_fr(meteo['wind_max_kmh'], 0)} km/h."
        )
        if meteo["heat"]:
            lines.append(f"- Chaleur prévue (au moins {HEAT_THRESHOLD_C} °C) : relevés de température des enceintes froides à surveiller.")
    read = [sources[key] for key in ("evenements", "seismes") if key in sources and sources[key]["ok"]]
    if read:
        providers = ", ".join(item["provider"].removeprefix("OSIRIS — ") for item in read)
        stamps = [datetime.fromisoformat(item["updated_at"]) for item in read if item["updated_at"]]
        checked = f", flux mis à jour {_moment(min(stamps), now)}" if stamps else ""
        total = len(report["events"]) + report["other_events"]
        if total:
            lines.append(f"- Événements naturels à moins de {report['radius_km']} km (OSIRIS : {providers}{checked}) : {total} signalé(s).")
            lines.extend(_event_line(item, now) for item in report["events"])
            if report["other_events"]:
                lines.append(f"  - {report['other_events']} autre(s) événement(s) moins prioritaire(s).")
        else:
            lines.append(f"- Événements naturels à moins de {report['radius_km']} km (OSIRIS : {providers}{checked}) : aucun signalé.")
    if report["markets"]:
        lines.append(
            "- Repères de marché (OSIRIS, cours internationaux, pas vos tarifs fournisseurs) : "
            + " ; ".join(_market_text(item, now) for item in report["markets"]) + "."
        )
        if report["missing_markets"]:
            lines.append(f"  - Non disponible : {', '.join(report['missing_markets'])}.")
    for item in report["sources"]:
        if not item["ok"]:
            lines.append(f"- Source indisponible : {item['label']} ({item['provider']}) — {item['detail']} Aucune valeur remplacée.")
    if "evenements" in sources:
        lines.append("Vigilance officielle Météo-France non incluse.")
    return lines
