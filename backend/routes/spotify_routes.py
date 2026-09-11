# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Spotius : intégration Spotify (OAuth popup, morceau en cours, lecture, recherche)."""

import logging
import os
import secrets
import time

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET")
SPOTIFY_REDIRECT_URI = os.environ.get("SPOTIFY_REDIRECT_URI")
SPOTIFY_SCOPE = "user-read-currently-playing user-read-playback-state user-modify-playback-state streaming user-read-email user-read-private"

# Origine du SPA (localhost:3000 en dev), PAS celle de l'API qui sert cette popup elle-même
# (127.0.0.1:8001) : postMessage() n'est délivré que si targetOrigin correspond à l'origine
# réelle de window.opener, qui est le SPA — voir le même correctif dans microsoft_graph.py.
FRONTEND_URL = (os.environ.get("FRONTEND_URL") or "http://localhost:3000").rstrip("/")

# États OAuth anti-CSRF (usage unique, expiration 10 min)
_OAUTH_STATES = {}


def _new_oauth_state() -> str:
    now = time.time()
    for k, t in list(_OAUTH_STATES.items()):
        if now - t > 600:
            _OAUTH_STATES.pop(k, None)
    s = secrets.token_urlsafe(24)
    _OAUTH_STATES[s] = now
    return s


def _app_origin() -> str:
    from urllib.parse import urlparse
    u = urlparse(FRONTEND_URL)
    return f"{u.scheme}://{u.netloc}" if u.scheme and u.netloc else ""


def _popup_response(payload: dict) -> HTMLResponse:
    """Page popup qui renvoie le résultat à la fenêtre parente, origine stricte (anti-XSS)."""
    import json as _json
    body = _json.dumps(payload)
    origin = _json.dumps(_app_origin() or "null")
    ok = not payload.get("error")
    msg = "Spotify connecté ✓" if ok else "Erreur Spotify."
    return HTMLResponse(
        "<html><body style='background:#04111c;color:#22d3ee;font-family:sans-serif;text-align:center;padding-top:60px'>"
        f"<h2>{msg}</h2><p>Vous pouvez fermer cette fenêtre.</p>"
        f"<script>window.opener&&window.opener.postMessage({body},{origin});window.close();</script></body></html>"
    )


async def _spotify_refresh(refresh_token: str):
    async with httpx.AsyncClient(timeout=15) as cx:
        resp = await cx.post(
            "https://accounts.spotify.com/api/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": SPOTIFY_CLIENT_ID,
                "client_secret": SPOTIFY_CLIENT_SECRET,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if resp.status_code != 200:
        return None
    return resp.json().get("access_token")


class SpotifyTokens(BaseModel):
    access_token: str = ""
    refresh_token: str = ""


class SpotifyPlayRequest(BaseModel):
    access_token: str = ""
    refresh_token: str = ""
    query: str = ""
    device_id: str = ""


class SpotifyRefreshRequest(BaseModel):
    refresh_token: str = ""


class SpotifySearchRequest(BaseModel):
    access_token: str = ""
    refresh_token: str = ""
    query: str


def make_spotify_router():
    router = APIRouter(tags=["spotify"])

    @router.get("/spotify/login")
    async def spotify_login():
        """Génère l'URL d'autorisation Spotify avec un state valide pour le popup."""
        if not SPOTIFY_CLIENT_ID or not SPOTIFY_REDIRECT_URI:
            raise HTTPException(status_code=500, detail="Spotify non configuré")
        from urllib.parse import urlencode

        state = _new_oauth_state()
        params = {
            "client_id": SPOTIFY_CLIENT_ID,
            "response_type": "code",
            "redirect_uri": SPOTIFY_REDIRECT_URI,
            "scope": SPOTIFY_SCOPE,
            "show_dialog": "true",
            "state": state,
        }
        auth_url = "https://accounts.spotify.com/authorize?" + urlencode(params)
        return {"auth_url": auth_url}

    @router.get("/spotify/callback")
    async def spotify_callback(code: str = "", error: str = "", state: str = ""):
        """Reçoit le code Spotify, échange contre des tokens, et les renvoie à la fenêtre parente."""
        if state not in _OAUTH_STATES:
            return _popup_response({"type": "spotify-auth", "error": "invalid_state"})
        _OAUTH_STATES.pop(state, None)
        if error or not code:
            return _popup_response({"type": "spotify-auth", "error": (error or "no_code")[:80]})
        async with httpx.AsyncClient(timeout=15) as cx:
            resp = await cx.post(
                "https://accounts.spotify.com/api/token",
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": SPOTIFY_REDIRECT_URI,
                    "client_id": SPOTIFY_CLIENT_ID,
                    "client_secret": SPOTIFY_CLIENT_SECRET,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        if resp.status_code != 200:
            logger.error(f"[SPOTIFY] token exchange failed: {resp.text}")
            return _popup_response({"type": "spotify-auth", "error": "token_failed"})
        tok = resp.json()
        return _popup_response({
            "type": "spotify-auth",
            "access_token": tok.get("access_token"),
            "refresh_token": tok.get("refresh_token"),
        })

    @router.post("/spotify/current")
    async def spotify_current(req: SpotifyTokens):
        """Renvoie le morceau en cours de lecture (lecture seule, fonctionne sans Premium)."""
        if not req.refresh_token:
            raise HTTPException(status_code=401, detail="Non connecté à Spotify")

        access = await _spotify_refresh(req.refresh_token)
        if not access:
            raise HTTPException(status_code=401, detail="Session Spotify expirée, reconnectez-vous")

        async def fetch(token):
            async with httpx.AsyncClient(timeout=15) as cx:
                return await cx.get(
                    "https://api.spotify.com/v1/me/player",
                    headers={"Authorization": f"Bearer {token}"},
                )

        resp = await fetch(access)

        if resp.status_code == 204 or not resp.content:
            return {"playing": False, "access_token": access}
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="Erreur Spotify")

        data = resp.json()
        item = data.get("item") or {}
        artists = ", ".join(a.get("name", "") for a in item.get("artists", []))
        images = (item.get("album", {}) or {}).get("images", [])

        return {
            "playing": bool(data.get("is_playing")),
            "title": item.get("name", ""),
            "artist": artists,
            "album": (item.get("album", {}) or {}).get("name", ""),
            "image": images[0]["url"] if images else "",
            "url": (item.get("external_urls", {}) or {}).get("spotify", ""),
            "progress_ms": data.get("progress_ms") or 0,
            "duration_ms": item.get("duration_ms") or 0,
            "access_token": access,
        }

    @router.post("/spotify/refresh")
    async def spotify_refresh_endpoint(req: SpotifyRefreshRequest):
        """Renvoie un access_token frais (utilisé par le lecteur intégré du HUD)."""
        if not req.refresh_token:
            raise HTTPException(status_code=401, detail="Non connecté à Spotify")
        tok = await _spotify_refresh(req.refresh_token)
        if not tok:
            raise HTTPException(status_code=401, detail="Session Spotify expirée, reconnectez-vous")
        return {"access_token": tok}

    @router.post("/spotify/play")
    async def spotify_play(req: SpotifyPlayRequest):
        """Recherche un titre et lance la lecture sur l'appareil Spotify actif (Premium requis)."""
        if not req.access_token and not req.refresh_token:
            raise HTTPException(status_code=401, detail="Non connecté à Spotify")
        query = req.query.strip()
        if not query:
            raise HTTPException(status_code=400, detail="Requête vide")
        access = req.access_token
        new_access = None

        async def call(method, url, token, **kw):
            async with httpx.AsyncClient(timeout=15) as cx:
                return await cx.request(method, url, headers={"Authorization": f"Bearer {token}"}, **kw)

        search_url = "https://api.spotify.com/v1/search"
        search_params = {"q": query, "type": "track", "limit": 1}
        resp = await call("GET", search_url, access, params=search_params) if access else None
        if (resp is None or resp.status_code == 401) and req.refresh_token:
            new_access = await _spotify_refresh(req.refresh_token)
            if not new_access:
                raise HTTPException(status_code=401, detail="Session Spotify expirée, reconnectez-vous")
            access = new_access
            resp = await call("GET", search_url, access, params=search_params)
        if resp is None or resp.status_code != 200:
            raise HTTPException(status_code=401 if resp is None else resp.status_code, detail="Erreur recherche Spotify")
        items = resp.json().get("tracks", {}).get("items", [])
        if not items:
            return JSONResponse(status_code=404, content={"error": "not_found"})
        track = items[0]

        dev = await call("GET", "https://api.spotify.com/v1/me/player/devices", access)
        device_id = req.device_id or None
        if dev.status_code == 200:
            devices = dev.json().get("devices", [])
            # Priorité : appareil actif > lecteur intégré du HUD (device_id fourni) > premier appareil
            active = next((d for d in devices if d.get("is_active")), None)
            if active:
                device_id = active.get("id")
            elif not device_id and devices:
                device_id = devices[0].get("id")
        if not device_id:
            return JSONResponse(status_code=409, content={"error": "no_device"})

        play = await call("PUT", f"https://api.spotify.com/v1/me/player/play?device_id={device_id}",
                          access, json={"uris": [track["uri"]]})
        if play.status_code in (200, 202, 204):
            artists = ", ".join(a.get("name", "") for a in track.get("artists", []))
            return {"ok": True, "title": track.get("name", ""), "artist": artists, "access_token": new_access}
        if play.status_code == 403:
            reason = "scope" if "scope" in play.text.lower() else "premium"
            return JSONResponse(status_code=403, content={"error": reason})
        if play.status_code == 404:
            return JSONResponse(status_code=409, content={"error": "no_device"})
        logger.error(f"[SPOTIFY] play failed: {play.status_code} {play.text[:200]}")
        return JSONResponse(status_code=502, content={"error": "play_failed"})

    @router.post("/spotify/search")
    async def spotify_search(req: SpotifySearchRequest):
        """Recherche de titres Spotify pour le lecteur intégré du HUD."""
        if not req.access_token and not req.refresh_token:
            raise HTTPException(status_code=401, detail="Non connecté à Spotify")
        q = req.query.strip()
        if not q:
            raise HTTPException(status_code=400, detail="Requête vide")
        access = req.access_token
        new_access = None

        async def call(token):
            async with httpx.AsyncClient(timeout=15) as cx:
                return await cx.get(
                    "https://api.spotify.com/v1/search",
                    headers={"Authorization": f"Bearer {token}"},
                    params={"q": q, "type": "track", "limit": 8},
                )

        resp = await call(access) if access else None
        if (resp is None or resp.status_code == 401) and req.refresh_token:
            new_access = await _spotify_refresh(req.refresh_token)
            if not new_access:
                raise HTTPException(status_code=401, detail="Session Spotify expirée, reconnectez-vous")
            access = new_access
            resp = await call(access)
        if resp is None or resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Erreur recherche Spotify")
        tracks = []
        for t in resp.json().get("tracks", {}).get("items", []):
            album = t.get("album", {}) or {}
            imgs = album.get("images", [])
            tracks.append({
                "id": t.get("id", ""),
                "title": t.get("name", ""),
                "artist": ", ".join(a.get("name", "") for a in t.get("artists", [])),
                "album": album.get("name", ""),
                "image": imgs[-1]["url"] if imgs else "",
                "image_big": imgs[0]["url"] if imgs else "",
                "duration_ms": t.get("duration_ms") or 0,
            })
        return {"tracks": tracks, "access_token": new_access}

    return router
