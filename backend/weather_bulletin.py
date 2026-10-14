"""Bulletin Open-Meteo en °C et km/h, daté dans le fuseau de la ville.

Les conditions doivent dater de moins de deux heures (tolérance future de
15 minutes). Les prévisions couvrent exactement aujourd'hui et demain.
Aucune ville ni mesure n'est remplacée par une valeur par défaut.
"""

import asyncio
import math
import re
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx


CURRENT_UNITS = {
    "time": "iso8601", "temperature_2m": "°C", "apparent_temperature": "°C",
    "weather_code": "wmo code", "wind_speed_10m": "km/h",
}
DAILY_UNITS = {
    "time": "iso8601", "weather_code": "wmo code", "temperature_2m_min": "°C",
    "temperature_2m_max": "°C", "precipitation_probability_max": "%",
    "wind_speed_10m_max": "km/h",
}
WMO_CODES = {0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67,
             71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99}


def _number(value):
    if (not isinstance(value, (int, float)) or isinstance(value, bool)
            or not -1e6 <= value <= 1e6 or not math.isfinite(value)):
        raise ValueError("Mesure météo invalide.")
    return value


def _mapping(value):
    if not isinstance(value, dict):
        raise ValueError("Réponse météo invalide.")
    return value


def _city_key(value: str) -> str:
    return "".join(character for character in unicodedata.normalize("NFKD", value.casefold())
                   if character.isalnum() and not unicodedata.combining(character))


def _measure(field, value):
    value = _number(value)
    if field == "weather_code" and (value not in WMO_CODES or value != int(value)):
        raise ValueError("Code météo non pris en charge.")
    if field.startswith("wind_speed") and not 0 <= value <= 400:
        raise ValueError("Vent invalide.")
    if field.startswith("temperature_2m") and not -90 <= value <= 60:
        raise ValueError("Température météo invalide.")
    if field == "apparent_temperature" and not -100 <= value <= 70:
        raise ValueError("Température ressentie invalide.")
    if field == "precipitation_probability_max" and not 0 <= value <= 100:
        raise ValueError("Probabilité de précipitations invalide.")
    return value


def _validate_forecast(data):
    data = _mapping(data)
    current = _mapping(data["current"])
    daily = _mapping(data["daily"])
    for key, expected in (("current_units", CURRENT_UNITS), ("daily_units", DAILY_UNITS)):
        units = _mapping(data[key])
        if any(units.get(field) != unit for field, unit in expected.items()):
            raise ValueError("Unités météo incompatibles.")
    zone_name = data["timezone"]
    if not isinstance(zone_name, str) or not zone_name:
        raise ValueError("Fuseau météo invalide.")
    try:
        zone = ZoneInfo(zone_name)
    except ZoneInfoNotFoundError as error:
        raise ValueError("Fuseau météo invalide.") from error
    now = datetime.now(timezone.utc)
    local_now = now.astimezone(zone)
    offset = _number(data["utc_offset_seconds"])
    if offset != local_now.utcoffset().total_seconds():
        raise ValueError("Décalage horaire météo incohérent.")
    timestamp = current["time"]
    if not isinstance(timestamp, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", timestamp):
        raise ValueError("Date météo invalide.")
    observed = datetime.fromisoformat(timestamp).replace(tzinfo=zone)
    age = now - observed.astimezone(timezone.utc)
    if not -timedelta(minutes=15) <= age <= timedelta(hours=2):
        raise ValueError("Conditions météo périmées.")
    today = local_now.date()
    expected_dates = [today.isoformat(), (today + timedelta(days=1)).isoformat()]
    dates = daily["time"]
    if not isinstance(dates, list) or dates != expected_dates:
        raise ValueError("Dates des prévisions météo invalides.")
    for field in DAILY_UNITS:
        values = daily[field]
        if not isinstance(values, list) or len(values) != 2:
            raise ValueError("Prévisions météo incomplètes.")
    days = [{
        "date": day,
        **{field: _measure(field, daily[field][index]) for field in DAILY_UNITS if field != "time"},
    } for index, day in enumerate(dates)]
    if any(day["temperature_2m_min"] > day["temperature_2m_max"] for day in days):
        raise ValueError("Températures météo incohérentes.")
    return {
        "timezone": zone_name,
        "current": {"time": timestamp, **{field: _measure(field, current[field])
                                        for field in CURRENT_UNITS if field != "time"}},
        "current_units": dict(CURRENT_UNITS),
        "daily_units": dict(DAILY_UNITS),
        "days": days,
    }


class WeatherRateLimitedError(Exception):
    """Open-Meteo refuse temporairement les requêtes (HTTP 429)."""


LOCATION_TTL = 24 * 60 * 60
FORECAST_TTL = 20 * 60
MAX_RETRY_AFTER = 2.0
_CACHE_LIMIT = 256
_location_cache: dict = {}
_forecast_cache: dict = {}


def clear_weather_cache():
    _location_cache.clear()
    _forecast_cache.clear()


def _cache_get(cache, key):
    entry = cache.get(key)
    if entry and time.monotonic() - entry[0] < entry[1]:
        return entry[2]
    cache.pop(key, None)
    return None


def _cache_put(cache, key, value, ttl):
    if len(cache) >= _CACHE_LIMIT:
        cache.pop(next(iter(cache)))
    cache[key] = (time.monotonic(), ttl, value)


def _retry_delay(response):
    try:
        delay = float(response.headers.get("retry-after", "1"))
    except ValueError:
        return None
    return delay if 0 <= delay <= MAX_RETRY_AFTER else None


async def _get(client, url, params):
    """GET avec un seul nouvel essai court si Open-Meteo répond 429."""
    response = await client.get(url, params=params)
    if response.status_code == 429:
        delay = _retry_delay(response)
        if delay is not None:
            await asyncio.sleep(delay)
            response = await client.get(url, params=params)
        if response.status_code == 429:
            raise WeatherRateLimitedError("Limite de requêtes Open-Meteo atteinte.")
    response.raise_for_status()
    return response.json()


async def _locate(client, city):
    key = _city_key(city)
    cached = _cache_get(_location_cache, key)
    if cached:
        return cached
    payload = await _get(client, "https://geocoding-api.open-meteo.com/v1/search", {
        "name": city, "count": 1, "language": "fr", "format": "json",
    })
    locations = _mapping(payload).get("results", [])
    if not isinstance(locations, list):
        raise ValueError("Géocodage météo invalide.")
    if not locations:
        raise LookupError("Ville introuvable.")
    location = _mapping(locations[0])
    name = location["name"]
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Ville géocodée invalide.")
    if _city_key(name) != key:
        raise LookupError("Aucune correspondance exacte pour cette ville.")
    latitude = _number(location["latitude"])
    longitude = _number(location["longitude"])
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ValueError("Coordonnées météo invalides.")
    country = location.get("country", "")
    if not isinstance(country, str):
        raise ValueError("Pays géocodé invalide.")
    result = (name, country, latitude, longitude)
    _cache_put(_location_cache, key, result, LOCATION_TTL)
    return result


async def fetch_weather_bulletin(city: str) -> dict:
    if (not isinstance(city, str) or not city.strip() or len(city) > 120
            or re.search(r"[\x00-\x1f\x7f]", city) or not _city_key(city)):
        raise ValueError("Ville météo invalide.")
    city = city.strip()
    async with httpx.AsyncClient(timeout=5.0) as client:
        name, country, latitude, longitude = await _locate(client, city)
        coordinates = (round(latitude, 4), round(longitude, 4))
        data = _cache_get(_forecast_cache, coordinates)
        validated = None
        if data is not None:
            try:
                validated = _validate_forecast(data)
            except (ValueError, KeyError, TypeError, IndexError):
                _forecast_cache.pop(coordinates, None)
        if validated is None:
            data = await _get(client, "https://api.open-meteo.com/v1/forecast", {
                "latitude": latitude, "longitude": longitude,
                "timezone": "auto", "forecast_days": 2,
                "temperature_unit": "celsius", "wind_speed_unit": "kmh",
                "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
                "daily": "weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max,wind_speed_10m_max",
            })
            validated = _validate_forecast(data)
            _cache_put(_forecast_cache, coordinates, data, FORECAST_TTL)
    return {
        "city": name, "country": country, "source": "Open-Meteo",
        "url": "https://open-meteo.com/",
        **validated,
    }
