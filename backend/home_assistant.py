# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""KERAUNOS# — module domotique Home Assistant (proxy REST)."""
import re
import unicodedata
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional

CONTROLLABLE = {"light", "switch", "fan", "input_boolean", "cover", "lock", "media_player", "climate", "vacuum", "scene", "script"}
SHOWN_DOMAINS = CONTROLLABLE | {"sensor", "binary_sensor", "person", "weather"}


class HaConfig(BaseModel):
    base_url: str
    token: str


class HaTest(BaseModel):
    base_url: Optional[str] = None
    token: Optional[str] = None


class HaService(BaseModel):
    domain: str = Field(min_length=1, pattern=r"^[a-z_]+$")
    service: str = Field(min_length=1, pattern=r"^[a-z_]+$")
    data: dict = Field(default_factory=dict)


class HaToggle(BaseModel):
    entity_id: str = Field(min_length=3, pattern=r"^[a-z_]+\.[a-zA-Z0-9_]+$")


class HaCommand(BaseModel):
    text: str = Field(min_length=2, max_length=300)


def _norm(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", (s or "").lower()) if unicodedata.category(c) != "Mn")


STOP = {"allume", "allumes", "allumez", "allumer", "rallume", "eteins", "eteindre", "eteignez", "eteint", "coupe", "desactive", "active", "bascule", "lance", "mets", "met", "regle", "baisse", "monte", "la", "le", "les", "l", "de", "du", "des", "d", "un", "une", "dans", "a", "au", "aux", "sur", "pour", "lumiere", "lumieres", "lampe", "lampes", "plafonnier", "spot", "spots", "led", "leds", "prise", "prises", "interrupteur", "ventilateur", "volet", "volets", "store", "scene", "luminosite", "cent", "pourcent", "moi", "s", "il", "te", "plait", "sirius", "stp", "toute", "toutes", "tout", "tous", "et", "en", "mode", "maison", "ma", "mon", "mes"}

_DOMAIN_HINTS = [
    (r"lumiere|lampe|plafonnier|spot|led", "light"),
    (r"prise|interrupteur", "switch"),
    (r"ventilateur", "fan"),
    (r"volet|store", "cover"),
    (r"scene", "scene"),
]


def make_ha_router(db):
    router = APIRouter(prefix="/ha", tags=["home-assistant"])
    coll = db.ha_config

    async def get_conf():
        return await coll.find_one({"_id": "main"})

    async def ha_request(base_url: str, token: str, method: str, path: str, json=None):
        headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=12) as c:
                r = await c.request(method, base_url.rstrip("/") + path, headers=headers, json=json)
        except httpx.ConnectError:
            raise HTTPException(400, "Impossible de joindre Home Assistant à cette adresse.")
        except httpx.TimeoutException:
            raise HTTPException(400, "Home Assistant ne répond pas (délai dépassé).")
        except httpx.HTTPError as e:
            raise HTTPException(400, f"Erreur de connexion : {str(e)[:150]}")
        if r.status_code == 401:
            raise HTTPException(401, "Token invalide ou expiré.")
        if r.status_code >= 400:
            raise HTTPException(r.status_code, f"Erreur Home Assistant : {r.text[:200]}")
        return r.json() if r.content else None

    @router.get("/config")
    async def read_config():
        doc = await get_conf()
        if not doc:
            return {"configured": False, "base_url": None}
        return {"configured": True, "base_url": doc.get("base_url")}

    @router.post("/config")
    async def save_config(body: HaConfig):
        url = body.base_url.strip().rstrip("/")
        if not url.startswith("http"):
            raise HTTPException(400, "L'URL doit commencer par http:// ou https://")
        info = await ha_request(url, body.token.strip(), "GET", "/api/")
        await coll.replace_one({"_id": "main"}, {"_id": "main", "base_url": url, "token": body.token.strip()}, upsert=True)
        return {"ok": True, "message": info.get("message", "API running.")}

    @router.delete("/config")
    async def delete_config():
        await coll.delete_one({"_id": "main"})
        return {"ok": True}

    @router.post("/test")
    async def test_connection(body: HaTest):
        url, token = body.base_url, body.token
        if not url or not token:
            doc = await get_conf()
            if not doc:
                raise HTTPException(400, "Aucune configuration enregistrée.")
            url = url or doc["base_url"]
            token = token or doc["token"]
        info = await ha_request(url.strip().rstrip("/"), token.strip(), "GET", "/api/")
        return {"ok": True, "message": info.get("message", "API running.")}

    @router.get("/states")
    async def list_states():
        doc = await get_conf()
        if not doc:
            raise HTTPException(400, "Home Assistant non configuré.")
        raw = await ha_request(doc["base_url"], doc["token"], "GET", "/api/states")
        entities = []
        for s in raw:
            eid = s.get("entity_id", "")
            domain = eid.split(".")[0]
            if domain not in SHOWN_DOMAINS:
                continue
            attrs = s.get("attributes", {}) or {}
            entities.append({
                "entity_id": eid,
                "domain": domain,
                "state": s.get("state"),
                "name": attrs.get("friendly_name") or eid,
                "unit": attrs.get("unit_of_measurement"),
                "device_class": attrs.get("device_class"),
                "brightness": attrs.get("brightness"),
                "controllable": domain in CONTROLLABLE,
            })
        entities.sort(key=lambda e: (not e["controllable"], e["domain"], e["name"].lower()))
        return {"entities": entities, "count": len(entities)}

    @router.post("/toggle")
    async def toggle(body: HaToggle):
        doc = await get_conf()
        if not doc:
            raise HTTPException(400, "Home Assistant non configuré.")
        domain = body.entity_id.split(".")[0]
        if domain in ("scene", "script"):
            await ha_request(doc["base_url"], doc["token"], "POST", f"/api/services/{domain}/turn_on", {"entity_id": body.entity_id})
        else:
            await ha_request(doc["base_url"], doc["token"], "POST", "/api/services/homeassistant/toggle", {"entity_id": body.entity_id})
        return {"ok": True}

    @router.post("/service")
    async def call_service(body: HaService):
        doc = await get_conf()
        if not doc:
            raise HTTPException(400, "Home Assistant non configuré.")
        await ha_request(doc["base_url"], doc["token"], "POST", f"/api/services/{body.domain}/{body.service}", body.data)
        return {"ok": True}

    @router.post("/command")
    async def voice_command(body: HaCommand):
        doc = await get_conf()
        if not doc:
            return {"ok": False, "speech": "Home Assistant n'est pas encore connecté, monsieur. Ouvrez le module KERAUNOS pour saisir votre URL et votre jeton."}
        low = _norm(body.text)

        try:
            raw = await ha_request(doc["base_url"], doc["token"], "GET", "/api/states")
        except HTTPException as e:
            return {"ok": False, "speech": f"Impossible d'interroger Home Assistant : {e.detail}"}
        ents = []
        for s in raw:
            eid = s.get("entity_id", "")
            dom = eid.split(".")[0]
            if dom in CONTROLLABLE:
                name = (s.get("attributes", {}) or {}).get("friendly_name") or eid
                ents.append({"entity_id": eid, "domain": dom, "name": name, "tokens": {t for t in re.findall(r"[a-z0-9]+", _norm(name)) if len(t) > 1}})
        if not ents:
            return {"ok": False, "speech": "Aucun appareil contrôlable détecté sur votre Home Assistant."}

        turn_off = bool(re.search(r"\b(eteins|eteindre|eteignez|eteint|coupe|desactive|ferme)\b", low))
        bright = re.search(r"(\d{1,3})\s*(?:%|pour ?cent)", low)
        pct = max(1, min(100, int(bright.group(1)) if bright else 50)) if bright else None
        target = None
        for e in ents:
            toks = e["tokens"]
            if (not target) or (len(toks) > len(target["tokens"])):
                target = e
        if not target:
            return {"ok": False, "speech": "Je n'ai pas trouvé d'appareil ciblé."}
        if turn_off:
            await ha_request(doc["base_url"], doc["token"], "POST", "/api/services/homeassistant/turn_off", {"entity_id": target["entity_id"]})
            return {"ok": True, "speech": f"J'ai éteint {target['name']}"}
        if pct is not None:
            await ha_request(doc["base_url"], doc["token"], "POST", "/api/services/light/turn_on", {"entity_id": target["entity_id"], "brightness_pct": pct})
            return {"ok": True, "speech": f"J'ai réglé {target['name']} à {pct}%"}
        await ha_request(doc["base_url"], doc["token"], "POST", "/api/services/homeassistant/turn_on", {"entity_id": target["entity_id"]})
        return {"ok": True, "speech": f"J'ai activé {target['name']}"}

    return router
