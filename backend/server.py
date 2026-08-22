# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).

import os
import sys
import time
import uuid
import ast
import shutil
import asyncio
import logging
import re
import json
import secrets
from pathlib import Path
from datetime import datetime, timezone
from typing import List, Optional

from dotenv import load_dotenv
from pydantic import BaseModel, Field, ConfigDict

from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, Request, Depends, BackgroundTasks, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from starlette.types import ASGIApp, Scope, Receive, Send

# 1. Chargement des variables d'environnement
ROOT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = ROOT_DIR.parent
FRONTEND_DIR = PROJECT_DIR / "frontend"
load_dotenv(ROOT_DIR / '.env')

from sirius_brain import ask_sirius, parse_intent, enrich_briefing, hn_bulletin, doc_narrative, k3_source

# 2. Configuration des logs
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# =========================================================
# INITIALISATION UNIQUE DE L'APPLICATION ET INTERCEPTATION OPTIONS
# =========================================================

app = FastAPI(title="Sirius Backend API", version="1.0.0")

# Imports des modules Sirius
from storage import put_object, get_object, init_storage, cloud_available, APP_NAME
from local_memory import list_facts, add_fact, delete_fact, update_fact, log_event, prime_overview, log_service, list_service_log
from auth_api import resolve_user_id, require_user  # noqa: E402

# 5. Connexion MongoDB
mongo_url = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
db_name = os.environ.get('DB_NAME', 'sirius_db')
client = AsyncIOMotorClient(mongo_url)
db = client[db_name]

# 6. Initialisation du routeur principal pour /api
api_router = APIRouter(prefix="/api")

@app.get("/health")
async def health_check():
    return {"status": "ok"}

@api_router.post("/argus/scan")
async def argus_scan():
    return {"errors": [], "history": []}

@api_router.post("/suggestions/evaluate")
async def suggestions_evaluate():
    return {
        "settings": {"mode": "equilibre"},
        "suggestions": [
            {
                "urgency": "faible",
                "risk_level": "faible",
                "description": "SIRIUS est prêt à vous assister sans intervention supplémentaire."
            },
            {
                "urgency": "moyenne",
                "risk_level": "moyenne",
                "description": "Vérifiez les tâches prioritaires avant de lancer un nouveau workflow."
            }
        ]
    }

@api_router.get("/suggestions/undefined/action")
async def suggestions_undefined_action_get():
    return {"ok": True, "mode": "noop", "message": "Aucune action suggérée pour ce cas."}

@api_router.post("/suggestions/undefined/action")
async def suggestions_undefined_action_post():
    return {"ok": True, "mode": "noop", "message": "Aucune action suggérée pour ce cas."}

@api_router.get("/atlas/route")
async def atlas_route_get():
    return {"ok": True, "route": {"from": "Paris", "to": "Lyon", "distance_km": 420}, "status": "stub"}

@api_router.post("/atlas/route")
async def atlas_route_post(payload: dict | None = None):
    body = payload or {}
    return {"ok": True, "route": {"from": body.get("from_address", "Paris"), "to": body.get("to_address", "Lyon"), "distance_km": 420}, "status": "stub"}

@api_router.get("/heracles/check")
async def heracles_check_get():
    return {"ok": True, "status": "ok", "result": "Heracles check stub ready"}

@api_router.post("/heracles/check")
async def heracles_check_post(payload: dict | None = None):
    body = payload or {}
    return {"ok": True, "status": "ok", "input": body.get("input", "@sirius_diag"), "result": "Heracles check stub ready"}

# Define Models
class StatusCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")  # Ignore MongoDB's _id field
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StatusCheckCreate(BaseModel):
    client_name: str

# ---- Cerveau intelligent SIRIUS (Kimi K3 + recherche web) ----
class ChatRequest(BaseModel):
    text: str
    session_id: str = "default"
    keys: dict = {}
    profile: dict = {}
    memory: list = []
    mode: str = "normal"
    ia_mode: str = "profond"
    mood: dict = {}

# Limitation de débit simple (anti-abus des clés serveur)
_RATE = {}

def _rate_ok(ip: str, limit: int = 30, window: int = 60) -> bool:
    now = time.time()
    q = [t for t in _RATE.get(ip, []) if now - t < window]
    if len(q) >= limit:
        _RATE[ip] = q
        return False
    q.append(now)
    _RATE[ip] = q
    return True

class IntentRequest(BaseModel):
    text: str

@api_router.post("/intent")
async def ui_intent(req: IntentRequest, request: Request):
    """Compréhension naturelle d'une commande vocale → intention UI structurée (Groq)."""
    print(">>> 1. Entrée dans /intent")
    
    await require_user(request, db)
    print(">>> 2. Utilisateur authentifié avec succès")
    
    ip = request.client.host if request.client else "?"
    if not _rate_ok(ip, limit=60, window=60):
        print(">>> 3. Rate limit dépassé")
        return {"action": "none"}
        
    print(">>> 4. Appel de parse_intent...")
    result = await parse_intent((req.text or "").strip())
    print(">>> 5. parse_intent terminé, retour au client.")
    return result

class ResetRequest(BaseModel):
    session_id: str = "default"

@api_router.post("/chat")
async def chat(req: ChatRequest, request: Request):
    """Reçoit une commande, génère une réponse intelligente et garde l'historique."""
    uid = (await require_user(request, db))["user_id"]
    texte = (req.text or "").strip()
    if not texte:
        raise HTTPException(status_code=400, detail="Texte vide")
    if not _rate_ok(uid):
        raise HTTPException(status_code=429, detail="Trop de requêtes, patientez un instant.")
    session_id = f"{uid}:{req.session_id or 'default'}"

    # Historique de la session (8 derniers échanges)
    doc = await db.sirius_chats.find_one({"session_id": session_id}, {"_id": 0, "history": 1})
    history = (doc or {}).get("history", [])

    # Mémoire locale SQLite : injectée dans le cerveau en plus de la mémoire du navigateur
    try:
        local_facts = list_facts(user_id=uid)
    except Exception:
        local_facts = []
    merged_memory = (req.memory or []) + [
        {"t": f["text"], "d": (f.get("created_at") or "")[:10]} for f in local_facts
    ]

    mode_ia_effectif = req.ia_mode or "rapide"
    logger.info(f"[CHAT] Début génération - Mode reçu: '{req.ia_mode}' | Mode appliqué: '{mode_ia_effectif}'")

    try:
        t0 = time.perf_counter()
        # ⚡ Appel direct à ask_sirius (cerveau unique)
        result = await ask_sirius(
            prompt=texte,
            history=history,
            profile=req.profile or {},
            memory=merged_memory,
            mode=req.mode or "normal",
            keys=req.keys or {},
            mood=req.mood or {}
        )
        answer = result.get("reponse", "")
        memories = result.get("memoire", [])
        popups = result.get("popups", [])
        used_search = False  # géré en interne dans ask_sirius

        brain_ms = int((time.perf_counter() - t0) * 1000)
        logger.info(f"[CHAT] Réponse générée en {brain_ms} ms")
    except Exception as e:
        logger.error(f"[CHAT] Erreur lors de ask_sirius: {e}")
        raise HTTPException(status_code=500, detail=f"Erreur cerveau: {e}")

    # Persistance des nouveaux souvenirs dans la base locale (entre les sessions)
    for m in memories:
        try:
            add_fact("souvenir", m, user_id=uid)
        except Exception as e:
            logger.error(f"[LOCAL-MEM] Persistance échouée: {e}")

    new_history = (history + [
        {"role": "user", "content": texte},
        {"role": "assistant", "content": answer},
    ])[-16:]
    await db.sirius_chats.update_one(
        {"session_id": session_id},
        {"$set": {"session_id": session_id, "history": new_history,
                 "updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )

    return {
        "answer": answer,
        "response": answer,
        "text": answer,
        "used_search": used_search,
        "memories": memories,
        "popups": popups,
        "key_source": k3_source(),
        "timings": {"brain_ms": brain_ms}
    }

@api_router.post("/chat/stream")
async def chat_stream(req: ChatRequest, request: Request):
    """Version en flux (SSE) : Sirius répond via ask_sirius."""
    from fastapi.responses import StreamingResponse
    uid = (await require_user(request, db))["user_id"]
    texte = (req.text or "").strip()
    if not texte:
        raise HTTPException(status_code=400, detail="Texte vide")
    if not _rate_ok(uid):
        raise HTTPException(status_code=429, detail="Trop de requêtes, patientez un instant.")
    session_id = f"{uid}:{req.session_id or 'default'}"
    doc = await db.sirius_chats.find_one({"session_id": session_id}, {"_id": 0, "history": 1})
    history = (doc or {}).get("history", [])
    try:
        local_facts = list_facts(user_id=uid)
    except Exception:
        local_facts = []
    
    merged_memory = (req.memory or []) + [
        {"t": f["text"], "d": (f.get("created_at") or "")[:10]} for f in local_facts
    ]

    async def gen():
        t0 = time.perf_counter()
        try:
            result = await ask_sirius(
                prompt=texte,
                history=history,
                profile=req.profile or {},
                memory=merged_memory,
                mode=req.mode or "normal",
                keys=req.keys or {},
                mood=req.mood or {}
            )
            answer = result.get("reponse", "")
            memories = result.get("memoire", [])
            popups = result.get("popups", [])

            brain_ms = int((time.perf_counter() - t0) * 1000)
            
            for m in memories:
                try:
                    add_fact("souvenir", m, user_id=uid)
                except Exception as e:
                    logger.error(f"[LOCAL-MEM] Persistance échouée: {e}")

            new_history = (history + [
                {"role": "user", "content": texte},
                {"role": "assistant", "content": answer},
            ])[-16:]
            
            await db.sirius_chats.update_one(
                {"session_id": session_id},
                {"$set": {"session_id": session_id, "history": new_history,
                         "updated_at": datetime.now(timezone.utc).isoformat()}},
                upsert=True,
            )

            ev = {
                "type": "done",
                "answer": answer,
                "response": answer,
                "text": answer,
                "memories": memories,
                "popups": popups,
                "timings": {"brain_ms": brain_ms},
                "key_source": k3_source()
            }
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except Exception as e:
            logger.error(f"[CHAT FLUX] Erreur: {e}")
            yield "data: " + json.dumps({"type": "done", "answer": f"Erreur cerveau : {e}",
                                        "used_search": False, "memories": [], "popups": []}, ensure_ascii=False) + "\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                           headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

# =========================================================
# MODULE D'AUTO-PATCHING SÉCURISÉ (Permet à Sirius de se corriger)
# =========================================================

@api_router.post("/admin/patch_code")
async def patch_code(request: Request):
    data = await request.json()
    file_path = data.get("file_path") # Ex: "server.py"
    new_content = data.get("content")
    
    # Sécurité : On ne touche qu'aux fichiers autorisés
    if file_path not in ["server.py", "sirius_brain.py"]:
        raise HTTPException(status_code=403, detail="Fichier non autorisé à la modification.")
    
    # Sauvegarde automatique avant d'écraser
    backup_path = f"{file_path}.bak"
    if os.path.exists(file_path):
        os.replace(file_path, backup_path)
        
    try:
        # Écriture du nouveau contenu
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
            
        # Test de syntaxe Python à la volée (py_compile)
        syntax_check = subprocess.run([sys.executable, "-m", "py_compile", file_path], capture_output=True, text=True)
        if syntax_check.returncode != 0:
            # Erreur de syntaxe détectée : on restaure instantanément le backup !
            os.replace(backup_path, file_path)
            raise HTTPException(status_code=400, detail=f"Erreur de syntaxe, patch annulé : {syntax_check.stderr}")
            
        return {"status": "success", "message": f"{file_path} mis à jour et validé ! Uvicorn va recharger."}
        
    except Exception as e:
        # En cas de crash inattendu, on remet l'original
        if os.path.exists(backup_path):
            os.replace(backup_path, file_path)
        raise HTTPException(status_code=500, detail=f"Échec du patch : {str(e)}")

# NOTE : ne PAS inclure api_router ici. À ce stade du fichier, la plupart des sous-routeurs
# (haccp, modules, payments, google_calendar, auth, microsoft, nummarius, themis, home_assistant...)
# ne sont pas encore attachés à api_router (voir plus bas). Un include_router() prématuré ne
# capture qu'un instantané des routes déjà définies : les routes ajoutées ensuite à api_router
# ne seraient jamais exposées par cet appel, et seraient dupliquées lors du rattachement final
# (cf. "Rattachement final du routeur /api à l'application", une seule fois, après les middlewares).

# ---- Validation des clés API avant sauvegarde (ergonomie : gestion des erreurs) ----
class KeyValidateIn(BaseModel):
    service: str
    key: str


def _env_key(*names: str) -> str:
    for name in names:
        value = os.environ.get(name)
        if value and str(value).strip():
            return str(value).strip()
    return ""


class KeysCheckRequest(BaseModel):
    keys: dict[str, str] = Field(default_factory=dict)


_KEY_CHECK_SPECS = {
    "groq": {
        "label": "Cerveau SIRIUS",
        "env": ("GROQ_API_KEY", "GROQ_KEY", "K3_API_KEY", "DANIEL_DEV_K3"),
    },
    "serp": {
        "label": "SerpAPI",
        "env": ("SERP_API_KEY",),
    },
    "fal": {
        "label": "fal.ai",
        "env": ("FAL_KEY", "FAL_API_KEY"),
    },
    "gmaps": {
        "label": "Google Maps",
        "env": ("GOOGLE_MAPS_API_KEY", "MAPS_PLATFORM_API_KEY", "MAPS_PLATFORM_API_Key"),
    },
    "alphavantage": {
        "label": "Alpha Vantage",
        "env": ("ALPHA_VANTAGE_API_KEY", "ALPHA_VANTAGE_KEY"),
    },
}


def _keys_check_response(keys: dict[str, str]) -> dict:
    statuses = {}
    checks = []

    for service, spec in _KEY_CHECK_SPECS.items():
        browser_key = (keys.get(service) or "").strip()
        server_key = _env_key(*spec["env"])
        if browser_key or server_key:
            state = "ok"
            source = "navigateur" if browser_key else "serveur"
        elif service == "groq":
            # parse_intent remains usable without a provider key through its local fallback.
            state = "ok"
            source = "fallback_local"
        else:
            state = "absente"
            source = "aucune"

        statuses[service] = state
        checks.append(
            {
                "id": service,
                "label": spec["label"],
                "status": state,
                "source": source,
            }
        )

    return {
        "ok": True,
        "statuses": statuses,
        "checks": checks,
        "invalid": [],
        "speech": "",
    }


@api_router.get("/keys/check")
async def keys_check_get():
    return {
        "ok": True,
        "services": {
            "google_tts": bool(_env_key("GOOGLE_TTS_API_KEY", "GOOGLE_CLOUD_TTS_API_KEY")),
            "google_maps": bool(_env_key("GOOGLE_MAPS_API_KEY", "MAPS_PLATFORM_API_KEY", "MAPS_PLATFORM_API_Key")),
            "openweather": bool(_env_key("OPENWEATHER_API_KEY", "OWM_API_KEY")),
            "newsapi": bool(_env_key("NEWS_API_KEY", "NEWSAPI_KEY")),
            "alphavantage": bool(_env_key("ALPHA_VANTAGE_API_KEY", "ALPHA_VANTAGE_KEY")),
            "serpapi": bool(_env_key("SERP_API_KEY")),
            "emergent": bool(_env_key("EMERGENT_LLM_KEY", "EMERGENT_API_KEY")),
        },
    }


@api_router.post("/keys/check")
async def keys_check_post(request: KeysCheckRequest):
    """Checks browser and server key availability without returning secret values."""
    return _keys_check_response(request.keys)


# =========================================================
# ROUTE DE LECTURE AUTONOME POUR SIRIUS
# =========================================================


@api_router.get("/admin/read_file")
async def read_file(file_path: str):
    # Sécurité basique : on s'assure qu'on ne lit que des fichiers autorisés du projet
    if file_path not in ["server.py", "sirius_brain.py"]:
        raise HTTPException(status_code=403, detail="Fichier non autorisé à la lecture.")
        
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Fichier introuvable")
        
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        return {"status": "success", "file_path": file_path, "content": content}
    except Exception as e:
  
       raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/keys/validate")
async def keys_validate(body: KeyValidateIn):
    s = (body.service or "").strip().lower()
    k = (body.key or "").strip()
    if not k:
        return {"ok": False, "message": "Clé vide."}
    try:
        async with httpx.AsyncClient(timeout=12) as cx:
            if s in ("k3", "kimi", "groq"):
                from sirius_brain import K3_ENDPOINT
                r = await cx.get(f"{K3_ENDPOINT}/models", headers={"Authorization": f"Bearer {k}"})
                return {"ok": r.status_code == 200,
                        "message": "Clé Kimi K3 valide." if r.status_code == 200 else f"Clé refusée par Moonshot ({r.status_code})."}
            if s in ("serp", "serpapi"):
                r = await cx.get("https://serpapi.com/account.json", params={"api_key": k})
                return {"ok": r.status_code == 200,
                        "message": "Clé SerpAPI valide." if r.status_code == 200 else "Clé SerpAPI refusée."}
            if s in ("gmaps", "google-maps", "google_maps", "maps"):
                r = await cx.get("https://maps.googleapis.com/maps/api/geocode/json", params={"address": "Paris", "key": k})
                st = (r.json() or {}).get("status", "")
                ok = st in ("OK", "ZERO_RESULTS")
                return {"ok": ok, "message": "Clé Google Maps valide." if ok else f"Clé Google Maps refusée ({st})."}
            if s in ("google-tts", "google_tts", "tts", "gtts"):
                ok = len(k) >= 20
                return {"ok": ok, "message": "Clé Google TTS valide." if ok else "Clé Google TTS absente ou invalide."}
            if s in ("openweather", "weather", "owm"):
                r = await cx.get("https://api.openweathermap.org/data/2.5/weather", params={"q": "Paris", "appid": k})
                payload = r.json() if r.status_code == 200 else {}
                ok = r.status_code == 200 and payload.get("name") is not None
                return {"ok": ok, "message": "Clé OpenWeather valide." if ok else "Clé OpenWeather refusée."}
            if s in ("newsapi", "news", "news-api"):
                r = await cx.get("https://newsapi.org/v2/top-headlines", params={"country": "fr", "pageSize": 1, "apiKey": k})
                payload = r.json() if r.status_code == 200 else {}
                ok = r.status_code == 200 and payload.get("status") == "ok"
                return {"ok": ok, "message": "Clé NewsAPI valide." if ok else "Clé NewsAPI refusée."}
            if s in ("alphavantage", "alpha-vantage", "alpha"):
                r = await cx.get("https://www.alphavantage.co/query", params={"function": "GLOBAL_QUOTE", "symbol": "IBM", "apikey": k})
                d = r.json() if r.status_code == 200 else {}
                if "Error Message" in d or "Invalid" in str(d.get("Information", "")):
                    return {"ok": False, "message": "Clé Alpha Vantage refusée."}
                return {"ok": True, "message": "Clé Alpha Vantage valide." + (" (quota du jour peut-être atteint)" if "Information" in d or "Note" in d else "")}
            if s == "fal":
                ok = ":" in k and len(k) >= 15
                return {"ok": ok, "message": "Format de clé fal.ai valide." if ok else "Format attendu : key_id:key_secret."}
    except Exception as e:
        return {"ok": False, "message": f"Vérification impossible : {e}"}
    return {"ok": False, "message": "Service inconnu."}


class DiagramRequest(BaseModel):
    description: str
    keys: dict = {}

@api_router.post("/diagram")
async def diagram(req: DiagramRequest, request: Request):
    """Architecte visuel : description en langage naturel -> structure de diagramme (nœuds + liens)."""
    desc = (req.description or "").strip()
    if not desc:
        raise HTTPException(status_code=400, detail="Description vide")
    if not _rate_ok(request.client.host if request.client else "?", limit=12):
        raise HTTPException(status_code=429, detail="Trop de requêtes, patientez un instant.")
    try:
        return await generate_diagram(desc, keys=req.keys or {})
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[DIAGRAM] Erreur: {e}")
        raise HTTPException(status_code=500, detail="Sirius n'a pas pu dessiner ce diagramme, réessayez.")

# ---- Médiathèque : fichiers & médias (Emergent Object Storage / disque local) ----
from fastapi.responses import Response as RawResponse

MAX_FILE_MB = 20

DOC_EXTS = {"pdf", "doc", "docx", "txt", "md", "csv", "xls", "xlsx", "ppt", "pptx", "json", "rtf", "odt", "log"}

def dossier_for(content_type: str, ext: str) -> str:
    ct = (content_type or "").lower()
    if ct.startswith("image/"):
        return "Photos"
    if ct.startswith("audio/"):
        return "Sons"
    if ct.startswith("video/"):
        return "Vidéos"
    if ct == "application/pdf" or ct.startswith("text/") or ext in DOC_EXTS:
        return "Documents"
    return "Autres"

def _file_scope(uid):
    """Isolation par utilisateur (les anciens fichiers sans user_id restent visibles)."""
    return {"$or": [{"user_id": uid}, {"user_id": {"$exists": False}}]}


@api_router.post("/files/upload")
async def upload_file(request: Request, file: UploadFile = File(...)):
    uid = (await require_user(request, db))["user_id"]
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Fichier vide")
    if len(data) > MAX_FILE_MB * 1048576:
        raise HTTPException(status_code=413, detail=f"Fichier trop volumineux (max {MAX_FILE_MB} Mo)")
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else "bin"
    if not re.fullmatch(r"[a-z0-9]{1,8}", ext):
        ext = "bin"  # neutralise toute tentative de traversée de chemin via le nom de fichier
    path = f"{APP_NAME}/uploads/{uuid.uuid4()}.{ext}"
    content_type = file.content_type or "application/octet-stream"
    try:
        result = put_object(path, data, content_type)
    except Exception as e:
        logger.error(f"[FILES] Upload échoué: {e}")
        raise HTTPException(status_code=502, detail="Le stockage n'a pas accepté le fichier, réessayez.")
    record = {
        "id": str(uuid.uuid4()),
        "storage_path": result["path"],
        "original_filename": file.filename or f"fichier.{ext}",
        "content_type": content_type,
        "size": result.get("size", len(data)),
        "dossier": dossier_for(content_type, ext),
        "user_id": uid,
        "is_deleted": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.files.insert_one(dict(record))
    return record

@api_router.get("/files")
async def list_files(request: Request):
    uid = (await require_user(request, db))["user_id"]
    docs = await db.files.find({"is_deleted": False, **_file_scope(uid)}, {"_id": 0}).sort("created_at", -1).to_list(200)
    for d in docs:
        if not d.get("dossier"):
            ext = d.get("original_filename", "").rsplit(".", 1)[-1].lower()
            d["dossier"] = dossier_for(d.get("content_type", ""), ext)
    return docs

class FileAnalyzeIn(BaseModel):
    keys: dict = {}

@api_router.post("/files/{file_id}/analyze")
async def analyze_file(file_id: str, req: FileAnalyzeIn, request: Request):
    uid = (await require_user(request, db))["user_id"]
    record = await db.files.find_one({"id": file_id, "is_deleted": False, **_file_scope(uid)}, {"_id": 0})
    if not record:
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    try:
        data, _ = get_object(record["storage_path"])
    except Exception:
        raise HTTPException(status_code=502, detail="Fichier illisible depuis le stockage")
    ct = (record.get("content_type") or "").lower()
    try:
        if ct.startswith("image/"):
            import base64 as b64mod
            payload = b64mod.b64encode(data).decode()
            analyse = await analyze_upload("image", payload, keys=req.keys or {})
        elif ct == "application/pdf":
            from pypdf import PdfReader
            from io import BytesIO
            texte = "\n".join((p.extract_text() or "") for p in PdfReader(BytesIO(data)).pages[:15])
            if not texte.strip():
                raise HTTPException(status_code=422, detail="PDF sans texte extractible (scan image).")
            analyse = await analyze_upload("document", texte, keys=req.keys or {})
        elif ct.startswith("text/") or ct in ("application/json",):
            analyse = await analyze_upload("document", data[:60000].decode("utf-8", errors="replace"), keys=req.keys or {})
        else:
            raise HTTPException(status_code=422, detail="Type non analysable (images, PDF et textes uniquement).")
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[FILES] Analyse IA échouée: {e}")
        raise HTTPException(status_code=502, detail="L'analyse IA a échoué, réessayez.")
    analyse["at"] = datetime.now(timezone.utc).isoformat()
    await db.files.update_one({"id": file_id}, {"$set": {"analyse": analyse}})
    return {"ok": True, "analyse": analyse}

from fastapi import Form

@api_router.post("/display/analyze")
async def display_analyze(file: UploadFile = File(...), keys: str = Form("{}")):
    """Analyse IA d'un fichier déposé dans le SIRIUS DISPLAY (non stocké) + phrase à prononcer."""
    try:
        keys_d = json.loads(keys or "{}")
    except Exception:
        keys_d = {}
    data = await file.read()
    if len(data) > 12 * 1048576:
        raise HTTPException(status_code=413, detail="Fichier trop volumineux pour l'analyse (12 Mo max).")
    ct = (file.content_type or "").lower()
    try:
        if ct.startswith("image/"):
            import base64 as b64mod
            analyse = await analyze_upload("image", b64mod.b64encode(data).decode(), keys=keys_d)
        elif ct == "application/pdf":
            from pypdf import PdfReader
            from io import BytesIO
            texte = "\n".join((p.extract_text() or "") for p in PdfReader(BytesIO(data)).pages[:15])
            if not texte.strip():
                raise HTTPException(status_code=422, detail="PDF sans texte extractible (scan image).")
            analyse = await analyze_upload("document", texte, keys=keys_d)
        elif ct.startswith("text/") or ct == "application/json":
            analyse = await analyze_upload("document", data[:60000].decode("utf-8", errors="replace"), keys=keys_d)
        else:
            raise HTTPException(status_code=422, detail="Type non analysable (images, PDF et textes uniquement).")
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[DISPLAY] Analyse IA échouée: {e}")
        raise HTTPException(status_code=502, detail="L'analyse IA a échoué, réessayez.")
    speech = (analyse.get("description") or "").strip()
    if len(speech) > 700:
        speech = speech[:700].rsplit(".", 1)[0] + "."
    return {"ok": True, "analyse": analyse, "speech": speech}


class DisplayAskIn(BaseModel):
    question: str
    context: dict = {}
    keys: dict = {}
    history: list = []


@api_router.post("/display/ask")
async def display_ask_endpoint(req: DisplayAskIn):
    """Question vocale contextuelle sur le fichier actuellement affiché dans le SIRIUS DISPLAY."""
    q = (req.question or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="Question vide.")
    try:
        answer = await display_ask(q, req.context or {}, keys=req.keys or {}, history=req.history or [])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[DISPLAY] Question sur fichier échouée: {e}")
        raise HTTPException(status_code=502, detail="L'interrogation du fichier a échoué, réessayez.")
    return {"ok": True, "answer": answer}

class FileDossierIn(BaseModel):
    dossier: str

class VisionAnalyzeIn(BaseModel):
    image: str
    question: str = ""
    keys: dict = {}


@api_router.post("/vision/analyze")
async def vision_analyze(req: VisionAnalyzeIn, request: Request):
    """SIRIUS Voyant : capture caméra → description IA + OCR + synthèse vocale courte."""
    await require_user(request, db)
    b64 = req.image.split(",", 1)[1] if req.image.startswith("data:") else req.image
    if not b64:
        raise HTTPException(status_code=400, detail="Image manquante.")
    try:
        import base64 as _b64
        _b64.b64decode(b64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Image invalide : encodage base64 incorrect, monsieur.")
    try:
        return await vision_look(b64, (req.question or "").strip(), req.keys)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.warning(f"[VISION] {repr(e)}")
        raise HTTPException(status_code=502, detail="Le module de vision est indisponible pour le moment, monsieur.")


class WebAgentIn(BaseModel):
    query: str = ""
    url: str = ""
    selector: str = ""
    text: str = ""


def _url_publique(u: str) -> bool:
    """Anti-SSRF : uniquement http(s) vers des adresses publiques."""
    from urllib.parse import urlparse
    import socket, ipaddress
    try:
        p = urlparse(u)
        if p.scheme not in ("http", "https") or not p.hostname:
            return False
        for info in socket.getaddrinfo(p.hostname, None):
            ip = ipaddress.ip_address(info[4][0])
            if not ip.is_global:
                return False
        return True
    except Exception:
        return False


@api_router.post("/webagent/run")
async def webagent_run(req: WebAgentIn, request: Request):
    """SIRIUS Web Agent : navigateur invisible → recherche/action web + capture sauvegardée en Médiathèque."""
    uid = (await require_user(request, db))["user_id"]
    q = (req.query or "").strip()
    target = (req.url or "").strip()
    if not q and not target:
        raise HTTPException(status_code=400, detail="Requête ou URL manquante, monsieur.")
    if target and not _url_publique(target):
        raise HTTPException(status_code=400, detail="URL non autorisée, monsieur.")
    from webagent import executer_tache_web
    result = await executer_tache_web(query=q, url=target, selector=req.selector, text=req.text)
    if not result.get("succes"):
        raise HTTPException(status_code=502, detail=result.get("message", "L'agent web a échoué, monsieur."))
    shot = result.pop("image")
    import base64 as _b64
    record = None
    try:
        slug = re.sub(r"[^a-z0-9]+", "-", (q or result.get("titre", "web")).lower())[:40].strip("-") or "web"
        path = f"{APP_NAME}/uploads/{uuid.uuid4()}.jpg"
        stored = put_object(path, shot, "image/jpeg")
        record = {
            "id": str(uuid.uuid4()),
            "storage_path": stored["path"],
            "original_filename": f"web-{slug}.jpg",
            "content_type": "image/jpeg",
            "size": stored.get("size", len(shot)),
            "dossier": "Photos",
            "user_id": uid,
            "is_deleted": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.files.insert_one(dict(record))
        record.pop("_id", None)
    except Exception as e:
        logger.warning(f"[WEBAGENT] Sauvegarde Médiathèque échouée: {e}")
    return {
        "succes": True,
        "titre": result.get("titre", ""),
        "moteur": result.get("moteur", ""),
        "extraits": result.get("extraits", []),
        "url": result.get("url", ""),
        "file": record,
        "image_b64": _b64.b64encode(shot).decode(),
    }


@api_router.patch("/files/{file_id}/dossier")
async def move_file(file_id: str, req: FileDossierIn, request: Request):
    uid = (await require_user(request, db))["user_id"]
    d = req.dossier.strip()[:40]
    if not d:
        raise HTTPException(status_code=400, detail="Nom de dossier vide")
    res = await db.files.update_one({"id": file_id, "is_deleted": False, **_file_scope(uid)}, {"$set": {"dossier": d}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    return {"ok": True, "dossier": d}

# ---- Visionneuse / éditeur : lecture et réécriture du contenu texte ----
TEXT_EXTS = {"txt", "json", "js", "jsx", "py", "html", "css", "md", "log", "xml", "yaml", "yml", "csv", "ts", "tsx", "sh", "ini", "conf", "env", "lien"}

def is_text_file(record) -> bool:
    ct = (record.get("content_type") or "").lower()
    ext = record.get("original_filename", "").rsplit(".", 1)[-1].lower()
    return ct.startswith("text/") or ct in ("application/json", "application/xml", "application/javascript", "application/x-yaml") or ext in TEXT_EXTS

@api_router.get("/files/{file_id}/content")
async def file_content(file_id: str, request: Request):
    uid = (await require_user(request, db))["user_id"]
    record = await db.files.find_one({"id": file_id, "is_deleted": False, **_file_scope(uid)}, {"_id": 0})
    if not record:
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    if not is_text_file(record):
        raise HTTPException(status_code=422, detail="Ce fichier n'est pas un fichier texte éditable.")
    try:
        data, _ = get_object(record["storage_path"])
    except Exception:
        raise HTTPException(status_code=502, detail="Fichier illisible depuis le stockage")
    if len(data) > 2 * 1048576:
        raise HTTPException(status_code=413, detail="Fichier texte trop volumineux pour l'éditeur (max 2 Mo).")
    return {"id": file_id, "filename": record["original_filename"], "content": data.decode("utf-8", errors="replace")}

class FileUpdateIn(BaseModel):
    content: str

@api_router.post("/files/{file_id}/update")
async def file_update(file_id: str, req: FileUpdateIn, request: Request):
    uid = (await require_user(request, db))["user_id"]
    record = await db.files.find_one({"id": file_id, "is_deleted": False, **_file_scope(uid)}, {"_id": 0})
    if not record:
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    if not is_text_file(record):
        raise HTTPException(status_code=422, detail="Seuls les fichiers texte peuvent être modifiés.")
    data = req.content.encode("utf-8")
    if len(data) > MAX_FILE_MB * 1048576:
        raise HTTPException(status_code=413, detail=f"Contenu trop volumineux (max {MAX_FILE_MB} Mo)")
    try:
        put_object(record["storage_path"], data, record.get("content_type") or "text/plain")
    except Exception:
        try:
            import asyncio as _aio
            await _aio.sleep(0.8)
            put_object(record["storage_path"], data, record.get("content_type") or "text/plain")
        except Exception as e:
            logger.error(f"[FILES] Réécriture échouée: {e}")
            raise HTTPException(status_code=502, detail="Le stockage n'a pas accepté la modification, réessayez.")
    now = datetime.now(timezone.utc).isoformat()
    await db.files.update_one({"id": file_id}, {"$set": {"size": len(data), "updated_at": now}})
    return {"ok": True, "size": len(data), "updated_at": now}

# Alias générique demandé : /api/upload → même logique que /api/files/upload
@api_router.post("/upload")
async def upload_alias(request: Request, file: UploadFile = File(...)):
    return await upload_file(request, file)

# Types sûrs à afficher dans le navigateur ; tout le reste est forcé en téléchargement
SAFE_INLINE_TYPES = {
    "image/png", "image/jpeg", "image/gif", "image/webp",
    "audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm",
    "video/mp4", "video/webm", "application/pdf",
}

@api_router.get("/files/{file_id}/download")
async def download_file(file_id: str, request: Request, dl: int = 0):
    uid = (await require_user(request, db))["user_id"]
    record = await db.files.find_one({"id": file_id, "is_deleted": False, **_file_scope(uid)}, {"_id": 0})
    if not record:
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    try:
        data, ct = get_object(record["storage_path"])
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Fichier absent du stockage")
    except Exception as e:
        logger.error(f"[FILES] Lecture échouée: {e}")
        raise HTTPException(status_code=502, detail="Stockage momentanément indisponible")
    media_type = (record.get("content_type") or ct or "application/octet-stream").lower()
    if media_type in SAFE_INLINE_TYPES:
        disposition = "attachment" if dl else "inline"
    else:
        # HTML/SVG/inconnus : jamais exécutés dans le navigateur (anti-XSS stocké)
        disposition = "attachment"
        media_type = "application/octet-stream"
    filename = re.sub(r'[\r\n"]', "", record["original_filename"])[:150] or "fichier"
    return RawResponse(
        content=data,
        media_type=media_type,
        headers={
            "Content-Disposition": f'{disposition}; filename="{filename}"',
            "X-Content-Type-Options": "nosniff",
        },
    )

@api_router.delete("/files/{file_id}")
async def delete_file(file_id: str, request: Request):
    uid = (await require_user(request, db))["user_id"]
    res = await db.files.update_one({"id": file_id, "is_deleted": False, **_file_scope(uid)}, {"$set": {"is_deleted": True}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    return {"ok": True}

# ---- Archives SIRIUS : médiathèque automatique des créations ----
import base64 as _b64
import unicodedata as _ud

ARCHIVE_DOSSIERS = {"image": "Images", "video": "Clips", "analyse": "Analyses",
                    "rendu": "Rendus", "demo": "Démonstrations"}
_EXT_BY_MIME = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
                "video/mp4": "mp4", "video/webm": "webm", "text/plain": "txt"}

def _slug(nom: str) -> str:
    s = _ud.normalize("NFKD", nom or "").encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s[:60] or "creation"

def _fold(s: str) -> str:
    return _ud.normalize("NFKD", (s or "").lower()).encode("ascii", "ignore").decode()

class ArchiveRequest(BaseModel):
    kind: str
    nom: str
    data: str = ""
    url: str = ""
    mime: str = ""
    dossier: str = ""

@api_router.post("/archive")
async def archive_creation(req: ArchiveRequest, request: Request):
    uid = (await require_user(request, db))["user_id"]
    nom = (req.nom or "").strip()
    if not nom:
        raise HTTPException(status_code=400, detail="Nom vide")
    dossier = (req.dossier or "").strip() or ARCHIVE_DOSSIERS.get(req.kind, "Rendus")
    mime = (req.mime or "").lower()
    if req.data:
        try:
            data = _b64.b64decode(req.data)
        except Exception:
            raise HTTPException(status_code=400, detail="Données invalides")
        mime = mime or "image/png"
    elif req.url:
        try:
            async with httpx.AsyncClient(timeout=120, follow_redirects=True) as cx:
                r = await cx.get(req.url)
            if r.status_code >= 400:
                raise ValueError()
            data = r.content
            mime = mime or (r.headers.get("content-type") or "video/mp4").split(";")[0]
        except Exception:
            raise HTTPException(status_code=502, detail="Téléchargement de la création impossible")
    else:
        raise HTTPException(status_code=400, detail="Aucun contenu à archiver")
    if len(data) > 150 * 1048576:
        raise HTTPException(status_code=413, detail="Création trop volumineuse (max 150 Mo)")
    ext = _EXT_BY_MIME.get(mime, "bin")
    fichier = f"{_slug(nom)}.{ext}"
    path = f"{APP_NAME}/archives/{_slug(dossier)}/{uuid.uuid4()}.{ext}"
    try:
        result = put_object(path, data, mime)
    except Exception as e:
        logger.error(f"[ARCHIVE] Stockage échoué: {e}")
        raise HTTPException(status_code=502, detail="Le stockage n'a pas accepté l'archive")
    record = {
        "id": str(uuid.uuid4()),
        "storage_path": result["path"],
        "original_filename": fichier,
        "content_type": mime,
        "size": result.get("size", len(data)),
        "user_id": uid,
        "is_deleted": False,
        "is_archive": True,
        "dossier": dossier,
        "nom": nom[:200],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.files.insert_one(dict(record))
    return {"id": record["id"], "dossier": dossier, "fichier": fichier}

_STOPWORDS = {"les", "des", "sur", "une", "aux", "pour", "avec", "dans", "mes", "tes", "ses", "que", "qui"}

@api_router.get("/archive/search")
async def archive_search(request: Request, q: str = "", kind: str = ""):
    uid = (await require_user(request, db))["user_id"]
    query = {"is_deleted": False, "is_archive": True, **_file_scope(uid)}
    kf = _fold(kind)
    if kf in ("video", "clip", "animation"):
        query["content_type"] = {"$regex": "^video/"}
    elif kf in ("image", "photo", "illustration", "dessin", "logo", "affiche"):
        query["content_type"] = {"$regex": "^image/"}
    docs = await db.files.find(query, {"_id": 0}).sort("created_at", -1).to_list(300)
    tokens = [t for t in re.split(r"[^a-z0-9]+", _fold(q)) if len(t) > 2 and t not in _STOPWORDS]

    def _best(items):
        b, bs = None, 0
        for d in items:
            hay = _fold(f"{d.get('nom', '')} {d.get('original_filename', '')} {d.get('dossier', '')}")
            score = sum(1 for t in tokens if t in hay)
            if score > bs:
                b, bs = d, score
        return b

    best = _best(docs)
    if best is None and "content_type" in query:
        docs = await db.files.find({"is_deleted": False, "is_archive": True, **_file_scope(uid)}, {"_id": 0}).sort("created_at", -1).to_list(300)
        best = _best(docs)
    if best is None and docs and not tokens:
        best = docs[0]
    return {"archive": best, "total": len(docs)}

class LinkArchiveRequest(BaseModel):
    nom: str
    url: str
    dossier: str = ""

@api_router.post("/archive/link")
async def archive_link(req: LinkArchiveRequest, request: Request):
    uid = (await require_user(request, db))["user_id"]
    nom = (req.nom or "").strip()
    url = (req.url or "").strip()
    if not nom or not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Nom ou URL invalide")
    dossier = (req.dossier or "").strip() or "Liens"
    record = {
        "id": str(uuid.uuid4()),
        "storage_path": "",
        "original_filename": f"{_slug(nom)}.lien",
        "content_type": "text/x-sirius-link",
        "url": url[:600],
        "size": 0,
        "user_id": uid,
        "is_deleted": False,
        "is_archive": True,
        "dossier": dossier,
        "nom": nom[:200],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.files.insert_one(dict(record))
    return {"id": record["id"], "dossier": dossier, "fichier": record["original_filename"]}

class RenameArchiveRequest(BaseModel):
    nom: str

@api_router.post("/archive/{archive_id}/rename")
async def archive_rename(archive_id: str, req: RenameArchiveRequest, request: Request):
    uid = (await require_user(request, db))["user_id"]
    nom = (req.nom or "").strip()
    if not nom:
        raise HTTPException(status_code=400, detail="Nom vide")
    rec = await db.files.find_one({"id": archive_id, "is_deleted": False, "is_archive": True, **_file_scope(uid)}, {"_id": 0})
    if not rec:
        raise HTTPException(status_code=404, detail="Archive introuvable")
    old = rec.get("original_filename") or ""
    ext = old.rsplit(".", 1)[-1] if "." in old else "bin"
    fichier = f"{_slug(nom)}.{ext}"
    await db.files.update_one({"id": archive_id}, {"$set": {"nom": nom[:200], "original_filename": fichier}})
    return {"id": archive_id, "dossier": rec.get("dossier"), "fichier": fichier}

@api_router.get("/archive/list")
async def archive_list(request: Request):
    uid = (await require_user(request, db))["user_id"]
    docs = await db.files.find({"is_deleted": False, "is_archive": True, **_file_scope(uid)}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return docs

@api_router.post("/chat/reset")
async def reset_chat(req: ResetRequest, request: Request):
    """Efface l'historique de conversation d'une session (commande « oublie tout »)."""
    uid = (await require_user(request, db))["user_id"]
    await db.sirius_chats.delete_one({"session_id": f"{uid}:{req.session_id or 'default'}"})
    return {"ok": True}

# ---- Spotius : lecture seule du morceau en cours (Spotify Web API) ----
import httpx
from fastapi.responses import HTMLResponse, JSONResponse

SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET")
SPOTIFY_REDIRECT_URI = os.environ.get("SPOTIFY_REDIRECT_URI")
SPOTIFY_SCOPE = "user-read-currently-playing user-read-playback-state user-modify-playback-state streaming user-read-email user-read-private"

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
    u = urlparse(SPOTIFY_REDIRECT_URI or "")
    return f"{u.scheme}://{u.netloc}" if u.scheme and u.netloc else ""

def _popup_response(payload: dict) -> HTMLResponse:
    """Page popup qui renvoie le résultat à la fenêtre parente, origine stricte (anti-XSS)."""
    import json as _json
    body = _json.dumps(payload)
    origin = _json.dumps(_app_origin() or "null")
    ok = not payload.get("error")
    msg = "Spotify connecté \u2713" if ok else "Erreur Spotify."
    return HTMLResponse(
        "<html><body style='background:#04111c;color:#22d3ee;font-family:sans-serif;text-align:center;padding-top:60px'>"
        f"<h2>{msg}</h2><p>Vous pouvez fermer cette fen\u00eatre.</p>"
        f"<script>window.opener&&window.opener.postMessage({body},{origin});window.close();</script></body></html>"
    )

@api_router.get("/spotify/login")
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

@api_router.get("/spotify/callback")
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

@api_router.post("/spotify/current")
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

class SpotifyPlayRequest(BaseModel):
    access_token: str = ""
    refresh_token: str = ""
    query: str = ""
    device_id: str = ""

class SpotifyRefreshRequest(BaseModel):
    refresh_token: str = ""

@api_router.post("/spotify/refresh")
async def spotify_refresh_endpoint(req: SpotifyRefreshRequest):
    """Renvoie un access_token frais (utilisé par le lecteur intégré du HUD)."""
    if not req.refresh_token:
        raise HTTPException(status_code=401, detail="Non connecté à Spotify")
    tok = await _spotify_refresh(req.refresh_token)
    if not tok:
        raise HTTPException(status_code=401, detail="Session Spotify expirée, reconnectez-vous")
    return {"access_token": tok}

@api_router.post("/spotify/play")
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

class SpotifySearchRequest(BaseModel):
    access_token: str = ""
    refresh_token: str = ""
    query: str

@api_router.post("/spotify/search")
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

# ---- Mémoire locale SQLite (préférences, projets, souvenirs persistants) ----
class LocalFactCreate(BaseModel):
    category: str = "souvenir"
    text: str

@api_router.get("/local-memory")
async def local_memory_list(request: Request, category: str = ""):
    from auth_api import require_user
    user = await require_user(request, db)
    return {"facts": list_facts(category or None, user_id=user["user_id"])}

@api_router.post("/local-memory")
async def local_memory_add(req: LocalFactCreate, request: Request):
    from auth_api import require_user
    user = await require_user(request, db)
    uid = user["user_id"]
    fact = add_fact(req.category, req.text, user_id=uid)
    if not fact:
        raise HTTPException(status_code=409, detail="Ce fait existe déjà ou est vide")
    return fact

@api_router.delete("/local-memory/{fact_id}")
async def local_memory_delete(fact_id: str, request: Request):
    from auth_api import require_user
    user = await require_user(request, db)
    if not delete_fact(fact_id, user_id=user["user_id"]):
        raise HTTPException(status_code=404, detail="Fait introuvable")
    return {"ok": True}

class LocalFactUpdate(BaseModel):
    text: str

@api_router.put("/local-memory/{fact_id}")
async def local_memory_update(fact_id: str, req: LocalFactUpdate, request: Request):
    from auth_api import require_user
    user = await require_user(request, db)
    if not update_fact(fact_id, req.text, user_id=user["user_id"]):
        raise HTTPException(status_code=404, detail="Fait introuvable ou texte vide")
    return {"ok": True}

# ---- SIRIUS PRIME : moteur de mémoire et d'apprentissage ----
class PrimeLog(BaseModel):
    text: str
    intent: str = ""

@api_router.post("/prime/log")
async def prime_log(req: PrimeLog, request: Request):
    uid = await resolve_user_id(request, db)
    log_event(req.text, req.intent, user_id=uid)
    return {"ok": True}

@api_router.get("/prime/overview")
async def prime_get_overview():
    return prime_overview()

# ---- ZEUS CORTEX : statistiques réelles d'usage ----
@api_router.get("/cortex/stats")
async def cortex_stats():
    import sqlite3 as _sq
    from local_memory import DB_PATH as _LMDB
    t0 = time.perf_counter()
    today = datetime.now(timezone.utc).date().isoformat()
    con = _sq.connect(_LMDB)
    try:
        total_events = con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        today_events = con.execute("SELECT COUNT(*) FROM events WHERE created_at LIKE ?", (today + "%",)).fetchone()[0]
        total_facts = con.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
        intents = dict(con.execute(
            "SELECT COALESCE(NULLIF(intent,''),'libre'), COUNT(*) FROM events GROUP BY 1 ORDER BY 2 DESC LIMIT 8"
        ).fetchall())
    finally:
        con.close()
    db_ms = round((time.perf_counter() - t0) * 1000, 1)
    chats = await db.sirius_chats.count_documents({}) if hasattr(db, "sirius_chats") else 0
    consults = await db.consult_history.count_documents({})
    import psutil as _ps
    cpu = _ps.cpu_percent(interval=None)
    ram = _ps.virtual_memory().percent
    disk = _ps.disk_usage("/").percent
    boot_h = round((time.time() - _ps.boot_time()) / 3600, 1)
    total_intent = sum(intents.values()) or 1
    def pct(keys):
        return round(sum(v for k, v in intents.items() if any(x in k.lower() for x in keys)) / total_intent * 100)
    return {
        "activite_cognitive": min(99, 20 + today_events * 4),
        "charge_memoire": min(99, total_facts * 4 + consults),
        "traitement_ms": db_ms,
        "cpu": cpu, "ram": ram, "disque": disk,
        "uptime_h": boot_h,
        "totaux": {"commandes": total_events, "aujourdhui": today_events,
                   "souvenirs": total_facts, "conversations": chats, "consultations": consults},
        "sous_systemes": {
            "logique": max(8, pct(["calc", "pythagore", "math", "système", "diagnostic"])),
            "langage": max(8, pct(["conversation", "libre", "question"])),
            "vision": max(8, pct(["display", "vision", "photo", "image", "carte"])),
            "intuition": max(8, pct(["suggestion", "briefing", "météo", "musique"])),
        },
        "intents": [{"name": k, "count": v} for k, v in intents.items()],
    }


# ---- ORACLE DIVIN : prédictions ----
ASTRO_EVENTS = [
    {"date": "2026-08-12", "name": "Pluie d'étoiles filantes des Perséides (pic d'activité)"},
    {"date": "2026-08-28", "name": "Éclipse totale de Lune"},
    {"date": "2026-09-22", "name": "Équinoxe d'automne"},
    {"date": "2026-11-14", "name": "Superlune au périgée"},
    {"date": "2026-12-14", "name": "Pluie d'étoiles filantes des Géminides (pic)"},
    {"date": "2027-02-06", "name": "Éclipse annulaire de Soleil"},
    {"date": "2027-03-20", "name": "Équinoxe de printemps"},
]
NEWS_POOL = [
    {"theme": "TECHNOLOGIE", "text": "Accélération de l'IA embarquée sur les assistants personnels", "impact": 84},
    {"theme": "ESPACE", "text": "Fenêtre de lancement lunaire Artemis en préparation", "impact": 61},
    {"theme": "FINANCE", "text": "Décision de taux des banques centrales attendue cette semaine", "impact": 77},
    {"theme": "ÉNERGIE", "text": "Progression des capacités solaires domestiques", "impact": 52},
    {"theme": "CLIMAT", "text": "Épisode météo notable attendu sur l'Atlantique Nord", "impact": 66},
    {"theme": "TECHNOLOGIE", "text": "Nouvelle génération de puces neuromorphiques annoncée", "impact": 58},
    {"theme": "SANTÉ", "text": "Avancées des diagnostics assistés par IA en clinique", "impact": 71},
    {"theme": "ESPACE", "text": "Activité solaire élevée : aurores possibles aux latitudes moyennes", "impact": 63},
]
STOCK_POOL = ["CAC 40", "S&P 500", "NASDAQ", "APPLE", "NVIDIA", "TOTALENERGIES"]
_crypto_cache = {"ts": 0, "data": []}
_stocks_cache = {"ts": 0, "data": []}
AV_SYMBOLS = [("AAPL", "APPLE"), ("MSFT", "MICROSOFT"), ("NVDA", "NVIDIA"), ("TSLA", "TESLA")]

def _moon_phase():
    import math
    ref = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
    days = (datetime.now(timezone.utc) - ref).total_seconds() / 86400
    phase = (days % 29.53058867) / 29.53058867
    names = ["NOUVELLE LUNE", "PREMIER CROISSANT", "PREMIER QUARTIER", "GIBBEUSE CROISSANTE",
             "PLEINE LUNE", "GIBBEUSE DÉCROISSANTE", "DERNIER QUARTIER", "DERNIER CROISSANT"]
    idx = int(phase * 8 + 0.5) % 8
    illum = round((1 - math.cos(2 * math.pi * phase)) / 2 * 100)
    return {"name": names[idx], "illumination": illum}

# ---- PANTHEON SYSTEM : connectivité ----
import psutil

@api_router.get("/pantheon/windows")
async def pantheon_windows():
    procs = []
    for p in psutil.process_iter(["pid", "name", "memory_percent", "status"]):
        try:
            info = p.info
            if not info.get("name"):
                continue
            procs.append({"pid": info["pid"], "name": info["name"][:32],
                          "mem": round(info.get("memory_percent") or 0, 1),
                          "status": (info.get("status") or "?").upper()})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    procs.sort(key=lambda x: -x["mem"])
    return {"processes": procs[:12], "total": len(procs)}

@api_router.delete("/pantheon/process/{pid}")
async def pantheon_kill(pid: int):
    try:
        psutil.Process(pid).terminate()
        log_service("SYSTÈME", f"Processus {pid} terminé", "OK")
        return {"ok": True}
    except Exception as e:
        log_service("SYSTÈME", f"Échec arrêt processus {pid}", "ERREUR")
        raise HTTPException(status_code=400, detail=f"Impossible de terminer ce processus : {e}")

@api_router.get("/pantheon/connectivity")
async def pantheon_connectivity():
    services = [{"name": "NOYAU SIRIUS", "status": "CONNECTÉ", "latency": 1, "real": True}]
    checks = [
        ("MÉTÉO", "https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&current=temperature_2m"),
        ("MARCHÉS", "https://api.kraken.com/0/public/Time"),
    ]
    async with httpx.AsyncClient(timeout=6) as cx:
        for name, url in checks:
            t0 = time.perf_counter()
            try:
                r = await cx.get(url)
                ok = r.status_code == 200
            except Exception:
                ok = False
            services.append({"name": name, "status": "CONNECTÉ" if ok else "DÉCONNECTÉ",
                             "latency": int((time.perf_counter() - t0) * 1000) if ok else None, "real": True})
    services.append({"name": "ACTUALITÉS", "status": "CONNECTÉ", "latency": 12, "real": False})
    gcal_doc = await db.google_calendar.find_one({"_id": "default"})
    services.append({"name": "GOOGLE CALENDAR", "status": "CONNECTÉ" if gcal_doc else "DÉCONNECTÉ",
                     "latency": 20 if gcal_doc else None, "real": bool(gcal_doc)})
    for name in ["EMAIL", "WHATSAPP"]:
        services.append({"name": name, "status": "DÉCONNECTÉ", "latency": None, "real": False})
    log_service("CONNECTIVITÉ", "Vérification globale des services", "OK")
    return {"services": services}

class OcrRequest(BaseModel):
    image: str
    keys: dict = {}

class WhatsAppNotifyIn(BaseModel):
    phone: str
    apikey: str
    text: str

async def _send_callmebot(phone: str, apikey: str, text: str) -> str:
    """Envoi WhatsApp personnel via CallMeBot (texte uniquement, numéro propre)."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(12.0, connect=6.0), follow_redirects=True) as cx:
        r = await cx.get("https://api.callmebot.com/whatsapp.php",
                         params={"phone": phone, "apikey": apikey, "text": text[:1000]})
    if r.status_code < 200 or r.status_code >= 300:
        raise HTTPException(status_code=422, detail=f"CallMeBot a refusé la requête ({r.status_code}).")
    body_txt = (r.text or "")[:300]
    if "error" in body_txt.lower():
        raise HTTPException(status_code=422, detail="CallMeBot : clé API ou numéro invalide. Vérifiez l'activation (message « I allow callmebot to send me messages » au bot).")
    return body_txt

@api_router.post("/notify/whatsapp")
async def notify_whatsapp(body: WhatsAppNotifyIn):
    phone = body.phone.strip()
    if not phone or not body.apikey.strip() or not body.text.strip():
        raise HTTPException(status_code=400, detail="Numéro, clé CallMeBot et message requis.")
    try:
        provider = await _send_callmebot(phone, body.apikey.strip(), body.text.strip())
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="CallMeBot ne répond pas (timeout).")
    except Exception:
        raise HTTPException(status_code=502, detail="CallMeBot inaccessible.")
    log_service("WHATSAPP", "Notification envoyée via CallMeBot", "OK")
    return {"ok": True, "provider": provider}

@api_router.post("/pantheon/ocr")
async def pantheon_ocr(req: OcrRequest, request: Request):
    if not req.image:
        raise HTTPException(status_code=400, detail="Image manquante")
    if not _rate_ok(request.client.host if request.client else "?", limit=6):
        raise HTTPException(status_code=429, detail="Trop de requêtes, patientez.")
    try:
        result = await ocr_screen(req.image, keys=req.keys or {})
        log_service("OCR", "Analyse de capture d'écran", "OK")
        return {"result": result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[OCR] {e}")
        log_service("OCR", "Analyse de capture d'écran", "ERREUR")
        if "invalid_api_key" in str(e).lower() or "401" in str(e):
            raise HTTPException(status_code=400, detail="Clé Kimi K3 invalide — vérifiez vos réglages.")
        raise HTTPException(status_code=500, detail="Analyse impossible, réessayez.")

@api_router.get("/pantheon/history")
async def pantheon_history():
    return {"log": list_service_log(25)}

@api_router.get("/oracle/overview")
async def oracle_overview(request: Request, lat: float = 48.85, lon: float = 2.35, av_key: str = "",
                          wa_phone: str = "", wa_key: str = "", light: int = 0):
    import random as _rd
    today = datetime.now(timezone.utc).date()
    seed = int(today.strftime("%Y%m%d"))
    rd = _rd.Random(seed)

    if light:
        # Sonde de vivacité (diagnostic Héphaïstos) : pas d'appels externes ni de LLM
        return {"weather": [], "crypto": [], "stocks": [], "stocks_live": [], "news": [],
                "personal": [], "moon": None, "astro": [],
                "briefing": "Oracle opérationnel (mode diagnostic léger).",
                "date": today.isoformat(), "light": True}

    weather, crypto = [], []
    async with httpx.AsyncClient(timeout=12) as cx:
        try:
            r = await cx.get(
                "https://api.open-meteo.com/v1/forecast",
                params={"latitude": lat, "longitude": lon, "timezone": "auto",
                        "daily": "weather_code,temperature_2m_max,temperature_2m_min"})
            d = r.json().get("daily", {})
            for i, day in enumerate(d.get("time", [])[:7]):
                weather.append({"date": day, "code": d["weather_code"][i],
                                "tmax": round(d["temperature_2m_max"][i]),
                                "tmin": round(d["temperature_2m_min"][i])})
        except Exception as e:
            logger.error(f"[ORACLE] météo: {e}")
        if time.time() - _crypto_cache["ts"] < 300 and _crypto_cache["data"]:
            crypto = list(_crypto_cache["data"])
        else:
          try:
            r = await cx.get(
                "https://api.coingecko.com/api/v3/coins/markets",
                params={"vs_currency": "eur", "ids": "bitcoin,ethereum,solana,dogecoin",
                        "price_change_percentage": "24h"})
            payload = r.json()
            if isinstance(payload, list):
                for c in payload:
                    ch = c.get("price_change_percentage_24h") or 0
                    crypto.append({"name": c["symbol"].upper(), "price": round(c["current_price"], 2),
                                   "change": round(ch, 2),
                                   "signal": "HAUSSIER" if ch >= 0 else "BAISSIER",
                                   "volatile": abs(ch) > 6})
            if not crypto:
                r2 = await cx.get(
                    "https://api.coingecko.com/api/v3/simple/price",
                    params={"ids": "bitcoin,ethereum,solana,dogecoin", "vs_currencies": "eur",
                            "include_24hr_change": "true"})
                p2 = r2.json()
                names = {"bitcoin": "BTC", "ethereum": "ETH", "solana": "SOL", "dogecoin": "DOGE"}
                if isinstance(p2, dict):
                    for cid, sym in names.items():
                        v = p2.get(cid)
                        if isinstance(v, dict) and "eur" in v:
                            ch = v.get("eur_24h_change") or 0
                            crypto.append({"name": sym, "price": round(v["eur"], 2),
                                           "change": round(ch, 2),
                                           "signal": "HAUSSIER" if ch >= 0 else "BAISSIER",
                                           "volatile": abs(ch) > 6})
            if not crypto:
                r3 = await cx.get(
                    "https://api.kraken.com/0/public/Ticker",
                    params={"pair": "XBTEUR,ETHEUR,SOLEUR,XDGEUR"})
                p3 = r3.json().get("result", {})
                kmap = {"XXBTZEUR": "BTC", "XETHZEUR": "ETH", "SOLEUR": "SOL", "XDGEUR": "DOGE"}
                for kp, sym in kmap.items():
                    tk = p3.get(kp)
                    if not tk:
                        continue
                    last = float(tk["c"][0])
                    op = float(tk["o"])
                    ch = (last - op) / op * 100 if op else 0
                    crypto.append({"name": sym, "price": round(last, 2),
                                   "change": round(ch, 2),
                                   "signal": "HAUSSIER" if ch >= 0 else "BAISSIER",
                                   "volatile": abs(ch) > 6})
            if crypto:
                _crypto_cache["ts"] = time.time()
                _crypto_cache["data"] = list(crypto)
          except Exception as e:
            logger.error(f"[ORACLE] crypto: {e}")

    stocks, stocks_live = [], False
    key_av = (av_key or "").strip() or os.environ.get("ALPHA_VANTAGE_API_KEY", "")
    if key_av:
        if time.time() - _stocks_cache["ts"] < 14400 and _stocks_cache["data"]:
            stocks, stocks_live = list(_stocks_cache["data"]), True
        else:
            try:
                async with httpx.AsyncClient(timeout=25) as cx2:
                    for sym, label in AV_SYMBOLS:
                        r = await cx2.get("https://www.alphavantage.co/query",
                                          params={"function": "GLOBAL_QUOTE", "symbol": sym, "apikey": key_av})
                        q = (r.json() or {}).get("Global Quote") or {}
                        price = q.get("05. price")
                        if not price:
                            continue
                        ch = round(float((q.get("10. change percent") or "0").replace("%", "") or 0), 2)
                        stocks.append({"name": label, "price": round(float(price), 2), "currency": "$",
                                       "change": ch, "signal": "HAUSSIER" if ch >= 0 else "BAISSIER",
                                       "volatile": abs(ch) > 1.8})
                if stocks:
                    stocks_live = True
                    _stocks_cache["ts"] = time.time()
                    _stocks_cache["data"] = list(stocks)
                    # Alerte Alpha Vantage sur WhatsApp (CallMeBot) : uniquement sur données fraîches
                    movers = [s for s in stocks if abs(s["change"]) >= 2.0]
                    if movers and wa_phone.strip() and wa_key.strip():
                        lines = [f"{s['name']} {'+' if s['change'] >= 0 else ''}{s['change']}% ({s['price']} $)" for s in movers]
                        msg = "⚠️ SIRIUS — Alerte Alpha Vantage :\n" + "\n".join(lines)
                        try:
                            await _send_callmebot(wa_phone.strip(), wa_key.strip(), msg)
                            log_service("WHATSAPP", f"Alerte Alpha Vantage envoyée ({len(movers)} titre(s))", "OK")
                        except Exception as e:
                            logger.error(f"[ORACLE] alerte WhatsApp: {e}")
            except Exception as e:
                logger.error(f"[ORACLE] alpha vantage: {e}")
                stocks = []
    if not stocks:
        stocks = [{"name": s, "change": round(rd.uniform(-2.6, 2.6), 2)} for s in rd.sample(STOCK_POOL, 4)]
        for s in stocks:
            s["signal"] = "HAUSSIER" if s["change"] >= 0 else "BAISSIER"
            s["volatile"] = abs(s["change"]) > 1.8

    news = rd.sample(NEWS_POOL, 4)

    prime = prime_overview()
    hours = prime["habits"]["hours"]
    weekdays = prime["habits"]["weekdays"]
    days_fr = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
    peak_hour = hours.index(max(hours)) if max(hours) > 0 else None
    peak_day = days_fr[weekdays.index(max(weekdays))] if max(weekdays) > 0 else None
    avg = (sum(hours) / max(1, prime["totals"]["days"]))
    charge = "ÉLEVÉE" if avg > 12 else "MODÉRÉE" if avg > 4 else "LÉGÈRE"
    personal = {
        "peak_hour": peak_hour, "peak_day": peak_day, "charge": charge,
        "confidence": prime["confidence"],
        "suggestion": prime["suggestions"][0] if prime["suggestions"] else "",
    }

    moon = _moon_phase()
    upcoming = [e for e in ASTRO_EVENTS if e["date"] >= today.isoformat()][:4]

    # Microsoft 365 : agenda du jour + mails non lus (si le compte est connecté)
    ms_events, ms_unread = [], 0
    try:
        from microsoft_graph import ms_today_events, ms_recent_mail
        from auth_api import resolve_user_id as _ruid
        _uid = await _ruid(request, db)
        if _uid and _uid != "legacy" and await db.microsoft_oauth.find_one({"_id": _uid}):
            ms_events = await ms_today_events(db, _uid)
            ms_unread = sum(1 for m in await ms_recent_mail(db, _uid, top=15) if not m["lu"])
    except Exception as e:
        logger.error(f"[ORACLE] Microsoft 365: {e}")

    parts = ["Briefing du jour."]
    if weather:
        parts.append(f"Météo : {weather[0]['tmin']} à {weather[0]['tmax']} degrés aujourd'hui.")
    if crypto:
        b = crypto[0]
        parts.append(f"Bitcoin {'en hausse' if b['change'] >= 0 else 'en baisse'} de {abs(b['change'])} % sur 24 heures.")
    parts.append(f"Lune : {moon['name'].lower()}, illuminée à {moon['illumination']} %.")
    if peak_hour is not None:
        parts.append(f"Votre pic d'activité habituel est vers {peak_hour} h — charge prévue {charge.lower()}.")
    if upcoming:
        parts.append(f"Prochain événement céleste : {upcoming[0]['name']} le {upcoming[0]['date']}.")
    if ms_events:
        first = ms_events[0]
        parts.append(f"Agenda Microsoft : {len(ms_events)} événement{'s' if len(ms_events) > 1 else ''} aujourd'hui, dont « {first['titre']} » à {first['debut'][11:16]}.")
    if ms_unread:
        parts.append(f"Outlook : {ms_unread} mail{'s' if ms_unread > 1 else ''} non lu{'s' if ms_unread > 1 else ''}.")
    live_titles = []
    if NEWS_API_KEY:
        try:
            live = await _fetch_headlines(limit=5)
            live_titles = [a["titre"] for a in live["articles"][:5] if a["titre"]]
            if live_titles:
                parts.append("À la une : " + ". ".join(live_titles[:3]) + ".")
        except Exception:
            pass

    briefing_txt = " ".join(parts)
    if not light:
        try:
            enriched = await enrich_briefing({
                "date": today.isoformat(),
                "meteo_7_jours": weather,
                "crypto_eur": crypto,
                "marches_actions": stocks,
                "actualites_titres": live_titles or [n.get("text", "") for n in news],
                "lune": moon,
                "evenements_celestes": upcoming,
                "habitudes_utilisateur": personal,
                "agenda_microsoft": ms_events,
                "mails_outlook_non_lus": ms_unread,
            })
            if enriched:
                briefing_txt = enriched
        except Exception as e:
            logger.error(f"[ORACLE] briefing LLM: {e}")

    return {"weather": weather, "crypto": crypto, "stocks": stocks, "stocks_live": stocks_live,
            "news": news,
            "personal": personal, "moon": moon, "astro": upcoming,
            "ms_events": ms_events, "ms_unread": ms_unread,
            "briefing": briefing_txt, "date": today.isoformat()}
# ---- Actualités françaises en direct (NewsAPI) ----
NEWS_API_KEY = os.environ.get("NEWS_API_KEY")
FRENCH_NEWS_DOMAINS = "lemonde.fr,lefigaro.fr,bfmtv.com,france24.com,liberation.fr,20minutes.fr"
_news_cache = {"t": 0.0, "key": "", "data": None}

async def _fetch_headlines(q: str = "", limit: int = 6):
    """Titres FR récents via /v2/everything (top-headlines country=fr est vide sur le plan gratuit)."""
    if not NEWS_API_KEY:
        raise HTTPException(status_code=503, detail="NEWS_API_KEY absente")
    limit = max(1, min(10, limit))
    cache_key = f"{q.strip().lower()}|{limit}"
    if _news_cache["data"] and _news_cache["key"] == cache_key and time.time() - _news_cache["t"] < 300:
        return _news_cache["data"]
    params = {"language": "fr", "sortBy": "publishedAt", "pageSize": limit, "apiKey": NEWS_API_KEY}
    if q.strip():
        params["q"] = q.strip()
    else:
        params["domains"] = FRENCH_NEWS_DOMAINS
    try:
        async with httpx.AsyncClient(timeout=12) as cx:
            r = await cx.get("https://newsapi.org/v2/everything", params=params)
    except Exception:
        raise HTTPException(status_code=502, detail="NewsAPI injoignable")
    if r.status_code == 429:
        raise HTTPException(status_code=429, detail="Quota NewsAPI atteint (100 requêtes/jour)")
    if r.status_code != 200 or r.json().get("status") != "ok":
        logger.error(f"[NEWS] {r.status_code} {r.text[:150]}")
        raise HTTPException(status_code=502, detail="Erreur NewsAPI")
    arts = [{
        "titre": (a.get("title") or "").split(" - ")[0].strip(),
        "source": (a.get("source") or {}).get("name") or "",
        "description": a.get("description") or "",
        "url": a.get("url") or "",
        "date": a.get("publishedAt") or "",
    } for a in r.json().get("articles", [])[:limit]]
    data = {"articles": arts}
    _news_cache.update({"t": time.time(), "key": cache_key, "data": data})
    return data

@api_router.get("/news/headlines")
async def news_headlines(q: str = "", limit: int = 6):
    return await _fetch_headlines(q=q, limit=limit)

# ---- Météo temps réel (OpenWeatherMap) ----
OPENWEATHER_API_KEY = os.environ.get("OPENWEATHER_API_KEY")

@api_router.get("/weather/current")
async def weather_current(city: str = "Paris"):
    if not OPENWEATHER_API_KEY:
        raise HTTPException(status_code=503, detail="OPENWEATHER_API_KEY absente")
    try:
        async with httpx.AsyncClient(timeout=10) as cx:
            r = await cx.get("https://api.openweathermap.org/data/2.5/weather",
                             params={"q": city, "units": "metric", "lang": "fr",
                                     "appid": OPENWEATHER_API_KEY})
    except Exception:
        raise HTTPException(status_code=502, detail="OpenWeatherMap injoignable")
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="Ville introuvable")
    if r.status_code != 200:
        logger.error(f"[METEO] {r.status_code} {r.text[:150]}")
        raise HTTPException(status_code=502, detail="Erreur OpenWeatherMap")
    d = r.json()
    m = d.get("main") or {}
    return {
        "ville": d.get("name") or city,
        "temp": round(m.get("temp", 0)),
        "ressenti": round(m.get("feels_like", 0)),
        "description": ((d.get("weather") or [{}])[0].get("description") or "").capitalize(),
        "humidite": m.get("humidity"),
        "vent": round((d.get("wind", {}).get("speed") or 0) * 3.6),
        "tmin": round(m.get("temp_min", 0)),
        "tmax": round(m.get("temp_max", 0)),
    }

# ---- Fiche pays (REST Countries v5) ----
RESTCOUNTRIES_API_KEY = os.environ.get("RESTCOUNTRIES_API_KEY")

@api_router.get("/country")
async def country_info(name: str):
    if not RESTCOUNTRIES_API_KEY:
        raise HTTPException(status_code=503, detail="RESTCOUNTRIES_API_KEY absente")
    try:
        async with httpx.AsyncClient(timeout=10) as cx:
            r = await cx.get("https://api.restcountries.com/countries/v5",
                             params={"q": name, "limit": 1},
                             headers={"Authorization": f"Bearer {RESTCOUNTRIES_API_KEY}"})
    except Exception:
        raise HTTPException(status_code=502, detail="REST Countries injoignable")
    if r.status_code != 200:
        logger.error(f"[PAYS] {r.status_code} {r.text[:150]}")
        raise HTTPException(status_code=502, detail="Erreur REST Countries")
    objs = (r.json().get("data") or {}).get("objects") or []
    if not objs:
        raise HTTPException(status_code=404, detail="Pays introuvable")
    c = objs[0]
    names = c.get("names") or {}
    nom_fr = ((names.get("translations") or {}).get("fra") or {}).get("common") or names.get("common") or name
    caps = [x.get("name") for x in (c.get("capitals") or []) if x.get("name")]
    monnaies = [f"{x.get('name')} ({x.get('symbol')})" for x in (c.get("currencies") or []) if x.get("name")]
    langues = [x.get("name") for x in (c.get("languages") or []) if x.get("name")]
    return {
        "nom": nom_fr,
        "capitale": caps[0] if caps else "",
        "population": c.get("population"),
        "region": c.get("region") or "",
        "sous_region": c.get("subregion") or "",
        "superficie_km2": (c.get("area") or {}).get("kilometers"),
        "monnaies": monnaies,
        "langues": langues,
        "drapeau": (c.get("flag") or {}).get("emoji") or "",
        "drapeau_png": (c.get("flag") or {}).get("url_png") or "",
    }

# ---- Bulletin tech Hacker News (présenté par Sirius) ----
from sirius_brain import hn_bulletin

_hn_cache = {"t": 0.0, "stories": None}

async def _fetch_hn_stories(limit: int = 12):
    if _hn_cache["stories"] and time.time() - _hn_cache["t"] < 600:
        return _hn_cache["stories"]
    async with httpx.AsyncClient(timeout=12) as cx:
        r = await cx.get("https://hacker-news.firebaseio.com/v0/topstories.json")
        r.raise_for_status()
        ids = r.json()[:limit]
        import asyncio as _aio
        items = await _aio.gather(*[cx.get(f"https://hacker-news.firebaseio.com/v0/item/{i}.json") for i in ids], return_exceptions=True)
    stories = []
    for it in items:
        if isinstance(it, Exception) or it.status_code != 200:
            continue
        d = it.json() or {}
        if d.get("title"):
            stories.append({"title": d["title"], "score": d.get("score", 0),
                            "by": d.get("by", ""), "url": d.get("url", "")})
    if stories:
        _hn_cache.update({"t": time.time(), "stories": stories})
    return stories

class TechBulletinRequest(BaseModel):
    keys: dict = {}

@api_router.post("/technews/bulletin")
async def technews_bulletin(req: TechBulletinRequest):
    try:
        stories = await _fetch_hn_stories()
    except Exception:
        raise HTTPException(status_code=502, detail="Hacker News injoignable")
    if not stories:
        raise HTTPException(status_code=502, detail="Aucune story Hacker News")
    bulletin = await hn_bulletin(stories, req.keys)
    return {"bulletin": bulletin, "stories": stories[:6]}

# ---- Mini-documentaire historique (Wikipedia FR, Wikidata, Gallica, OpenLibrary) ----
from sirius_brain import doc_narrative

async def _gather_documentary_data(sujet: str):
    import asyncio as _aio
    from urllib.parse import quote
    data = {}
    ua = {"User-Agent": "SIRIUS-HUD/1.0 (https://sirius-hud-redesign.emergent.host; contact: daniel.partel@sirius-hud.fr) python-httpx"}
    async with httpx.AsyncClient(timeout=12, follow_redirects=True, headers=ua) as cx:
        async def wiki():
            # Résolution du titre exact (insensible à la casse) puis résumé
            titre = sujet
            try:
                rs = await cx.get("https://fr.wikipedia.org/w/api.php",
                                  params={"action": "query", "list": "search", "srsearch": sujet,
                                          "srlimit": 1, "format": "json"})
                hits = (rs.json().get("query", {}).get("search", []) if rs.status_code == 200 else [])
                if hits:
                    titre = hits[0].get("title") or sujet
            except Exception:
                pass
            r = await cx.get(f"https://fr.wikipedia.org/api/rest_v1/page/summary/{quote(titre)}")
            if r.status_code == 200:
                d = r.json()
                data["wikipedia"] = {"titre": d.get("title"), "description": d.get("description"),
                                     "extrait": d.get("extract", "")[:3000]}
        async def wikidata():
            r = await cx.get("https://www.wikidata.org/w/api.php",
                             params={"action": "wbsearchentities", "search": sujet,
                                     "language": "fr", "format": "json", "limit": 2})
            if r.status_code == 200:
                data["wikidata"] = [{"label": s.get("label"), "description": s.get("description")}
                                    for s in r.json().get("search", [])]
        async def openlib():
            r = await cx.get("https://openlibrary.org/search.json",
                             params={"q": sujet, "limit": 4, "fields": "title,author_name,first_publish_year"})
            if r.status_code == 200:
                data["openlibrary_ouvrages"] = [
                    {"titre": x.get("title"), "auteurs": (x.get("author_name") or [])[:2],
                     "annee": x.get("first_publish_year")} for x in r.json().get("docs", [])]
        async def gallica():
            r = await cx.get("https://gallica.bnf.fr/SRU",
                             params={"operation": "searchRetrieve", "version": "1.2",
                                     "query": f'gallica all "{sujet}"', "maximumRecords": 3})
            if r.status_code == 200:
                titres = re.findall(r"<dc:title>([^<]{5,120})</dc:title>", r.text)[:3]
                if titres:
                    data["gallica_archives"] = titres
        async def europeana():
            key = os.environ.get("EUROPEANA_API_KEY")
            if not key:
                return
            r = await cx.get("https://api.europeana.eu/record/v2/search.json",
                             params={"wskey": key, "query": sujet, "rows": 4, "profile": "standard"})
            if r.status_code == 200 and r.json().get("success"):
                items = []
                for it in r.json().get("items", []):
                    t = (it.get("title") or [""])[0]
                    if t:
                        items.append({"titre": t[:120], "type": it.get("type", ""),
                                      "annee": (it.get("year") or [""])[0],
                                      "fournisseur": (it.get("dataProvider") or [""])[0]})
                if items:
                    data["europeana_collections"] = items
        async def europeana_images():
            key = os.environ.get("EUROPEANA_API_KEY")
            if not key:
                return
            r = await cx.get("https://api.europeana.eu/record/v2/search.json",
                             params={"wskey": key, "query": sujet, "rows": 8,
                                     "profile": "standard", "media": "true", "qf": "TYPE:IMAGE"})
            if r.status_code == 200 and r.json().get("success"):
                imgs, seen = [], set()
                for it in r.json().get("items", []):
                    url = (it.get("edmPreview") or [""])[0]
                    if url and url not in seen:
                        seen.add(url)
                        imgs.append({"url": url,
                                     "legende": (it.get("title") or [""])[0][:80],
                                     "source": (it.get("dataProvider") or [""])[0][:60]})
                    if len(imgs) >= 4:
                        break
                if imgs:
                    data["images"] = imgs
        results = await _aio.gather(wiki(), wikidata(), openlib(), gallica(), europeana(), europeana_images(), return_exceptions=True)
        for res in results:
            if isinstance(res, Exception):
                logger.warning(f"[DOC] source en échec: {res}")
    return data

class DocumentaryRequest(BaseModel):
    sujet: str
    keys: dict = {}

@api_router.post("/documentary")
async def documentary(req: DocumentaryRequest):
    sujet = req.sujet.strip()
    if not sujet:
        raise HTTPException(status_code=400, detail="Sujet vide")
    data = await _gather_documentary_data(sujet)
    images = data.pop("images", [])
    if not data:
        raise HTTPException(status_code=404, detail="Aucune donnée documentaire trouvée")
    texte = await doc_narrative(sujet, data, req.keys)
    return {"documentaire": texte, "sources": list(data.keys()), "images": images}

@api_router.get("/europeana/search")
async def europeana_search(q: str, rows: int = 12):
    """Visionneuse Europeana : recherche d'images d'archives."""
    key = os.environ.get("EUROPEANA_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="EUROPEANA_API_KEY absente")
    if not q.strip():
        raise HTTPException(status_code=400, detail="Recherche vide")
    rows = max(1, min(24, rows))
    try:
        async with httpx.AsyncClient(timeout=12) as cx:
            r = await cx.get("https://api.europeana.eu/record/v2/search.json",
                             params={"wskey": key, "query": q.strip(), "rows": rows * 2,
                                     "profile": "standard", "media": "true", "qf": "TYPE:IMAGE"})
    except Exception:
        raise HTTPException(status_code=502, detail="Europeana injoignable")
    if r.status_code != 200 or not r.json().get("success"):
        logger.error(f"[EUROPEANA] {r.status_code} {r.text[:150]}")
        raise HTTPException(status_code=502, detail="Erreur Europeana")
    imgs, seen = [], set()
    for it in r.json().get("items", []):
        url = (it.get("edmPreview") or [""])[0]
        if url and url not in seen:
            seen.add(url)
            imgs.append({"url": url,
                         "legende": (it.get("title") or [""])[0][:90],
                         "source": (it.get("dataProvider") or [""])[0][:60],
                         "annee": (it.get("year") or [""])[0]})
        if len(imgs) >= rows:
            break
    return {"images": imgs, "total": r.json().get("totalResults", 0)}

# ---- SIRIUS WebBrowser : ouverture + analyse technique de pages web ----
from sirius_brain import web_report
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse, parse_qs, unquote

_BROWSER_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
}

# Repli curl : certains sites (Wikipedia...) bloquent l'empreinte TLS des clients Python
import subprocess as _sp
import tempfile as _tmp
import asyncio as _aio

class _CurlResp:
    def __init__(self, url, status, headers, content):
        self.url = url
        self.status_code = status
        self.headers = headers
        self.content = content
        try:
            self.text = content.decode("utf-8", errors="replace")
        except Exception:
            self.text = ""

def _curl_get(url: str, timeout: int):
    hf = _tmp.NamedTemporaryFile(delete=False, suffix=".h")
    bf = _tmp.NamedTemporaryFile(delete=False, suffix=".b")
    hf.close(); bf.close()
    try:
        p = _sp.run(
            ["curl", "-sL", "-m", str(timeout), "-A", _BROWSER_UA["User-Agent"],
             "-H", f"Accept: {_BROWSER_UA['Accept']}", "-H", f"Accept-Language: {_BROWSER_UA['Accept-Language']}",
             "-D", hf.name, "-o", bf.name, "-w", "%{http_code}|%{url_effective}", url],
            capture_output=True, timeout=timeout + 5)
        meta = p.stdout.decode("utf-8", errors="replace").strip()
        status_s, _, final_url = meta.partition("|")
        status = int(status_s or 0)
        with open(hf.name, "rb") as f:
            raw = f.read().decode("utf-8", errors="replace")
        block = [b for b in raw.split("\r\n\r\n") if b.strip()]
        headers = {}
        if block:
            for line in block[-1].split("\r\n")[1:]:
                k, _, v = line.partition(":")
                if v:
                    headers[k.strip().lower()] = v.strip()
        with open(bf.name, "rb") as f:
            content = f.read()
        return _CurlResp(final_url or url, status, headers, content)
    finally:
        for fp in (hf.name, bf.name):
            try: os.unlink(fp)
            except Exception: pass

async def _fetch_page(url: str, timeout: int = 14):
    r = None
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=_BROWSER_UA) as cx:
            r = await cx.get(url)
        if r.status_code not in (403, 429, 503):
            return r
    except Exception:
        pass
    try:
        rc = await _aio.to_thread(_curl_get, url, timeout)
        if rc.status_code:
            return rc
    except Exception:
        pass
    if r is not None:
        return r
    raise HTTPException(status_code=502, detail="Page inaccessible")
_WEB_URL_RE = re.compile(r"https?://\S+|(?:www\.)\S+|\b[a-z0-9-]{2,}(?:\.[a-z0-9-]{2,})+(?:/\S*)?", re.I)

class WebOpenRequest(BaseModel):
    target: str
    keys: dict = {}

async def _first_search_result(query: str, keys: dict):
    serp_key = (keys or {}).get("serpapi") or os.environ.get("SERP_API_KEY")
    async with httpx.AsyncClient(timeout=10, follow_redirects=True, headers=_BROWSER_UA) as cx:
        if serp_key:
            try:
                r = await cx.get("https://serpapi.com/search.json",
                                 params={"q": query, "api_key": serp_key, "hl": "fr", "gl": "fr", "num": 3})
                for it in (r.json().get("organic_results") or []):
                    if it.get("link"):
                        return it["link"]
            except Exception:
                pass
        try:
            r = await cx.get("https://html.duckduckgo.com/html/", params={"q": query})
            if r.status_code == 200:
                a = BeautifulSoup(r.text, "html.parser").select_one("a.result__a")
                if a and a.get("href"):
                    href = a["href"]
                    if "uddg=" in href:
                        return unquote(parse_qs(urlparse(href).query).get("uddg", [""])[0])
                    return href
        except Exception:
            pass
    return None

@api_router.post("/webbrowser/open")
async def webbrowser_open(req: WebOpenRequest):
    target = req.target.strip()
    if not target:
        raise HTTPException(status_code=400, detail="Cible vide")
    url = None
    m = _WEB_URL_RE.search(target)
    if m:
        url = m.group(0).rstrip(".,;)")
        if not url.lower().startswith("http"):
            url = "https://" + url
    if not url:
        url = await _first_search_result(target, req.keys)
    if not url:
        return {"erreur": "Page inaccessible"}
    try:
        r = await _fetch_page(url, 14)
    except Exception:
        return {"erreur": "Page inaccessible"}
    if r.status_code >= 400:
        return {"erreur": "Page inaccessible"}
    soup = BeautifulSoup(r.text, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    titre = (soup.title.string or "").strip() if soup.title else url
    meta = soup.find("meta", attrs={"name": "description"}) or soup.find("meta", attrs={"property": "og:description"})
    description = (meta.get("content") or "").strip()[:300] if meta else ""
    sections = [h.get_text(" ", strip=True)[:100] for h in soup.find_all(["h1", "h2", "h3"])[:8] if h.get_text(strip=True)]
    texte = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))[:2500]
    liens, seen = [], set()
    final_url = str(r.url)
    for a in soup.find_all("a", href=True):
        href = urljoin(final_url, a["href"])
        if href.startswith("http") and href not in seen and a.get_text(strip=True):
            seen.add(href)
            liens.append({"texte": a.get_text(" ", strip=True)[:60], "url": href[:150]})
        if len(liens) >= 10:
            break
    page = {"url": final_url, "titre": titre[:150], "description": description,
            "sections": sections, "texte": texte, "liens": liens}
    rapport = await web_report(page, req.keys)
    xfo = (r.headers.get("x-frame-options") or "").lower()
    csp = (r.headers.get("content-security-policy") or "").lower()
    iframe_ok = not ("deny" in xfo or "sameorigin" in xfo or "frame-ancestors" in csp)
    return {"url": final_url, "titre": titre[:150], "rapport": rapport,
            "resume": description or texte[:180], "iframe_ok": iframe_ok}

# ---- Proxy HUD : contourne X-Frame-Options pour afficher les sites bloqués dans l'iframe ----
from urllib.parse import quote

_PROXY_ATTRS = [("img", "src"), ("script", "src"), ("link", "href"), ("source", "src"),
                ("video", "src"), ("audio", "src"), ("iframe", "src"), ("form", "action")]

# ---- Rendu SIRIUS pour YouTube : grille de vidéos + lecteur embed officiel (fiable en iframe) ----
def _yt_walk(obj, out):
    if isinstance(obj, dict):
        if "videoRenderer" in obj:
            v = obj["videoRenderer"]
            vid = v.get("videoId")
            title = "".join(r.get("text", "") for r in ((v.get("title") or {}).get("runs") or []))
            ch = "".join(r.get("text", "") for r in ((v.get("ownerText") or {}).get("runs") or []))
            dur = ((v.get("lengthText") or {}).get("simpleText") or "")
            thumbs = ((v.get("thumbnail") or {}).get("thumbnails") or [])
            th = thumbs[-1].get("url", "") if thumbs else ""
            if vid and title:
                out.append({"id": vid, "titre": title, "chaine": ch, "duree": dur, "thumb": th})
        for val in obj.values():
            _yt_walk(val, out)
    elif isinstance(obj, list):
        for it in obj:
            _yt_walk(it, out)

def _yt_custom_page(html: str, query_label: str):
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", html, re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except Exception:
        return None
    vids, seen = [], set()
    raw = []
    _yt_walk(data, raw)
    for v in raw:
        if v["id"] not in seen:
            seen.add(v["id"])
            vids.append(v)
        if len(vids) >= 24:
            break
    if not vids:
        return None
    cards = []
    for v in vids:
        dur = f'<em>{v["duree"]}</em>' if v["duree"] else ""
        titre = v["titre"][:80].replace("<", "&lt;")
        chaine = v["chaine"][:40].replace("<", "&lt;")
        cards.append(
            f'<a class="v" href="https://www.youtube.com/embed/{v["id"]}?autoplay=1" target="_self">'
            f'<span class="th"><img src="{v["thumb"]}" loading="lazy" alt=""/>{dur}</span>'
            f'<span class="t">{titre}</span><span class="c">{chaine}</span></a>'
        )
    cards = "".join(cards)
    return f"""<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"/>
<style>
body{{margin:0;background:#04101a;color:#cdeefb;font-family:'Segoe UI',sans-serif}}
.bar{{position:sticky;top:0;display:flex;gap:8px;align-items:center;padding:10px 14px;background:#061826;border-bottom:1px solid #164e63}}
.bar b{{color:#67e8f9;font-size:13px;letter-spacing:.08em}}
.bar form{{flex:1;display:flex;gap:6px}}
.bar input{{flex:1;background:#04101a;border:1px solid #164e63;border-radius:999px;color:#cdeefb;padding:7px 14px;font-size:13px;outline:none}}
.bar button{{background:#0e7490;border:0;border-radius:999px;color:#e0faff;padding:7px 16px;font-size:12px;cursor:pointer}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;padding:14px}}
.v{{display:flex;flex-direction:column;gap:6px;text-decoration:none;color:inherit;background:#071c2c;border:1px solid #133c52;border-radius:8px;overflow:hidden;transition:transform .12s}}
.v:hover{{transform:translateY(-2px);border-color:#22d3ee}}
.th{{position:relative;display:block}}
.th img{{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}}
.th em{{position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.85);color:#fff;font-style:normal;font-size:11px;padding:1px 5px;border-radius:3px}}
.t{{font-size:13px;font-weight:600;padding:0 9px;line-height:1.3}}
.c{{font-size:11px;color:#67a8c4;padding:0 9px 9px}}
</style></head><body>
<div class="bar"><b>YOUTUBE · SIRIUS</b>
<form onsubmit="location='/api/webbrowser/proxy?url='+encodeURIComponent('https://www.youtube.com/results?search_query='+encodeURIComponent(this.q.value));return false">
<input name="q" placeholder="Rechercher sur YouTube... ({query_label})" autocomplete="off"/><button>OK</button></form></div>
<div class="grid">{cards}</div></body></html>"""

@api_router.get("/webbrowser/proxy")
async def webbrowser_proxy(url: str, noscript: int = 0):
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL invalide")
    try:
        r = await _fetch_page(url, 20)
    except Exception:
        return HTMLResponse("<body style='background:#03060c;color:#67e8f9;font-family:sans-serif;display:grid;place-items:center;height:100vh'>Page inaccessible</body>", status_code=200)
    ctype = r.headers.get("content-type", "")
    if "text/html" not in ctype.lower():
        return RawResponse(content=r.content, media_type=ctype or "application/octet-stream")
    final = str(r.url)
    fp = urlparse(final)
    if "youtube.com" in fp.netloc and fp.path in ("/results", "/", "/feed/trending"):
        q = parse_qs(fp.query).get("search_query", [""])[0]
        custom = _yt_custom_page(r.text, q or "tendances")
        if custom:
            return HTMLResponse(content=custom, headers={"Cache-Control": "no-store"})
    soup = BeautifulSoup(r.text, "html.parser")
    for tag in soup.find_all("meta"):
        he = (tag.get("http-equiv") or "").lower()
        if he in ("content-security-policy", "x-frame-options", "refresh"):
            tag.decompose()
    for tag in soup.find_all("base"):
        tag.decompose()
    if noscript:
        for tag in soup.find_all("script"):
            tag.decompose()
    for name, attr in _PROXY_ATTRS:
        for tag in soup.find_all(name, attrs={attr: True}):
            v = tag.get(attr) or ""
            if v and not v.startswith(("data:", "javascript:", "#", "blob:")):
                tag[attr] = urljoin(final, v)
    for tag in soup.find_all(attrs={"srcset": True}):
        parts = []
        for cand in (tag.get("srcset") or "").split(","):
            bits = cand.strip().split()
            if bits:
                bits[0] = urljoin(final, bits[0])
                parts.append(" ".join(bits))
        tag["srcset"] = ", ".join(parts)
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        absu = urljoin(final, href)
        if absu.startswith("http"):
            a["href"] = f"/api/webbrowser/proxy?url={quote(absu, safe='')}" + ("&noscript=1" if noscript else "")
            a["target"] = "_self"
    return HTMLResponse(content=str(soup), headers={"Cache-Control": "no-store"})

# ---- Fenêtres de tâches SIRIUS : génération d'images (Nano Banana) et clips (fal.ai) ----
FAL_VIDEO_MODEL = "fal-ai/ltx-2/text-to-video/fast"

class TaskImageRequest(BaseModel):
    prompt: str

class TaskVideoRequest(BaseModel):
    prompt: str
    keys: dict = {}
    duration: int = 6

@api_router.post("/task/image")
async def task_image(req: TaskImageRequest):
    prompt = (req.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt vide")
    from emergentintegrations.llm.chat import LlmChat, UserMessage
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Clé Emergent absente")
    chat = LlmChat(api_key=api_key, session_id=f"task-img-{os.urandom(6).hex()}",
                   system_message="Tu es le moteur de rendu visuel de SIRIUS. Génère des images de haute qualité.")
    chat.with_model("gemini", "gemini-3.1-flash-image-preview").with_params(modalities=["image", "text"])
    try:
        text, images = await chat.send_message_multimodal_response(UserMessage(text=prompt))
    except Exception as e:
        logger.error(f"[TASK IMAGE] {e}")
        raise HTTPException(status_code=502, detail="Moteur de rendu indisponible")
    if not images:
        raise HTTPException(status_code=502, detail="Aucune image produite")
    img = images[0]
    return {"image": img["data"], "mime": img.get("mime_type") or "image/png", "texte": (text or "")[:300]}

def _fal_setup(keys: dict):
    fal_key = (keys or {}).get("fal") or os.environ.get("FAL_KEY")
    if not fal_key:
        raise HTTPException(status_code=400, detail="Clé fal.ai manquante")
    os.environ["FAL_KEY"] = fal_key
    import fal_client
    return fal_client

@api_router.post("/task/video/start")
async def task_video_start(req: TaskVideoRequest):
    prompt = (req.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt vide")
    fal_client = _fal_setup(req.keys)
    try:
        handler = await fal_client.submit_async(FAL_VIDEO_MODEL, arguments={"prompt": prompt})
    except Exception as e:
        msg = str(e).lower()
        logger.error(f"[TASK VIDEO] start: {e}")
        if "balance" in msg or "locked" in msg:
            raise HTTPException(status_code=402, detail="Solde fal.ai épuisé — rechargez votre compte sur fal.ai/dashboard/billing")
        raise HTTPException(status_code=502, detail="Pipeline vidéo indisponible (vérifiez votre clé fal.ai)")
    return {"request_id": handler.request_id}

@api_router.post("/task/video/status/{request_id}")
async def task_video_status(request_id: str, req: TaskVideoRequest):
    fal_client = _fal_setup(req.keys)
    try:
        status = await fal_client.status_async(FAL_VIDEO_MODEL, request_id, with_logs=False)
        if isinstance(status, fal_client.Completed):
            result = await fal_client.result_async(FAL_VIDEO_MODEL, request_id)
            url = ((result or {}).get("video") or {}).get("url") or ""
            if not url:
                raise HTTPException(status_code=502, detail="Vidéo introuvable dans le résultat")
            return {"etat": "termine", "video_url": url}
        if isinstance(status, fal_client.InProgress):
            return {"etat": "en_cours"}
        return {"etat": "attente"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[TASK VIDEO] status: {e}")
        raise HTTPException(status_code=502, detail="Échec de la génération vidéo")

# ---- Mode Compagnon Dev : revue de code, commits, analyse de logs ----
class DevRequest(BaseModel):
    code: str
    action: str = "review"
    keys: dict = {}

@api_router.post("/dev/review")
async def dev_review(req: DevRequest, request: Request):
    code = (req.code or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Code vide")
    if not _rate_ok(request.client.host if request.client else "?", limit=10):
        raise HTTPException(status_code=429, detail="Trop de requêtes, patientez un instant.")
    try:
        result = await dev_companion(code, req.action or "review", keys=req.keys or {})
        return {"result": result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"[DEV] Erreur: {e}")
        if "invalid_api_key" in str(e).lower() or "401" in str(e):
            raise HTTPException(status_code=400, detail="Clé Kimi K3 invalide — vérifiez votre clé dans les réglages (icône profil).")
        raise HTTPException(status_code=500, detail="Sirius n'a pas pu analyser ce code, réessayez.")

# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Hello World"}

# ---- Google Cloud TTS : voix neurale française de Sirius (fr-FR-Neural2-G, homme) ----
class GoogleTTSRequest(BaseModel):
    text: str
    rate: float = 1.05
    pitch: float = -2.0
    voice: str = "fr-FR-Neural2-G"

ALLOWED_TTS_VOICES = {
    "fr-FR-Neural2-F", "fr-FR-Neural2-G",
    "fr-FR-Wavenet-A", "fr-FR-Wavenet-B", "fr-FR-Wavenet-C", "fr-FR-Wavenet-D", "fr-FR-Wavenet-E",
    "fr-FR-Standard-A", "fr-FR-Standard-B", "fr-FR-Standard-C", "fr-FR-Standard-D", "fr-FR-Standard-E",
}

@api_router.post("/tts/google")
async def google_tts(req: GoogleTTSRequest):
    key = os.environ.get("GOOGLE_TTS_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="GOOGLE_TTS_API_KEY absente")
    text = req.text.strip()[:4500]
    if not text:
        raise HTTPException(status_code=400, detail="Texte vide")
    payload = {
        "input": {"text": text},
        "voice": {"languageCode": "fr-FR", "name": req.voice if req.voice in ALLOWED_TTS_VOICES else "fr-FR-Neural2-G"},
        "audioConfig": {
            "audioEncoding": "MP3",
            "speakingRate": max(0.5, min(2.0, req.rate)),
            "pitch": max(-10.0, min(10.0, req.pitch)),
        },
    }
    try:
        async with httpx.AsyncClient(timeout=15) as cx:
            r = await cx.post(
                "https://texttospeech.googleapis.com/v1/text:synthesize",
                params={"key": key}, json=payload)
    except Exception as e:
        logger.error(f"[GOOGLE TTS] réseau: {e}")
        raise HTTPException(status_code=502, detail="Google TTS injoignable")
    if r.status_code != 200:
        logger.error(f"[GOOGLE TTS] {r.status_code} {r.text[:200]}")
        raise HTTPException(status_code=502, detail="Erreur Google TTS")
    audio = r.json().get("audioContent")
    if not audio:
        raise HTTPException(status_code=502, detail="Réponse TTS sans audio")
    return {"audio": audio, "format": "mp3"}


# Generic TTS endpoint wrapper (compatibility)
@api_router.post("/tts")
async def tts(req: GoogleTTSRequest):
    """Compatibility wrapper: POST /api/tts → delegates to a configured TTS backend if present,
    otherwise uses the local Google TTS implementation.
    """
    tts_url = os.environ.get("TTS_BACKEND_URL")
    if tts_url:
        try:
            payload = {"text": req.text, "rate": req.rate, "pitch": req.pitch, "voice": req.voice}
            async with httpx.AsyncClient(timeout=30) as cx:
                r = await cx.post(tts_url, json=payload)
            if r.status_code == 200:
                # Assume backend returns JSON with audio base64 or similar
                return r.json()
            logger.error(f"[TTS] backend {tts_url} returned {r.status_code}: {r.text[:200]}")
            raise HTTPException(status_code=502, detail="TTS backend error")
        except Exception as e:
            logger.error(f"[TTS] proxy error to {tts_url}: {e}")
            raise HTTPException(status_code=502, detail="TTS proxy failed")

    # Fallback to built-in Google TTS implementation
    return await google_tts(req)


# Simple STT endpoint (compatibility)
@api_router.post("/stt")
async def stt(file: UploadFile = File(...)):
    """Server-side STT. If an external STT backend is configured via WHISPER_API_URL or STT_BACKEND_URL,
    the uploaded file is proxied to that service. Otherwise returns an empty transcript (placeholder).
    """
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Audio vide")
    stt_url = os.environ.get("WHISPER_API_URL") or os.environ.get("STT_BACKEND_URL")
    if stt_url:
        try:
            async with httpx.AsyncClient(timeout=90) as cx:
                # preserve original filename and content-type when available
                fname = getattr(file, 'filename', 'audio')
                ctype = getattr(file, 'content_type', 'application/octet-stream')
                files = {"file": (fname, data, ctype)}
                r = await cx.post(stt_url, files=files)
            if r.status_code == 200:
                return r.json()
            logger.error(f"[STT] backend returned {r.status_code}: {r.text[:200]}")
            raise HTTPException(status_code=502, detail="STT backend error")
        except Exception as e:
            logger.error(f"[STT] proxy error: {e}")
            raise HTTPException(status_code=502, detail="STT proxy failed")

    # Fallback: no STT configured
    return {"text": ""}


# ---- Téléchargement des archives source (contourne le cache PWA du frontend) ----
from fastapi.responses import FileResponse

@api_router.get("/download/{filename}")
async def download_zip(filename: str):
    if not filename.endswith(".zip") or "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Nom de fichier invalide")
    path = Path(__file__).parent.parent / "frontend" / "public" / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Fichier introuvable")
    return FileResponse(str(path), media_type="application/zip", filename=filename)

@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.model_dump()
    status_obj = StatusCheck(**status_dict)
    
    # Convert to dict and serialize datetime to ISO string for MongoDB
    doc = status_obj.model_dump()
    doc['timestamp'] = doc['timestamp'].isoformat()
    
    _ = await db.status_checks.insert_one(doc)
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    # Exclude MongoDB's _id field from the query results
    status_checks = await db.status_checks.find({}, {"_id": 0}).to_list(1000)
    
    # Convert ISO string timestamps back to datetime objects
    for check in status_checks:
        if isinstance(check['timestamp'], str):
            check['timestamp'] = datetime.fromisoformat(check['timestamp'])
    
    return status_checks

# Include the router in the main app
# ---- Outlook (Microsoft Graph) : emails + calendrier ----
from outlook_graph import make_outlook_router
@api_router.get("/chat/status")
async def chat_status():
    import sirius_brain as _sb
    gmaps_env = (os.environ.get("GOOGLE_MAPS_API_KEY") or os.environ.get("MAPS_PLATFORM_API_Key") or "").strip()
    return {"groq_env": bool(_sb.ENV_K3_KEY), "gmaps_env": gmaps_env}

api_router.include_router(make_outlook_router(db))

from haccp import make_haccp_router
api_router.include_router(make_haccp_router(db))

from modules_api import make_modules_router
api_router.include_router(make_modules_router(db))
from payments_api import make_payments_router
api_router.include_router(make_payments_router(db))
from google_calendar import make_gcal_router
api_router.include_router(make_gcal_router(db))
from auth_api import make_auth_router, make_admin_router
api_router.include_router(make_auth_router(db))
api_router.include_router(make_admin_router(db))
from microsoft_graph import make_microsoft_router
api_router.include_router(make_microsoft_router(db))
from nummarius_api import make_nummarius_router
api_router.include_router(make_nummarius_router(db))

from themis_api import make_themis_router
api_router.include_router(make_themis_router(db))

from home_assistant import make_ha_router
api_router.include_router(make_ha_router(db))
# ---- HÉPHAÏSTOS : diagnostic système réel (auto-maintenance) ----
@api_router.get("/hephaistos/diagnostic")
async def hephaistos_diagnostic(source: str = "manuel"):
    """Diagnostic RÉEL : endpoints internes, services système, intégrations externes."""
    started = datetime.now(timezone.utc)
    report = {"generated_at": started.isoformat(), "groups": {}, "summary": {}}

    # --- Groupe 1 : endpoints internes (/api) ---
    base = "http://localhost:8001/api"
    endpoints = [
        ("ORACLE", "GET", "/oracle/overview?lat=48.85&lon=2.35&light=1"),
        ("ATLAS", "POST", "/atlas/route", {"from_address": "Paris", "to_address": "Lyon"}),
        ("HERACLES", "POST", "/heracles/check", {"input": "@sirius_diag"}),
        ("PANTHEON", "GET", "/pantheon/connectivity"),
        ("FICHIERS", "GET", "/files"),
        ("NOTIFY", "POST", "/notify/whatsapp", {"phone": "", "apikey": "", "text": ""}),
        ("PUSH", "GET", "/push/public_key"),
    ]
    core = []
    async with httpx.AsyncClient(timeout=30) as cx:
        for item in endpoints:
            name, method, path = item[0], item[1], item[2]
            payload = item[3] if len(item) > 3 else None
            t0 = time.perf_counter()
            try:
                if method == "GET":
                    r = await cx.get(base + path)
                else:
                    r = await cx.post(base + path, json=payload)
                # 4xx attendus (validation) = endpoint vivant ; 5xx = panne
                healthy = r.status_code < 500
                core.append({"name": name, "status": "OK" if healthy else "FAIL",
                             "code": r.status_code, "latency": int((time.perf_counter() - t0) * 1000)})
            except Exception as e:
                core.append({"name": name, "status": "FAIL", "code": None,
                             "latency": None, "error": f"{type(e).__name__}: {e}"[:120]})
    report["groups"]["endpoints"] = core

    # --- Groupe 2 : services système (compatible production : Mongo externe, frontend statique) ---
    sysroot = []
    try:
        mem = psutil.virtual_memory()
        cpu = psutil.cpu_percent(interval=0.3)
        procs = {p.info["name"] for p in psutil.process_iter(["name"]) if p.info.get("name")}
        # Backend : trivialement actif (il exécute ce diagnostic)
        sysroot.append({"name": "BACKEND (uvicorn)", "status": "OK", "detail": "actif"})
        # Frontend : processus node (dev) OU serveur local OU build statique servi par l'ingress (production)
        front_up = any("node" in (n or "").lower() for n in procs)
        front_detail = "actif (serveur de développement)"
        if not front_up:
            try:
                async with httpx.AsyncClient(timeout=4) as cx:
                    r = await cx.get("http://localhost:3000/")
                    front_up = r.status_code < 500
                    front_detail = "actif (port 3000)"
            except Exception:
                front_up = True
                front_detail = "servi en statique (production)"
        sysroot.append({"name": "FRONTEND (node)", "status": "OK" if front_up else "FAIL", "detail": front_detail if front_up else "introuvable"})
        sysroot.append({"name": "CPU", "status": "OK" if cpu < 92 else "FAIL", "detail": f"{cpu:.0f}%"})
        sysroot.append({"name": "MÉMOIRE", "status": "OK" if mem.percent < 92 else "FAIL", "detail": f"{mem.percent:.0f}%"})
    except Exception as e:
        sysroot.append({"name": "SYSTÈME", "status": "FAIL", "detail": str(e)[:80]})
    # MongoDB : ping réel (fonctionne aussi avec une base externe/managée en production)
    try:
        await db.command("ping")
        sysroot.append({"name": "MONGODB", "status": "OK", "detail": "ping réussi"})
    except Exception as e:
        sysroot.append({"name": "MONGODB", "status": "FAIL", "detail": f"{type(e).__name__}: {e}"[:80]})
    report["groups"]["system"] = sysroot

    ext = []
    integ = [
        ("KIMI K3 (LLM)", "https://api.moonshot.cn/v1/models", bool(os.environ.get("DANIEL_DEV_K3"))),
        ("ALPHA VANTAGE", "https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=AAPL&apikey=demo", bool(os.environ.get("ALPHA_VANTAGE_API_KEY"))),
        ("OPENSTREETMAP", "https://nominatim.openstreetmap.org/search?q=Paris&format=json&limit=1", True),
        ("OSRM (routes)", "https://router.project-osrm.org/route/v1/driving/2.35,48.85;4.83,45.76?overview=false", True),
        ("CALLMEBOT", "https://api.callmebot.com/whatsapp.php", True),
        ("OPEN-METEO", "https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&current=temperature_2m", True),
    ]
    default_headers = {"User-Agent": "SIRIUS-HUD/1.0 (contact@sirius.local)"}

    async with httpx.AsyncClient(timeout=12, follow_redirects=True, headers=default_headers) as cx:
        for name, url, configured in integ:
            t0 = time.perf_counter()
            try:
                req_headers = {}
                if name.startswith("KIMI") or name.startswith("GROQ"):
                    req_headers["Authorization"] = f"Bearer {os.environ.get('DANIEL_DEV_K3','')}"

                r = await cx.get(url, headers=req_headers)
                reachable = r.status_code < 500
                ext.append({
                    "name": name,
                    "status": "OK" if reachable else "FAIL",
                    "code": r.status_code,
                    "configured": configured,
                    "latency": int((time.perf_counter() - t0) * 1000)
                })
            except Exception as e:
                ext.append({
                    "name": name,
                    "status": "FAIL",
                    "code": None,
                    "configured": configured,
                    "latency": None,
                    "error": str(e)[:100]
                })
    report["groups"]["integrations"] = ext

    # --- Synthèse ---
    all_items = core + sysroot + ext
    total = len(all_items)
    passed = sum(1 for i in all_items if i["status"] == "OK")
    rate = round(passed / total * 100) if total else 0
    report["summary"] = {
        "total": total, "passed": passed, "failed": total - passed, "rate": rate,
        "state": "OK" if rate == 100 else ("DÉGRADÉ" if rate >= 70 else "CRITIQUE"),
        "duration_ms": int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
        "failed_modules": [i["name"] for i in all_items if i["status"] != "OK"],
    }
    report["speech"] = (
        f"Diagnostic terminé. {passed} modules sur {total} opérationnels, "
        f"soit {rate} pour cent. État du système : {report['summary']['state'].lower()}."
        + (f" Attention aux modules : {', '.join(report['summary']['failed_modules'][:4])}." if report['summary']['failed_modules'] else " Tous les systèmes sont nominaux, monsieur.")
    )
    log_service("HÉPHAÏSTOS", f"Diagnostic complet — {passed}/{total} OK ({rate}%)",
                "OK" if rate == 100 else "ERREUR")
    try:
        await db.diagnostics.insert_one({
            "at": started.isoformat(), "source": source,
            "rate": rate, "passed": passed, "failed": total - passed, "total": total,
            "state": report["summary"]["state"],
            "failed_modules": report["summary"]["failed_modules"],
            "duration_ms": report["summary"]["duration_ms"],
        })
    except Exception as e:
        logger.error(f"[HÉPHAÏSTOS] persistance historique: {e}")
    return report

@api_router.get("/hephaistos/history")
async def hephaistos_history(limit: int = 40):
    docs = await db.diagnostics.find({}, {"_id": 0}).sort("at", -1).to_list(max(1, min(limit, 200)))
    return {"history": list(reversed(docs))}

@api_router.delete("/hephaistos/history")
async def hephaistos_history_purge(keep: int = 0):
    """Purge l'historique des diagnostics. keep>0 conserve les N plus récents."""
    if keep > 0:
        recent = await db.diagnostics.find({}, {"at": 1}).sort("at", -1).to_list(keep)
        cutoff = recent[-1]["at"] if len(recent) >= keep else None
        res = await db.diagnostics.delete_many({"at": {"$lt": cutoff}} if cutoff else {"_id": None})
    else:
        res = await db.diagnostics.delete_many({})
    log_service("HÉPHAÏSTOS", f"Historique purgé — {res.deleted_count} diagnostic(s) supprimé(s)", "OK")
    return {"ok": True, "deleted": res.deleted_count}

# ---- Statut des clés API (booléens uniquement, jamais les valeurs) ----
@api_router.get("/system/keys_status")
async def keys_status():
    def ok(name):
        return bool((os.environ.get(name) or "").strip())
    return {"keys": [
        {"id": "k3", "service": "Kimi K3 / Moonshot (cerveau LLM)", "configured": ok("DANIEL_DEV_K3")},
        {"id": "tts", "service": "Google TTS (voix premium)", "configured": ok("GOOGLE_TTS_API_KEY")},
        {"id": "serp", "service": "SerpAPI (recherche web)", "configured": ok("SERP_API_KEY")},
        {"id": "news", "service": "NewsAPI (actualités)", "configured": ok("NEWS_API_KEY")},
        {"id": "weather", "service": "OpenWeather (météo)", "configured": ok("OPENWEATHER_API_KEY")},
        {"id": "gmaps", "service": "Google Maps (Atlas — carte & navigation)", "configured": ok("GOOGLE_MAPS_API_KEY") or ok("MAPS_PLATFORM_API_Key")},
        {"id": "alpha", "service": "Alpha Vantage (bourse)", "configured": ok("ALPHA_VANTAGE_API_KEY")},
        {"id": "countries", "service": "RestCountries (pays)", "configured": ok("RESTCOUNTRIES_API_KEY")},
        {"id": "europeana", "service": "Europeana (patrimoine)", "configured": ok("EUROPEANA_API_KEY")},
        {"id": "spotify", "service": "Spotify (musique)", "configured": ok("SPOTIFY_CLIENT_ID") and ok("SPOTIFY_CLIENT_SECRET")},
        {"id": "fal", "service": "Fal.ai (images / vidéos)", "configured": ok("FAL_KEY")},
        {"id": "outlook", "service": "Microsoft Outlook (Graph)", "configured": ok("MS_CLIENT_ID") and ok("MS_CLIENT_SECRET")},
        {"id": "gemini", "service": "Google Gemini (optionnel)", "configured": ok("GEMINI_API_KEY")},
        {"id": "emergent", "service": "Clé universelle Emergent", "configured": ok("EMERGENT_LLM_KEY")},
    ]}

from push_notifications import make_push_router  # noqa: E402
api_router.include_router(make_push_router())

# ---- Veille push proactive : Sirius prévient des actus tout seul ----
async def _push_watch_loop():
    from push_notifications import load_watch, save_watch, subscriber_count, send_push_to_all
    await asyncio.sleep(20)
    while True:
        try:
            w = load_watch()
            due = time.time() - w.get("last_run", 0) >= w.get("interval_min", 60) * 60
            if w.get("enabled", True) and due and subscriber_count() > 0 and NEWS_API_KEY:
                data = await _fetch_headlines(limit=5)
                sent_titles = w.get("sent_titles", [])
                fresh = [a["titre"] for a in data.get("articles", []) if a.get("titre") and a["titre"] not in sent_titles]
                for titre in fresh[:2]:
                    send_push_to_all("SIRIUS — Veille active", titre)
                    sent_titles.append(titre)
                w["sent_titles"] = sent_titles[-60:]
                w["last_run"] = time.time()
                save_watch(w)
                if fresh:
                    logger.info(f"[VEILLE PUSH] {len(fresh[:2])} actu(s) envoyée(s)")
        except Exception as e:
            logger.error(f"[VEILLE PUSH] {repr(e)}")
        await asyncio.sleep(60)


_watch_task = None


@app.on_event("startup")
async def init_files_storage():
    global _watch_task
    _watch_task = asyncio.create_task(_push_watch_loop())
    from auth_api import seed_admin_and_indexes
    try:
        await seed_admin_and_indexes(db)
        logger.info("[AUTH] Index et compte admin prêts")
    except Exception as e:
        logger.error(f"[AUTH] Init échouée: {e}")
    if cloud_available():
        try:
            init_storage()
            logger.info("[FILES] Stockage cloud initialisé")
        except Exception as e:
            logger.error(f"[FILES] Init stockage échouée: {e}")

@app.on_event("shutdown")
async def shutdown_db_client():
    if _watch_task:
        _watch_task.cancel()
    client.close()
# =========================================================
# MODULE AUTO-ÉVOLUTIF SIRIUS : MODIFICATION DU CODE LOCAL
# =========================================================
import ast
import shutil
import sys
import os
import time
from fastapi import HTTPException, BackgroundTasks
from pydantic import BaseModel

class PatchRequest(BaseModel):
    file_path: str  # ex: "server.py" ou "sirius_brain.py"
    content: str    # Nouveau code à installer

BACKUP_DIR = os.path.join(os.getcwd(), "backups")
os.makedirs(BACKUP_DIR, exist_ok=True)

import ast
import shutil
import os
import hmac
from fastapi import Header, HTTPException

# Configuration de la sécurité admin par token (comparaison en temps constant)
ADMIN_TOKEN = os.getenv("SIRIUS_ADMIN_TOKEN", "change_me_secure_token")

def verify_admin_token(x_admin_token: str = Header(...)):
    if not hmac.compare_digest(x_admin_token.encode("utf-8"), ADMIN_TOKEN.encode("utf-8")):
        raise HTTPException(status_code=403, detail="Accès refusé : Token administrateur invalide.")
    return True

class PatchRequest(BaseModel):
    file_path: str
    content: str

BACKUP_DIR = os.path.join(os.getcwd(), "backups")
os.makedirs(BACKUP_DIR, exist_ok=True)

# Chemins de fichiers strictement autorisés à la modification
ALLOWED_FILES = ["server.py", "sirius_brain.py", "auth_api.py"]

@app.post("/api/self/patch")
async def self_patch(data: PatchRequest, authorized: bool = Depends(verify_admin_token)):
    """
    Analyse, valide la syntaxe, crée un backup et installe le nouveau code sur le PC 
    de manière totalement sécurisée avec authentification par header et restriction de fichiers.
    """
    # 1. Vérification stricte des fichiers autorisés
    filename = os.path.basename(data.file_path)
    if filename not in ALLOWED_FILES:
        raise HTTPException(status_code=403, detail=f"Modification interdite pour le fichier : {filename}")

    # 2. Validation de la syntaxe Python
    try:
        ast.parse(data.content)
    except SyntaxError as e:
        raise HTTPException(status_code=400, detail=f"Code invalide (Ligne {e.lineno}): {e.msg}")

    # 3. Vérification du chemin et sécurisation contre le path traversal
    target_path = os.path.abspath(os.path.join(os.getcwd(), data.file_path))
    if not target_path.startswith(os.getcwd()):
        raise HTTPException(status_code=400, detail="Chemin de fichier interdit")

    # 4. Sauvegarde de sécurité (.bak)
    if os.path.exists(target_path):
        shutil.copy2(target_path, os.path.join(BACKUP_DIR, f"{filename}.bak"))

    # 5. Écriture du nouveau code
    try:
        with open(target_path, "w", encoding="utf-8") as f:
            f.write(data.content)
        print(f"[SIRIUS SELF-PATCH] Le fichier {data.file_path} a été mis à jour et sécurisé avec succès !")
        return {"status": "success", "message": f"Module {data.file_path} patché, validé et protégé par token admin !"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur d'écriture : {str(e)}")
# =========================================================
# ROUTES ET INCLUSION DU ROUTEUR API SIRIUS
# =========================================================

@api_router.post("/self/reload")
async def self_reload(background_tasks: BackgroundTasks):
    """
    Redémarre le processus backend de Sirius pour appliquer les modifications à chaud.
    """
    def restart_process():
        time.sleep(1)
        python = sys.executable
        os.execl(python, python, *sys.argv)

    background_tasks.add_task(restart_process)
    return {"status": "reloading", "message": "Redémarrage de Sirius en cours..."}


# Route WebSocket sur le routeur /api
from fastapi import WebSocket, WebSocketDisconnect

@api_router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except (TypeError, ValueError):
                data = {}
            action = data.get("action") if isinstance(data, dict) else None

            if action == "open_app":
                await websocket.send_json({
                    "action": "open_app",
                    "app": data["app"],
                    "display": data["display"]
                })
            else:
                await websocket.send_text(json.dumps({"status": "connected", "message": "Sirius WS actif"}))
    except WebSocketDisconnect:
        logger.info("Client Sirius déconnecté du WebSocket")


# Expose aussi le WebSocket sur la racine /ws (compatibilité frontend)
@app.websocket("/ws")
async def websocket_root(websocket: WebSocket):
    # Délègue au même gestionnaire que /api/ws
    await websocket_endpoint(websocket)


# =========================================================
# HANDLER PREFLIGHT CORS (OPTIONS) ET ROUTES INSTALLATION
# =========================================================

@api_router.get("/health")
@api_router.get("/install/step")
async def health_check():
    return {
        "step": "environment",
        "status": "success",
        "message": "Environnement SIRIUS opérationnel.",
        "next": "keys"
    }

@api_router.post("/install/step")
async def process_install_step(request: Request):
    return {
        "step": "environment",
        "status": "success",
        "message": "Validation environnement réussie.",
        "next": "keys"
    }

# =========================================================
# CONFIGURATION CORS UNIFIÉE (dev local + production)
# =========================================================
_DEFAULT_DEV_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
_cors_env = os.environ.get('CORS_ORIGINS', '').strip()
_extra_origins = (
    [o.strip() for o in _cors_env.split(',') if o.strip()]
    if _cors_env and _cors_env != '*' else []
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(dict.fromkeys(_DEFAULT_DEV_ORIGINS + _extra_origins)),
    allow_origin_regex=r"https://([a-z0-9-]+\.)*(emergentagent\.com|emergent\.host)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rattachement final du routeur /api à l'application (une seule fois, après les middlewares)
app.include_router(api_router)

# Import et inclusion explicite des routers de compatibilité
import routers.modules as modules_mod
app.include_router(modules_mod.router)
if hasattr(modules_mod, 'setup'):
    modules_mod.setup(db)
logger.info("Included routers.modules")

import routers.personnages as personnages_mod
app.include_router(personnages_mod.router)
if hasattr(personnages_mod, 'setup'):
    personnages_mod.setup(db)
logger.info("Included routers.personnages")

import routers.tasks as tasks_mod
app.include_router(tasks_mod.router)
if hasattr(tasks_mod, 'setup'):
    tasks_mod.setup(db)
logger.info("Included routers.tasks")

import routers.ws as ws_mod
app.include_router(ws_mod.router)
if hasattr(ws_mod, 'setup'):
    ws_mod.setup(db)
logger.info("Included routers.ws")

import routers.chat as chat_mod
app.include_router(chat_mod.router)
if hasattr(chat_mod, 'setup'):
    chat_mod.setup(db)
logger.info("Included routers.chat")

import routers.files as files_mod
app.include_router(files_mod.router)
if hasattr(files_mod, 'setup'):
    files_mod.setup(db)
logger.info("Included routers.files")

import routers.tts as tts_mod
app.include_router(tts_mod.router)
if hasattr(tts_mod, 'setup'):
    tts_mod.setup(db)
logger.info("Included routers.tts")

import routers.stt as stt_mod
app.include_router(stt_mod.router)
if hasattr(stt_mod, 'setup'):
    stt_mod.setup(db)
logger.info("Included routers.stt")

# =========================================================
# SERVIR LE FRONTEND REACT (PRODUCTION)
# =========================================================
BUILD_DIR = FRONTEND_DIR / "build"
PUBLIC_DIR = FRONTEND_DIR / "public"
HOLO_DIR = PUBLIC_DIR / "holo"
STATIC_DIR = ROOT_DIR / "static"

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
if (BUILD_DIR / "static").exists():
    app.mount("/build-static", StaticFiles(directory=str(BUILD_DIR / "static")), name="build_static")
if HOLO_DIR.exists():
    app.mount("/holo", StaticFiles(directory=str(HOLO_DIR)), name="holo")

@app.get("/{full_path:path}")
async def serve_react_app(full_path: str):
    # Laisse passer les routes /api/ en 404 classique si elles n'existent pas
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Endpoint API non trouvé")
        
    requested_file = BUILD_DIR / full_path
    if full_path != "" and requested_file.exists() and requested_file.is_file():
        return FileResponse(str(requested_file))
        
    index_file = BUILD_DIR / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
        
    raise HTTPException(status_code=404, detail="Fichier index.html introuvable dans le build.")

# =========================================================
# DÉMARRAGE DU SERVEUR
# =========================================================
if __name__ == "__main__":
    import uvicorn
    # En désactivant reload=True en production, le CPU va redescendre instantanément à 1-5%
    uvicorn.run("server:app", host="0.0.0.0", port=8001, reload=False)

import os

def ecrire_fichier_securise(nom_fichier, contenu):
    # On définit un dossier sécurisé pour les fichiers de Sirius
    dossier = "sandbox"
    
    # Si le dossier n'existe pas, on le crée
    if not os.path.exists(dossier):
        os.makedirs(dossier)
        
    # Chemin complet du fichier
    chemin_complet = os.path.join(dossier, nom_fichier)
    
    # On écrit le contenu dedans
    with open(chemin_complet, "w", encoding="utf-8") as f:
        f.write(contenu)
        
    return f"Fichier {nom_fichier} bien enregistré dans {dossier} !"