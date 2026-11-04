# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Horaires publiés de l'estimation de précipitations NASA GIBS."""

import logging
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import httpx

logger = logging.getLogger("sirius.veille")

GIBS_WMS_URL = "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi"
LAYER = "IMERG_Precipitation_Rate_30min"
MAX_BYTES = 6 * 1024 * 1024
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_cache = None


class RainUnavailable(Exception):
    """Source de précipitations indisponible ou illisible."""


def clear_rain_cache():
    global _cache
    _cache = None


def _instant(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError("Date invalide.")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset() is None:
        raise ValueError("Fuseau manquant.")
    return parsed.astimezone(timezone.utc)


def _iso(instant):
    return instant.isoformat().replace("+00:00", "Z")


def _parse_capabilities(content, now):
    if re.search(br"<!\s*(DOCTYPE|ENTITY)", content, re.IGNORECASE):
        raise RainUnavailable("Description NASA GIBS non conforme.")
    ns = "{http://www.opengis.net/wms}"
    try:
        root = ET.fromstring(content)
        layer = next(
            item for item in root.iter(f"{ns}Layer")
            if item.findtext(f"{ns}Name") == LAYER
        )
        dimension = next(
            item for item in layer.findall(f"{ns}Dimension")
            if item.get("name") == "time"
        )
        latest = _instant(dimension.get("default"))
        if latest > now + timedelta(minutes=15):
            raise ValueError("Date future.")
        intervals = []
        for raw in (dimension.text or "").split(","):
            start, end, period = raw.strip().split("/")
            if period != "PT30M":
                continue
            start, end = _instant(start), _instant(end)
            if start > end:
                raise ValueError("Intervalle invalide.")
            intervals.append((start, end))
        instants = [
            latest - timedelta(minutes=30 * index) for index in range(48)
            if any(start <= latest - timedelta(minutes=30 * index) <= end
                   and (latest - timedelta(minutes=30 * index) - start) % timedelta(minutes=30) == timedelta(0)
                   for start, end in intervals)
        ]
        if not instants or instants[0] != latest:
            raise ValueError("Dernière image indisponible.")
        return {"latest": _iso(latest), "times": [_iso(at) for at in reversed(instants)]}
    except (ET.ParseError, StopIteration, TypeError, ValueError, OverflowError) as error:
        raise RainUnavailable("Horaires NASA GIBS illisibles ou incohérents.") from error


async def _download_capabilities(client):
    try:
        async with client.stream(
            "GET", GIBS_WMS_URL,
            params={"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetCapabilities"},
            headers={"Accept": "application/xml", "User-Agent": "SIRIUS-Cartographie/1.0 (+https://sirius-assistant.fr)"},
        ) as response:
            if response.status_code != 200:
                raise RainUnavailable(f"NASA GIBS a répondu HTTP {response.status_code}.")
            declared = response.headers.get("content-length", "")
            if declared.isdigit() and int(declared) > MAX_BYTES:
                raise RainUnavailable("Description NASA GIBS trop volumineuse.")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_BYTES:
                    raise RainUnavailable("Description NASA GIBS trop volumineuse.")
            return bytes(body)
    except httpx.HTTPError as error:
        logger.warning("[VEILLE] NASA GIBS injoignable : %s", type(error).__name__)
        raise RainUnavailable("NASA GIBS ne répond pas pour le moment.") from error


async def rain_metadata(*, now=None, transport=None):
    global _cache
    now = now or datetime.now(timezone.utc)
    source = {"label": "Pluie satellite", "provider": "NASA GIBS — IMERG", "ok": False, "detail": None}
    result = {"kind": "pluie", "read_only": True, "latest": None, "times": [], "source": source}
    entry = _cache
    if entry is None or time.monotonic() - entry[0] >= entry[1]:
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT, transport=transport, follow_redirects=False) as client:
                value = _parse_capabilities(await _download_capabilities(client), now)
            entry = (time.monotonic(), 300, value)
        except RainUnavailable as error:
            entry = (time.monotonic(), 60, str(error))
        _cache = entry
    if isinstance(entry[2], str):
        source["detail"] = entry[2]
    else:
        result.update(entry[2])
        source["ok"] = True
    return result
