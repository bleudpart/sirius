"""Opt-in Smart Life devices, isolated by operator-verified Tuya account binding."""

import asyncio
import hashlib
import hmac
import json
import math
import os
import re
import time

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import Field, StrictBool

from action_registry import ActionInputs
from alexa_integration import hashed, stamp
from work_draft_recordings import insert_once
from workspace_channels import active_account

REGIONS = {
    "eu": "https://openapi.tuyaeu.com",
    "eu-west": "https://openapi-weaz.tuyaeu.com",
    "us": "https://openapi.tuyaus.com",
    "us-east": "https://openapi-ueaz.tuyaus.com",
    "cn": "https://openapi.tuyacn.com",
    "in": "https://openapi.tuyain.com",
    "sg": "https://openapi-sg.iotbing.com",
}
IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def config(uid):
    if os.getenv("SIRIUS_TUYA_ENABLED") != "1":
        raise HTTPException(503, "Connecteur Smart Life désactivé.")
    client, secret = os.getenv("TUYA_CLIENT_ID", ""), os.getenv("TUYA_CLIENT_SECRET", "")
    region = os.getenv("TUYA_REGION", "")
    try:
        bindings = json.loads(os.getenv("SIRIUS_TUYA_USER_BINDINGS", "{}"))
    except ValueError as exc:
        raise HTTPException(503, "Liaisons Tuya serveur invalides.") from exc
    if not isinstance(bindings, dict) or region not in REGIONS or not client or len(secret) < 16:
        raise HTTPException(503, "Projet Tuya serveur non configuré.")
    account = bindings.get(uid)
    if not isinstance(account, str) or not IDENTIFIER.fullmatch(account):
        raise HTTPException(403, "Ce compte SIRIUS n'est pas lié à un compte Smart Life vérifié.")
    if list(bindings.values()).count(account) != 1:
        raise HTTPException(503, "Un compte Smart Life ne peut être partagé entre comptes SIRIUS.")
    return client, secret, REGIONS[region], account


def signature(client, secret, token, timestamp, method, path, body=b""):
    text = method + "\n" + hashlib.sha256(body).hexdigest() + "\n\n" + path
    return hmac.new(secret.encode(), (client + token + timestamp + text).encode(),
                    hashlib.sha256).hexdigest().upper()


class DeviceSelection(ActionInputs):
    device_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=60)
    confirm_noncritical: StrictBool


class HomeCommand(ActionInputs):
    endpoint_id: str = Field(min_length=1, max_length=100)
    message_id: str = Field(min_length=1, max_length=128)
    action: str = Field(pattern=r"^(TurnOn|TurnOff|SetBrightness|AdjustBrightness)$")
    value: int | None = Field(default=None, strict=True, ge=-100, le=100)


def capabilities(device, specifications):
    category = device.get("category")
    if category not in {"dj", "cz"}:
        raise HTTPException(422, "Seules les lampes dj et prises cz sont prises en charge.")
    functions = specifications.get("functions")
    if not isinstance(functions, list) or any(not isinstance(item, dict) for item in functions):
        raise HTTPException(502, "Fonctions Tuya absentes.")
    switches = [item for item in functions if item.get("code") in {"switch_led", "switch_1", "switch"}
                and item.get("type") == "Boolean"]
    # Multi-channel sockets cannot be represented by a single power controller.
    if len(switches) != 1 or any(re.fullmatch(r"switch_\d+", str(item.get("code", "")))
                                and item.get("code") != "switch_1" for item in functions):
        raise HTTPException(422, "Appareil multicanal ou interrupteur non compatible.")
    result = {"category": category, "power_code": switches[0]["code"]}
    brightness = [item for item in functions if item.get("code") in {"bright_value", "bright_value_v2"}
                  and item.get("type") == "Integer"]
    if category == "dj" and len(brightness) == 1:
        try:
            bounds = json.loads(brightness[0]["values"])
            low, high, step = bounds["min"], bounds["max"], bounds.get("step", 1)
            if (any(type(value) is not int for value in (low, high, step)) or
                    not 0 <= low < high <= 10000 or step < 1 or (high - low) % step
                    or bounds.get("scale", 0) != 0):
                raise ValueError("Unsupported brightness range")
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(422, "Plage de luminosité Tuya non prise en charge.") from exc
        result["brightness"] = {"code": brightness[0]["code"], "min": low, "max": high, "step": step}
    return result


def observed(device, result):
    if not isinstance(result, list) or any(not isinstance(item, dict) for item in result):
        raise HTTPException(502, "État Tuya illisible.")
    values = {item.get("code"): item.get("value") for item in result}
    power = values.get(device["power_code"])
    if type(power) is not bool:
        raise HTTPException(502, "État marche/arrêt Tuya absent.")
    state = {"powerState": "ON" if power else "OFF"}
    if device.get("brightness"):
        bounds = device["brightness"]
        raw = values.get(bounds["code"])
        if type(raw) is not int or not bounds["min"] <= raw <= bounds["max"]:
            raise HTTPException(502, "État de luminosité Tuya absent ou hors plage.")
        state["brightness"] = round((raw - bounds["min"]) * 100 / (bounds["max"] - bounds["min"]))
    return state


class TuyaIntegration:
    def __init__(self, db, alexa, transport=None):
        self.db, self.alexa, self.transport = db, alexa, transport
        self._token = None
        self._expires = 0
        self._project = None
        self._token_lock = asyncio.Lock()

    async def request(self, conf, method, path, body=None, token=""):
        client, secret, origin, _ = conf
        raw = json.dumps(body, separators=(",", ":")).encode() if body is not None else b""
        timestamp = str(int(time.time() * 1000))
        headers = {"client_id": client, "t": timestamp, "sign_method": "HMAC-SHA256",
                   "sign": signature(client, secret, token, timestamp, method, path, raw),
                   "Content-Type": "application/json"}
        if token:
            headers["access_token"] = token
        try:
            async with httpx.AsyncClient(timeout=2, transport=self.transport, follow_redirects=False,
                                         trust_env=False) as session:
                response = await session.request(method, origin + path, content=raw, headers=headers)
            if response.status_code != 200:
                raise HTTPException(502, "Tuya indisponible ; vérifier le projet et son abonnement API.")
            data = response.json()
        except httpx.RequestError as exc:
            raise HTTPException(503, "Tuya inaccessible ; résultat de commande éventuellement incertain.") from exc
        except ValueError as exc:
            raise HTTPException(502, "Réponse Tuya illisible.") from exc
        if not isinstance(data, dict) or data.get("success") is not True or "result" not in data:
            raise HTTPException(502, "Tuya a refusé la requête ; vérifier droits, région et disponibilité.")
        return data["result"]

    async def token(self, conf):
        project = hashed("|".join(conf[:3]))
        async with self._token_lock:
            if self._project == project and self._token and self._expires > time.monotonic():
                return self._token
            data = await self.request(conf, "GET", "/v1.0/token?grant_type=1")
            if (not isinstance(data, dict) or not isinstance(data.get("access_token"), str)
                    or not data["access_token"] or type(data.get("expire_time")) is not int
                    or data["expire_time"] <= 60):
                raise HTTPException(502, "Jeton Tuya non conforme.")
            self._project, self._token = project, data["access_token"]
            self._expires = time.monotonic() + data["expire_time"] - 60
            return self._token

    async def devices(self, conf, token):
        data = await self.request(conf, "GET", f"/v1.0/users/{conf[3]}/devices", token=token)
        if not isinstance(data, list) or len(data) > 100 or any(not isinstance(item, dict) for item in data):
            raise HTTPException(502, "Liste Tuya non conforme ou supérieure à 100 appareils.")
        return data

    def binding(self, conf):
        return hashed("|".join((conf[0], conf[2], conf[3])))

    async def select(self, uid, body):
        if not body.confirm_noncritical or not body.name.strip() or any(ord(c) < 32 for c in body.name):
            raise HTTPException(422, "Confirmer un appareil non critique et fournir son nom vocal.")
        conf = config(uid)
        token = await self.token(conf)
        device = next((d for d in await self.devices(conf, token) if d.get("id") == body.device_id), None)
        if not device:
            raise HTTPException(404, "Appareil absent du compte Smart Life lié.")
        specs = await self.request(conf, "GET", f"/v1.0/devices/{body.device_id}/specifications", token=token)
        if not isinstance(specs, dict):
            raise HTTPException(502, "Spécifications Tuya illisibles.")
        controls = capabilities(device, specs)
        identity = hashed(uid + "|" + self.binding(conf) + "|" + body.device_id)
        existing = await self.db.sirius_tuya_devices.find_one({"user_id": uid, "id": identity, "enabled": True})
        if not existing and await self.db.sirius_tuya_devices.count_documents({"user_id": uid, "enabled": True}) >= 100:
            raise HTTPException(409, "Cent autorisations maximum ; retirer un appareil avant d'en ajouter un.")
        values = {
            "user_id": uid, "id": identity, "device_id": body.device_id, "binding": self.binding(conf),
            "name": body.name.strip(), "enabled": True, "confirmed_at": stamp(), **controls,
        }
        await insert_once(self.db, "sirius_tuya_devices", values)
        await self.db.sirius_tuya_devices.update_one({"user_id": uid, "id": identity},
                                                    {"$set": values, **({"$unset": {"brightness": ""}}
                                                      if "brightness" not in values else {})})
        return {"endpoint_id": identity, "name": body.name.strip(), **controls}

    async def discover(self, uid):
        conf = config(uid)
        owned = {d.get("id"): d for d in await self.devices(conf, await self.token(conf))}
        rows = await self.db.sirius_tuya_devices.find(
            {"user_id": uid, "enabled": True, "binding": self.binding(conf)}, {"_id": 0}).to_list(101)
        if len(rows) > 100:
            raise HTTPException(409, "Plus de 100 appareils autorisés ; retirer des autorisations.")
        return {"devices": [{"endpoint_id": d["id"], "name": d["name"],
                             "category": "LIGHT" if d["category"] == "dj" else "SMARTPLUG",
                             "brightness": bool(d.get("brightness"))}
                            for d in rows if d["device_id"] in owned
                            and owned[d["device_id"]].get("category") == d["category"]]}

    async def device(self, uid, identity):
        conf = config(uid)
        row = await self.db.sirius_tuya_devices.find_one(
            {"user_id": uid, "id": identity, "enabled": True, "binding": self.binding(conf)})
        if not row:
            raise HTTPException(404, "Appareil non autorisé.")
        token = await self.token(conf)
        owned = next((d for d in await self.devices(conf, token) if d.get("id") == row["device_id"]), None)
        if not owned or owned.get("category") != row["category"]:
            raise HTTPException(404, "Appareil retiré du compte Smart Life.")
        if owned.get("online") is not True:
            raise HTTPException(503, "Appareil Smart Life hors ligne.")
        return row, conf, token

    async def state(self, device, conf, token):
        values = await self.request(conf, "GET", f"/v1.0/devices/{device['device_id']}/status", token=token)
        return observed(device, values)

    async def report(self, uid, identity):
        row, conf, token = await self.device(uid, identity)
        return {"state": await self.state(row, conf, token), "observed_at": stamp()}

    async def command(self, uid, body):
        await self.db.sirius_tuya_commands.delete_many({"created_at": {"$lt": stamp(-30 * 86400)}})
        fingerprint = hashed(json.dumps(body.model_dump(), sort_keys=True))
        identity = hashed(body.message_id)
        row = {"id": identity, "user_id": uid, "fingerprint": fingerprint,
               "endpoint_id": body.endpoint_id, "state": "EXECUTING", "created_at": stamp()}
        previous, created = await insert_once(self.db, "sirius_tuya_commands", row)
        if not created:
            if previous["fingerprint"] != fingerprint:
                raise HTTPException(409, "Identifiant de directive réutilisé avec une autre commande.")
            # Even a completed command cannot disclose a device revoked since its execution.
            await self.device(uid, body.endpoint_id)
            if previous["state"] == "SUCCEEDED":
                return previous["result"]
            raise HTTPException(409, "Commande déjà engagée ; contrôler l'appareil, aucune relance automatique.")
        try:
            result = await self.execute(uid, body)
        except (HTTPException, TimeoutError, asyncio.CancelledError):
            await self.db.sirius_tuya_commands.update_one({"id": identity, "user_id": uid},
                                                         {"$set": {"state": "UNCERTAIN"}})
            raise
        await self.db.sirius_tuya_commands.update_one({"id": identity, "user_id": uid},
                                                     {"$set": {"state": "SUCCEEDED", "result": result}})
        return result

    async def execute(self, uid, body):
        row, conf, token = await self.device(uid, body.endpoint_id)
        if body.action in {"TurnOn", "TurnOff"}:
            if body.value is not None:
                raise HTTPException(422, "Valeur inattendue pour marche/arrêt.")
            code, desired = row["power_code"], body.action == "TurnOn"
            expected = {"powerState": "ON" if desired else "OFF"}
        else:
            bounds = row.get("brightness")
            if not bounds or body.value is None or (body.action == "SetBrightness" and body.value < 0):
                raise HTTPException(422, "Luminosité non prise en charge ou valeur invalide.")
            code, desired, expected = bounds["code"], None, None
        await insert_once(self.db, "sirius_tuya_locks",
                          {"id": row["id"], "user_id": uid, "until": stamp(-1)})
        locked = await self.db.sirius_tuya_locks.update_one(
            {"id": row["id"], "user_id": uid, "until": {"$lt": stamp()}}, {"$set": {"until": stamp(15)}})
        if not locked.modified_count:
            raise HTTPException(409, "Appareil occupé ; patienter avant une nouvelle commande.")
        # No immediate unlock on failure: an outgoing request may still reach the device.
        if body.action in {"SetBrightness", "AdjustBrightness"}:
            percent = body.value
            if body.action == "AdjustBrightness":
                percent = max(0, min(100, (await self.state(row, conf, token))["brightness"] + percent))
            units = math.floor(percent * (bounds["max"] - bounds["min"]) / (100 * bounds["step"]) + 0.5)
            desired = bounds["min"] + units * bounds["step"]
            expected = {"brightness": round((desired - bounds["min"]) * 100 / (bounds["max"] - bounds["min"]))}
        # Revalidate consent/account immediately before the only physical write.
        await active_account(self.db, uid)
        latest = await self.db.sirius_tuya_devices.find_one(
            {"id": row["id"], "user_id": uid, "enabled": True, "binding": self.binding(config(uid)),
             "confirmed_at": row["confirmed_at"]})
        if not latest:
            raise HTTPException(409, "Autorisation de l'appareil modifiée.")
        ack = await self.request(conf, "POST", f"/v1.0/devices/{row['device_id']}/commands",
                                 {"commands": [{"code": code, "value": desired}]}, token)
        if ack is not True:
            raise HTTPException(502, "Commande Tuya non acquittée ; résultat incertain.")
        state = await self.state(row, conf, token)
        if any(state.get(key) != value for key, value in expected.items()):
            raise HTTPException(409, "État non encore confirmé ; résultat incertain, aucune relance.")
        await self.db.sirius_tuya_locks.update_one({"id": row["id"], "user_id": uid},
                                                  {"$set": {"until": stamp(-1)}})
        return {"state": state, "observed_at": stamp()}


def make_tuya_router(service, require_user):
    router = APIRouter(prefix="/integrations/tuya", tags=["tuya"])
    db = service.db

    async def session(request, active=True):
        user = await require_user(request, db)
        if active:
            await active_account(db, user["user_id"])
        return user["user_id"]

    @router.get("/devices")
    async def devices(request: Request):
        uid = await session(request)
        conf = config(uid)
        try:
            async with asyncio.timeout(6):
                items = await service.devices(conf, await service.token(conf))
        except TimeoutError as exc:
            raise HTTPException(504, "Liste Smart Life indisponible dans le délai.") from exc
        return {"items": [{"device_id": d["id"], "name": d.get("name"), "category": d.get("category"),
                           "online": d.get("online") is True} for d in items if d.get("category") in {"dj", "cz"}]}

    @router.get("/selections")
    async def selections(request: Request):
        uid = await session(request, active=False)
        rows = await db.sirius_tuya_devices.find({"user_id": uid}, {"_id": 0}).sort("confirmed_at", -1).to_list(101)
        return {"items": rows[:100], "truncated": len(rows) > 100}

    @router.post("/selections")
    async def select(body: DeviceSelection, request: Request):
        uid = await session(request)
        try:
            async with asyncio.timeout(6):
                return await service.select(uid, body)
        except TimeoutError as exc:
            raise HTTPException(504, "Sélection Smart Life indisponible dans le délai ; vérifier les autorisations.") from exc

    @router.delete("/selections/{identity}")
    async def remove(identity: str, request: Request):
        uid = await session(request, active=False)
        result = await db.sirius_tuya_devices.update_one({"user_id": uid, "id": identity},
                                                        {"$set": {"enabled": False}})
        if not result.matched_count:
            raise HTTPException(404, "Autorisation introuvable.")
        return {"revoked": True}

    @router.get("/alexa/discovery")
    async def discovery(request: Request):
        row = await service.alexa.identity(request, "home:read")
        try:
            async with asyncio.timeout(5.5):
                return await service.discover(row["user_id"])
        except TimeoutError as exc:
            raise HTTPException(504, "Découverte Smart Life trop lente.") from exc

    @router.get("/alexa/state/{identity}")
    async def state(identity: str, request: Request):
        row = await service.alexa.identity(request, "home:read")
        try:
            async with asyncio.timeout(5.5):
                return await service.report(row["user_id"], identity)
        except TimeoutError as exc:
            raise HTTPException(504, "État Smart Life indisponible dans le délai.") from exc

    @router.post("/alexa/command")
    async def command(body: HomeCommand, request: Request):
        row = await service.alexa.identity(request, "home:control")
        try:
            async with asyncio.timeout(5.5):
                return await service.command(row["user_id"], body)
        except TimeoutError as exc:
            raise HTTPException(504, "Délai dépassé ; résultat incertain, vérifier l'appareil sans relancer.") from exc

    return router
