# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Réglages et aperçu de la veille locale, propres à chaque compte."""

from datetime import datetime, timezone
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, StrictBool, StringConstraints

import gibs_rain
import osiris_watch
import weather_bulletin

COLLECTION = "sirius_veille_settings"


class VeilleSettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    enabled: StrictBool
    city: Annotated[str, StringConstraints(max_length=120)] = ""
    meteo_locale: StrictBool = True
    evenements: StrictBool = True
    marches: StrictBool = True


async def load_veille_settings(db, user_id: str):
    return await db[COLLECTION].find_one({"user_id": user_id}, {"_id": 0})


def public_settings(document) -> dict:
    document = document or {}
    location = osiris_watch.valid_location(document.get("location"))
    return {
        "configured": bool(document),
        "enabled": document.get("enabled") is True,
        "city": document.get("city") or "",
        "location": {"name": location["name"], "country": location["country"]} if location else None,
        **{key: document.get(key, True) is not False for key in osiris_watch.TOGGLES},
        "updated_at": document.get("updated_at"),
        "radius_km": osiris_watch.RADIUS_KM,
    }


async def _locate(city: str) -> dict:
    try:
        name, country, latitude, longitude = await weather_bulletin.locate_city(city)
    except LookupError as error:
        raise HTTPException(422, "Ville introuvable : indiquez le nom exact de la commune.") from error
    except weather_bulletin.WeatherRateLimitedError as error:
        raise HTTPException(503, "Recherche de ville momentanément limitée par Open-Meteo ; réessayez plus tard.") from error
    except httpx.HTTPError as error:
        raise HTTPException(503, "Recherche de ville Open-Meteo indisponible ; réessayez plus tard.") from error
    except (KeyError, TypeError, ValueError) as error:
        raise HTTPException(422, "Ville invalide.") from error
    return {"name": name, "country": country, "latitude": latitude, "longitude": longitude}


def make_veille_router(db, require_user):
    router = APIRouter(prefix="/veille", tags=["veille"])

    @router.get("/settings")
    async def get_settings(request: Request):
        user = await require_user(request, db)
        return public_settings(await load_veille_settings(db, user["user_id"]))

    @router.put("/settings")
    async def put_settings(body: VeilleSettingsIn, request: Request):
        user = await require_user(request, db)
        uid = user["user_id"]
        current = await load_veille_settings(db, uid) or {}
        if body.enabled and not body.city:
            raise HTTPException(422, "Indiquez la ville de l'établissement pour activer la veille.")
        if body.enabled and not any(getattr(body, key) for key in osiris_watch.TOGGLES):
            raise HTTPException(422, "Choisissez au moins une source de veille.")
        location = None
        if body.city:
            known = osiris_watch.valid_location(current.get("location"))
            location = known if known and current.get("city") == body.city else await _locate(body.city)
        document = {
            **body.model_dump(), "user_id": uid, "location": location,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        await db[COLLECTION].update_one({"user_id": uid}, {"$set": document}, upsert=True)
        return public_settings(document)

    @router.get("/carte")
    async def map_points(request: Request):
        user = await require_user(request, db)
        return await osiris_watch.build_map(await load_veille_settings(db, user["user_id"]))

    async def map_context(request, south, west, north, east, radius_km):
        user = await require_user(request, db)
        if south >= north or west >= east or east - west > 360:
            raise HTTPException(422, "Zone de carte invalide.")
        if radius_km is not None and radius_km not in osiris_watch.MAP_RADII_KM:
            raise HTTPException(422, "Rayon de carte invalide.")
        settings = await load_veille_settings(db, user["user_id"])
        if radius_km is not None and not osiris_watch.valid_location((settings or {}).get("location")):
            raise HTTPException(422, "Renseignez une ville pour utiliser le filtre par rayon.")
        return settings, {"south": south, "west": west, "north": north, "east": east}

    @router.get("/carte/calques/{kind}")
    async def map_layer(
        kind: Literal["avion", "satellite", "conflit", "actualite", "maritime", "camera"],
        request: Request,
        south: float = Query(..., ge=-90, le=90),
        west: float = Query(..., ge=-540, le=540),
        north: float = Query(..., ge=-90, le=90),
        east: float = Query(..., ge=-540, le=540),
        radius_km: int | None = None,
    ):
        settings, bounds = await map_context(request, south, west, north, east, radius_km)
        return await osiris_watch.build_map_layer(settings, kind, bounds, radius_km)

    @router.get("/carte/vent")
    async def map_wind(
        request: Request,
        south: float = Query(..., ge=-90, le=90),
        west: float = Query(..., ge=-540, le=540),
        north: float = Query(..., ge=-90, le=90),
        east: float = Query(..., ge=-540, le=540),
        radius_km: int | None = None,
        forecast_time: datetime | None = Query(None, alias="t"),
    ):
        settings, bounds = await map_context(request, south, west, north, east, radius_km)
        if forecast_time is not None and forecast_time.utcoffset() is None:
            raise HTTPException(422, "L'horaire de vent doit préciser son fuseau.")
        return await osiris_watch.build_map_wind(
            settings, bounds, radius_km,
            forecast_time.astimezone(timezone.utc) if forecast_time is not None else None,
        )

    @router.get("/carte/pluie")
    async def map_rain(request: Request):
        await require_user(request, db)
        return await gibs_rain.rain_metadata()

    @router.get("")
    async def preview(request: Request):
        user = await require_user(request, db)
        report = await osiris_watch.build_watch(await load_veille_settings(db, user["user_id"]))
        return {**report, "text": "\n".join(osiris_watch.watch_lines(report)).strip()}

    return router
