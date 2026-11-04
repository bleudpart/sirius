# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Veille locale du briefing : flux publics OSIRIS filtrés autour de l'établissement.

OSIRIS (https://www.osirisai.live, licence MIT) agrège des sources publiques. ΣIRIUS lit
trois flux sans clé ni IA : événements naturels (NASA EONET, NOAA/NWS), séismes (USGS)
et repères de marché. Ces flux sont mondiaux : le tri par distance est fait ici et aucune
position n'est envoyée à OSIRIS. La prévision locale vient d'Open-Meteo, comme le bulletin
météo. Une source en panne est signalée ; aucune valeur n'est remplacée.
"""

import asyncio
import ipaddress
import json
import logging
import math
import os
import re
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlparse
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
MAP_RADII_KM = (50, 100, 300, 1000)
MAP_MAX_EVENTS = 2000
MAP_LAYER_LIMIT = 500
MAP_LAYER_MAX_ROWS = 60_000
MAP_LAYER_MAX_BYTES = 12 * 1024 * 1024
MAP_LAYERS = {
    "avion": {
        "path": "/api/flights", "label": "Avions", "provider": "OSIRIS — OpenSky / ADS-B",
        "ttl": 60, "max_age": timedelta(minutes=10), "max_bytes": MAP_LAYER_MAX_BYTES,
    },
    "satellite": {
        "path": "/api/satellites", "label": "Satellites", "provider": "OSIRIS — données orbitales",
        "ttl": 120, "max_age": timedelta(hours=2), "max_bytes": MAP_LAYER_MAX_BYTES,
    },
    "conflit": {
        "path": "/api/conflicts", "label": "Zones de conflit", "provider": "OSIRIS — sélection éditoriale",
        "ttl": 300, "max_age": timedelta(hours=6), "max_bytes": MAX_PAYLOAD_BYTES,
    },
    "actualite": {
        "path": "/api/news", "label": "Actualités internationales", "provider": "OSIRIS — sources de presse et OSINT",
        "ttl": 120, "max_age": timedelta(hours=2), "max_bytes": MAX_PAYLOAD_BYTES,
    },
    "maritime": {
        "path": "/api/maritime", "label": "Ports & passages maritimes", "provider": "OSIRIS — données maritimes",
        "ttl": 300, "max_age": timedelta(hours=24), "max_bytes": MAX_PAYLOAD_BYTES,
    },
    "camera": {
        "path": "/api/cctv", "label": "Caméras publiques", "provider": "OSIRIS — caméras publiques",
        "ttl": 300, "max_age": timedelta(hours=1), "max_bytes": 20 * 1024 * 1024,
    },
}
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
_wind_grids: OrderedDict = OrderedDict()


class FeedUnavailable(Exception):
    """Flux injoignable, illisible ou trop ancien ; le message est affichable."""


def clear_watch_cache():
    _cache.clear()
    _wind_grids.clear()


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


def _camera_link(value):
    try:
        value = _link(value)
        if not value or _CONTROL.search(value):
            return None
        parsed = urlparse(value)
        hostname = parsed.hostname.lower()
        parsed.port
        if parsed.username is not None or parsed.password is not None or hostname.endswith((".local", ".localhost")):
            return None
        try:
            if not ipaddress.ip_address(hostname).is_global:
                return None
        except ValueError:
            if ("." not in hostname or re.fullmatch(r"[0-9a-fx.]+", hostname)
                    or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label)
                               for label in hostname.encode("idna").decode("ascii").split("."))):
                return None
    except (UnicodeError, ValueError):
        return None
    return value


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


async def _download(client, url, *, max_bytes=None) -> dict:
    if max_bytes is None:
        max_bytes = MAX_PAYLOAD_BYTES
    try:
        async with client.stream("GET", url, headers=HEADERS) as response:
            if response.status_code != 200:
                raise FeedUnavailable(f"OSIRIS a répondu HTTP {response.status_code}.")
            declared = response.headers.get("content-length", "")
            if declared.isdigit() and int(declared) > max_bytes:
                raise FeedUnavailable("Réponse OSIRIS trop volumineuse.")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > max_bytes:
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


async def _read_feed(client, path, now, *, ttl=None, max_bytes=None):
    url = base_url() + path
    entry = _cache.get(url)
    if entry and time.monotonic() - entry[0] < entry[1]:
        if isinstance(entry[2], str):
            raise FeedUnavailable(entry[2])
        return entry[2]
    try:
        payload = await _download(client, url, max_bytes=max_bytes)
        result = (payload, _feed_time(payload, now))
    except FeedUnavailable as error:
        _cache[url] = (time.monotonic(), FAILURE_TTL, str(error))
        raise
    _cache[url] = (time.monotonic(), FEED_TTL if ttl is None else ttl, result)
    return result


def _distance_from(origin, latitude, longitude):
    if origin is None:
        return None
    return distance_km(origin["latitude"], origin["longitude"], latitude, longitude)


def _outside(distance, radius_km) -> bool:
    return radius_km is not None and (distance is None or distance > radius_km)


def parse_events(payload, origin, now, radius_km=RADIUS_KM):
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
            distance = _distance_from(origin, latitude, longitude)
            if _outside(distance, radius_km):
                continue
            severity = row.get("severity") if row.get("severity") in SEVERITY else None
            found.append({
                "kind": "evenement",
                "title": _text(row["title"], 200),
                "type": _text(row.get("type") or row.get("category") or "Événement", 80),
                "severity": severity,
                "distance_km": round(distance) if distance is not None else None,
                "latitude": latitude,
                "longitude": longitude,
                "date": _instant(row["date"]).isoformat(),
                "expires": expires.isoformat() if expires else None,
                "provider": _text(row["provider"], 60),
                "url": _link(row.get("source")),
                "_rank": SEVERITY[severity][0] if severity else 4,
            })
        except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
            ignored += 1
    return found, ignored


def parse_quakes(payload, origin, now, radius_km=RADIUS_KM):
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
            distance = _distance_from(origin, latitude, longitude)
            if _outside(distance, radius_km):
                continue
            when = _epoch(row["time"], 1000)
            if not now - QUAKE_WINDOW <= when <= now + timedelta(minutes=15):
                continue
            found.append({
                "kind": "seisme",
                "title": f"Séisme de magnitude {_fr(magnitude, 1)}",
                "place": _text(row["place"], 160),
                "magnitude": magnitude,
                "distance_km": round(distance) if distance is not None else None,
                "latitude": latitude,
                "longitude": longitude,
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
    report["events"] = [_public_event(item, with_position=False) for item in events[:MAX_LISTED_EVENTS]]
    report["other_events"] = max(0, len(events) - MAX_LISTED_EVENTS)
    failed = sum(not item["ok"] for item in sources)
    report["status"] = "ok" if not failed else "unavailable" if failed == len(sources) else "partial"
    return report


def _public_event(item, *, with_position=True) -> dict:
    hidden = {"_rank"} if with_position else {"_rank", "latitude", "longitude"}
    return {key: value for key, value in item.items() if key not in hidden}


async def build_map(settings, *, now=None, transport=None) -> dict:
    """Points OSIRIS pour la carte : flux mondiaux, filtrés côté client par rayon ou zone visible.

    Le centre est la ville de la veille, même si la veille n'est pas ajoutée au briefing.
    Comme pour le briefing, aucune position n'est envoyée à OSIRIS.
    """
    now = now or datetime.now(timezone.utc)
    origin = valid_location((settings or {}).get("location"))
    parsers = {
        "evenements": ("/api/weather", lambda payload, at, when: parse_events(payload, at, when, radius_km=None)),
        "seismes": ("/api/earthquakes", lambda payload, at, when: parse_quakes(payload, at, when, radius_km=None)),
    }
    async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport, follow_redirects=False) as client:
        results = await asyncio.gather(
            *(_feed_items(client, path, parser, origin, now) for path, parser in parsers.values()),
            return_exceptions=True,
        )
    sources, events = [], []
    for source_id, result in zip(parsers, results):
        label, provider, url = SOURCES[source_id]
        entry = {"id": source_id, "label": label, "provider": provider, "url": url,
                 "ok": not isinstance(result, BaseException), "updated_at": None, "detail": None}
        sources.append(entry)
        if isinstance(result, BaseException):
            entry["detail"] = _failure(source_id, result)
            continue
        entry["updated_at"] = result["updated_at"]
        events.extend(result["items"])
        if result["ignored"]:
            entry["detail"] = f"{result['ignored']} entrée(s) incomplète(s) ignorée(s)."
    events.sort(key=lambda item: (
        item["distance_km"] if item["distance_km"] is not None else math.inf,
        item["_rank"], item["date"],
    ))
    failed = sum(not item["ok"] for item in sources)
    return {
        "read_only": True, "generated_at": now.isoformat(),
        "origin": origin, "default_radius_km": RADIUS_KM, "radii_km": list(MAP_RADII_KM),
        "min_magnitude": MIN_MAGNITUDE,
        "events": [_public_event(item) for item in events[:MAP_MAX_EVENTS]],
        "truncated": max(0, len(events) - MAP_MAX_EVENTS),
        "sources": sources,
        "status": "ok" if not failed else "unavailable" if failed == len(sources) else "partial",
    }


def _layer_rows(kind, payload):
    groups_by_kind = {
        "avion": ((None, "commercial_flights"), (None, "private_flights"), (None, "private_jets"), (None, "military_flights")),
        "satellite": ((None, "satellites"),),
        "conflit": ((None, "zones"),),
        "actualite": ((None, "news"),),
        "maritime": (("port", "ports"), ("chokepoint", "chokepoints"), ("ship", "ships")),
        "camera": ((None, "cameras"),),
    }[kind]
    groups = [
        (category, payload.get(key, []) if kind == "maritime" else payload.get(key))
        for category, key in groups_by_kind
    ]
    if any(not isinstance(group, list) for _, group in groups):
        raise FeedUnavailable("Flux OSIRIS sans liste exploitable.")
    count = sum(len(group) for _, group in groups)
    if not count:
        raise FeedUnavailable("OSIRIS ne fournit actuellement aucune donnée pour ce calque.")
    if count > MAP_LAYER_MAX_ROWS:
        raise FeedUnavailable("Flux OSIRIS trop volumineux pour la carte.")
    return ((category, row) for category, group in groups for row in group)


def _optional_number(value, low, high):
    try:
        return _number(value, low, high)
    except ValueError:
        return None


def _layer_point(kind, row, stamp, now, category=None):
    if not isinstance(row, dict):
        raise ValueError("Entrée invalide.")
    provider = MAP_LAYERS[kind]["provider"]
    date = stamp
    details = {}
    if kind == "avion":
        identifier = _text(row.get("icao24") or row.get("callsign"), 40)
        callsign = row.get("callsign")
        name = _text(callsign if callsign and callsign != "UNKNOWN" else identifier, 40)
        title = f"Avion {name}"
        latitude, longitude = row["lat"], row["lng"]
        details = {
            "altitude_m": _optional_number(row.get("alt"), 1, 100_000),
            "speed_knots": _optional_number(row.get("speed_knots"), 0, 2_000),
        }
        url = None
    elif kind == "satellite":
        name = _text(row["name"], 120)
        identifier = _text(str(row.get("noradId") or name), 120)
        title = f"Satellite {name}"
        latitude, longitude = row["lat"], row["lng"]
        details = {"altitude_km": _optional_number(row.get("alt"), 0, 100_000)}
        url = None
    elif kind == "conflit":
        identifier = _text(row["id"], 120)
        title = f"Zone de conflit : {_text(row['label'], 120)}"
        latitude, longitude = row["lat"], row["lng"]
        url = _link(row.get("sourceUrl"))
    elif kind == "actualite":
        if row.get("coords_default") is not False:
            raise ValueError("Actualité non localisée.")
        coordinates = row["coords"]
        if not isinstance(coordinates, list) or len(coordinates) != 2:
            raise ValueError("Localisation absente.")
        latitude, longitude = coordinates
        date = _instant(row["published"])
        if not now - timedelta(days=7) <= date <= now + timedelta(minutes=15):
            raise ValueError("Publication périmée ou future.")
        identifier = _text(row["id"], 120)
        title = _text(row["title"], 180)
        provider = _text(row.get("source_name") or row.get("source"), 100)
        url = _link(row.get("link"))
        if url is None:
            raise ValueError("Lien source absent.")
        precision = row.get("location_precision")
        details = {"location_precision": precision if precision in ("settlement", "region", "country-anchor") else "unknown"}
    elif kind == "camera":
        identifier = _text(row["id"], 120)
        title = f"Caméra : {_text(row['name'], 140)}"
        latitude, longitude = row["lat"], row["lng"]
        source = row.get("source")
        if isinstance(source, str) and source:
            provider = f"OSIRIS — {_text(source, 80)}"
        image = _camera_link(row.get("feed_url"))
        url = _camera_link(row.get("stream_url")) or image
        details = {"preview_url": image if image and urlparse(image).path.lower().endswith((".jpg", ".jpeg", ".png")) else None}
        for field in ("city", "country"):
            if isinstance(row.get(field), str) and row[field]:
                details[field] = _text(row[field], 100)
    else:
        if category == "port":
            identifier = _text(row["name"], 120)
            port_type = row.get("type")
            title = f"Base navale : {identifier}" if port_type == "naval" else identifier
            latitude, longitude = row["lat"], row["lng"]
            details = {
                "subtype": "port",
                "port_type": _text(port_type, 40) if isinstance(port_type, str) and port_type else "unknown",
            }
            if isinstance(row.get("country"), str) and row["country"]:
                details["country"] = _text(row["country"], 8)
            if isinstance(row.get("volume"), str) and row["volume"] and not row["volume"].lower().startswith("undefined"):
                details["volume"] = _text(row["volume"], 100)
            if isinstance(row.get("fleet"), str) and row["fleet"]:
                details["fleet"] = _text(row["fleet"], 100)
            if isinstance(row.get("congestion"), str) and row["congestion"]:
                details["congestion"] = _text(row["congestion"], 30)
        elif category == "chokepoint":
            identifier = _text(row["name"], 120)
            title = f"Passage stratégique : {identifier}"
            latitude, longitude = row["lat"], row["lng"]
            details = {"subtype": "chokepoint"}
            if isinstance(row.get("traffic"), str) and row["traffic"]:
                details["traffic"] = _text(row["traffic"], 100)
            if isinstance(row.get("risk"), str) and row["risk"]:
                details["risk"] = _text(row["risk"], 30).upper()
        elif category == "ship":
            raw_id = row.get("mmsi") or row.get("imo") or row.get("id") or row.get("name")
            identifier = _text(str(raw_id) if raw_id is not None else "", 120)
            name = _text(row.get("name") or row.get("vessel_name") or identifier, 120)
            title = f"Navire {name}"
            latitude = row.get("lat", row.get("latitude"))
            longitude = row.get("lng", row.get("lon", row.get("longitude")))
            details = {
                "subtype": "ship",
                "speed_knots": _optional_number(row.get("speed_knots"), 0, 200),
            }
        else:
            raise ValueError("Type d’entrée maritime invalide.")
        identifier = f"{category}:{identifier}"
        url = None

    return {
        "kind": kind, "id": identifier, "title": title,
        "latitude": _number(latitude, -90, 90), "longitude": _number(longitude, -180, 180),
        "date": date.isoformat(), "provider": provider, "url": url, **details,
    }


def _inside_map_bounds(bounds, latitude, longitude):
    if not bounds["south"] <= latitude <= bounds["north"]:
        return False
    width = bounds["east"] - bounds["west"]
    return width >= 360 or (longitude - bounds["west"]) % 360 <= width


async def build_map_layer(settings, kind, bounds, radius_km=None, *, now=None, transport=None) -> dict:
    """Calque borné à la zone visible ; aucune coordonnée n'est transmise à OSIRIS."""
    now = now or datetime.now(timezone.utc)
    spec = MAP_LAYERS[kind]
    origin = valid_location((settings or {}).get("location"))
    source = {
        "id": kind, "label": spec["label"], "provider": spec["provider"],
        "ok": False, "updated_at": None, "detail": None,
    }
    report = {
        "kind": kind, "read_only": True, "generated_at": now.isoformat(),
        "items": [], "total": 0, "truncated": 0, "ignored": 0, "source": source,
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport, follow_redirects=False) as client:
            payload, stamp = await _read_feed(
                client, spec["path"], now, ttl=spec["ttl"], max_bytes=spec["max_bytes"],
            )
        if stamp is None:
            raise FeedUnavailable("Flux OSIRIS sans date exploitable.")
        source["updated_at"] = stamp.isoformat()
        if now - stamp > spec["max_age"]:
            raise FeedUnavailable("Flux OSIRIS trop ancien pour ce calque.")
        if payload.get("simulated") is True or "simulat" in str(payload.get("source", "")).lower():
            raise FeedUnavailable("OSIRIS signale des données simulées, non affichées.")
        if kind == "satellite" and payload.get("source") == "emergency-fallback":
            raise FeedUnavailable("OSIRIS ne dispose que de données orbitales de secours non vérifiables.")

        points, seen, usable = [], set(), 0
        counts = {"port": 0, "chokepoint": 0, "ship": 0}
        for category, row in _layer_rows(kind, payload):
            try:
                item = _layer_point(kind, row, stamp, now, category)
            except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
                report["ignored"] += 1
                continue
            if item["id"] in seen:
                continue
            seen.add(item["id"])
            usable += 1
            latitude, longitude = item["latitude"], item["longitude"]
            if not _inside_map_bounds(bounds, latitude, longitude):
                continue
            distance = _distance_from(origin, latitude, longitude)
            if _outside(distance, radius_km):
                continue
            item["distance_km"] = round(distance) if distance is not None else None
            points.append(item)
            if kind == "maritime":
                counts[item["subtype"]] += 1
        if not usable:
            raise FeedUnavailable("Aucune donnée géolocalisée exploitable dans ce flux OSIRIS.")

        if origin:
            points.sort(key=lambda item: (item["distance_km"], item["title"], item["id"]))
        else:
            points.sort(key=lambda item: (item["latitude"], item["longitude"], item["id"]))
        report["total"] = len(points)
        report["truncated"] = max(0, len(points) - MAP_LAYER_LIMIT)
        if kind == "maritime":
            report["counts"] = counts
        if report["truncated"] and not origin:
            report["items"] = [points[index * len(points) // MAP_LAYER_LIMIT] for index in range(MAP_LAYER_LIMIT)]
        else:
            report["items"] = points[:MAP_LAYER_LIMIT]
        source["ok"] = True
    except FeedUnavailable as error:
        source["detail"] = str(error)
    return report


async def _wind_grid(client, run, forecast):
    url = f"{base_url()}/api/wind?{urlencode({'run': run, 't': forecast})}"
    entry = _wind_grids.get(url)
    if entry and time.monotonic() - entry[0] < entry[1]:
        _wind_grids.move_to_end(url)
        if isinstance(entry[2], str):
            raise FeedUnavailable(entry[2])
        return entry[2]
    try:
        value = await _download(client, url, max_bytes=4 * 1024 * 1024)
        _wind_components(value, _instant(forecast), _instant(run))
        ttl = 6 * 60 * 60
    except FeedUnavailable as error:
        value, ttl = str(error), FAILURE_TTL
    _wind_grids[url] = (time.monotonic(), ttl, value)
    _wind_grids.move_to_end(url)
    while len(_wind_grids) > 3:
        _wind_grids.popitem(last=False)
    if isinstance(value, str):
        raise FeedUnavailable(value)
    return value


def _wind_metadata(payload, now):
    try:
        run = _instant(payload["run"])
        if not now - timedelta(hours=36) <= run <= now + timedelta(minutes=15):
            raise FeedUnavailable("Cycle du modèle de vent trop ancien ou futur.")
        values = payload["times"]
        if not isinstance(values, list) or not 1 <= len(values) <= 200:
            raise ValueError("Échéances invalides.")
        times = [(_instant(value), value) for value in values]
        if len({at for at, _ in times}) != len(times):
            raise ValueError("Échéances dupliquées.")
        times = sorted((at, raw) for at, raw in times
                       if now - timedelta(days=7) <= at <= now + timedelta(days=10))
        if not times:
            raise ValueError("Aucune échéance récente.")
        return run, times
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        raise FeedUnavailable("Horaires du modèle de vent illisibles.") from error


def _wind_intervals(bounds, origin, radius_km):
    south, north = bounds["south"], bounds["north"]
    west, east = bounds["west"], bounds["east"]
    if origin is None or radius_km is None:
        return south, north, [(west, east)]
    angular = radius_km / 6371.0
    lat_span = math.degrees(angular)
    south = max(south, origin["latitude"] - lat_span)
    north = min(north, origin["latitude"] + lat_span)
    if south >= north:
        return south, north, []
    if abs(origin["latitude"]) + lat_span >= 90:
        lon_span = 180.0
    else:
        lon_span = math.degrees(math.asin(min(1.0, math.sin(angular) / math.cos(math.radians(origin["latitude"])))))
    intervals = []
    for offset in range(-3, 4):
        center = origin["longitude"] + offset * 360
        left, right = max(west, center - lon_span), min(east, center + lon_span)
        if left < right:
            intervals.append((left, right))
    return south, north, intervals


def _wind_axis(start, end, limit):
    count = min(limit, max(1, math.ceil(end - start)))
    return [start + (index + 0.5) * (end - start) / count for index in range(count)]


def _wind_components(grid, forecast, latest_run):
    try:
        reference = _instant(grid["refTime"])
        if reference > forecast or reference > latest_run or forecast - reference > timedelta(days=10):
            raise ValueError("Cycle incohérent.")
        for key, expected in (("ni", 360), ("nj", 181), ("la1", 90), ("lo1", 0), ("dx", 1), ("dy", 1)):
            if _number(grid[key], -360, 360) != expected:
                raise ValueError("Grille inconnue.")
        u, v = grid["u"], grid["v"]
        if not isinstance(u, list) or not isinstance(v, list) or len(u) != 360 * 181 or len(v) != len(u):
            raise ValueError("Composantes manquantes.")
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        raise FeedUnavailable("Grille du modèle de vent illisible ou incohérente.") from error
    return u, v, reference


def _wind_points(grid, bounds, origin, radius_km, forecast, latest_run):
    u, v, reference = _wind_components(grid, forecast, latest_run)
    south, north, intervals = _wind_intervals(bounds, origin, radius_km)
    points, ignored, candidates = [], 0, 0
    for latitude in _wind_axis(south, north, 12) if intervals else []:
        for west, east in intervals:
            for longitude in _wind_axis(west, east, 16):
                distance = _distance_from(origin, latitude, longitude)
                if _outside(distance, radius_km):
                    continue
                candidates += 1
                index = max(0, min(180, round(90 - latitude))) * 360 + round(longitude) % 360
                try:
                    east_ms = _number(u[index], -2000, 2000) / 10
                    north_ms = _number(v[index], -2000, 2000) / 10
                except ValueError:
                    ignored += 1
                    continue
                points.append({
                    "latitude": round(latitude, 4), "longitude": round(longitude, 4),
                    "east_ms": east_ms, "north_ms": north_ms,
                    "speed_kmh": round(math.hypot(east_ms, north_ms) * 3.6, 1),
                })
    if candidates and not points:
        raise FeedUnavailable("Aucun vecteur de vent exploitable dans cette zone.")
    return points, ignored, reference


async def build_map_wind(settings, bounds, radius_km=None, forecast_time=None, *, now=None, transport=None):
    now = now or datetime.now(timezone.utc)
    origin = valid_location((settings or {}).get("location"))
    source = {"label": "Vent à 10 m", "provider": "NOAA GFS via OSIRIS", "ok": False, "detail": None}
    report = {
        "kind": "vent", "read_only": True, "generated_at": now.isoformat(), "source": source,
        "run": None, "latest_run": None, "times": [], "time": None, "points": [], "ignored": 0,
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport, follow_redirects=False) as client:
            payload, _ = await _read_feed(client, "/api/wind", now, ttl=300, max_bytes=MAX_PAYLOAD_BYTES)
            run, times = _wind_metadata(payload, now)
            report["latest_run"] = run.isoformat()
            report["times"] = [at.isoformat() for at, _ in times]
            selected = forecast_time if forecast_time is not None else min(times, key=lambda pair: abs(pair[0] - now))[0]
            raw = next((raw for at, raw in times if at == selected), None)
            if raw is None:
                raise FeedUnavailable("Cette échéance de vent n'est plus disponible : choisis un autre horaire.")
            report["time"] = selected.isoformat()
            grid = await _wind_grid(client, payload["run"], raw)
        report["points"], report["ignored"], reference = _wind_points(grid, bounds, origin, radius_km, selected, run)
        report["run"] = reference.isoformat()
        source["ok"] = True
    except FeedUnavailable as error:
        source["detail"] = str(error)
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
