# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Réglages et aperçu de la veille locale, propres à chaque compte."""

from datetime import datetime, timezone
from typing import Annotated

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, StrictBool, StringConstraints

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

    @router.get("")
    async def preview(request: Request):
        user = await require_user(request, db)
        report = await osiris_watch.build_watch(await load_veille_settings(db, user["user_id"]))
        return {**report, "text": "\n".join(osiris_watch.watch_lines(report)).strip()}

    return router
