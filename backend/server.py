# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).

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
import importlib
import secrets
import hmac
import binascii
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from dotenv import load_dotenv
from pydantic import BaseModel, Field, ConfigDict

from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, Request, Depends, Header, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from starlette.types import ASGIApp, Scope, Receive, Send
from runtime_paths import SOURCE_DIR, data_dir, project_dir

# 1. Chargement des variables d'environnement
ROOT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = project_dir()
FRONTEND_DIR = PROJECT_DIR / "frontend"
load_dotenv(ROOT_DIR / '.env')
DATA_DIR = data_dir()
if DATA_DIR != ROOT_DIR:
    load_dotenv(DATA_DIR / ".env", override=True)

from sirius_brain import (
    ask_sirius,
    parse_intent,
    enrich_briefing,
    hn_bulletin,
    doc_narrative,
    k3_source,
    detect_autonomous_action,
    detect_urgency,
    technical_video_comment,
)

# 2. Configuration des logs
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

_FACT_MAX_AGE_DAYS = 90
_EPISODE_POOL = 5    # how many recent episodes to fetch
_EPISODE_TOP  = 3    # how many to inject after thematic reranking


def _score_episodes(prompt: str, episodes: list, top_k: int = _EPISODE_TOP) -> list:
    """Return top_k episodes most relevant to prompt by keyword overlap (no LLM)."""
    words = {w for w in re.sub(r"[^\w\s]", "", prompt.lower()).split() if len(w) > 3}
    scored = []
    for ep in episodes:
        text = (ep.get("summary") or "").lower()
        overlap = sum(1 for w in words if w in text)
        scored.append((overlap, ep))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [ep for _, ep in scored[:top_k]]


async def _gather_memory_context(texte: str, uid: str, extra_memory: list) -> list:
    """Construit le contexte mémoire (faits + épisodes) à injecter dans le prompt.

    Les deux branches (faits sémantiques, épisodes condensés) sont indépendantes l'une de
    l'autre : exécutées en parallèle via asyncio.gather plutôt qu'en série, elles se recouvrent
    dans le temps au lieu de s'additionner — gain de latence avant même l'appel au cerveau.
    """
    async def _facts():
        try:
            facts = recall_facts(texte, user_id=uid, limit=16)
            # Cerveau vectoriel : cherche dans TOUS les souvenirs vectorisés (par le sens),
            # fusionnés avec les candidats mots-clés — vecteurs pré-calculés, rappel instantané.
            from semantic_vectors import semantic_recall
            facts = await semantic_recall(texte, facts, user_id=uid, top_k=8)
        except Exception:
            facts = recall_facts(texte, user_id=uid, limit=8)
        fact_cutoff = (datetime.now(timezone.utc) - timedelta(days=_FACT_MAX_AGE_DAYS)).date().isoformat()
        # Les préférences (identité, goûts durables) ne s'effacent jamais par simple ancienneté —
        # seuls les faits liés à un projet ou un souvenir ponctuel expirent après _FACT_MAX_AGE_DAYS.
        return [
            f for f in facts
            if f.get("category") == "preference" or not f.get("created_at") or f["created_at"][:10] >= fact_cutoff
        ]

    async def _episodes():
        try:
            return _score_episodes(texte, recent_episodes(uid, limit=_EPISODE_POOL))
        except Exception:
            return []

    local_facts, episodes = await asyncio.gather(_facts(), _episodes())
    return (extra_memory or []) + [
        {"t": f["text"], "c": f.get("category") or "", "d": (f.get("created_at") or "")[:10]}
        for f in local_facts
    ] + [
        {"t": e["summary"], "c": "épisode", "d": (e.get("created_at") or "")[:10]}
        for e in episodes
    ]

# =========================================================
# INITIALISATION UNIQUE DE L'APPLICATION ET INTERCEPTATION OPTIONS
# =========================================================

_watch_task = None
_omega_task = None
_episodic_task = None
_vector_task = None


@asynccontextmanager
async def _lifespan(_app):
    # --- Démarrage ---
    global _watch_task, _omega_task, _episodic_task, _vector_task
    # Base documentaire : MongoDB si joignable, sinon docstore SQLite local.
    await _select_database_backend()
    _watch_task = asyncio.create_task(_push_watch_loop())
    _omega_task = asyncio.create_task(_omega_watch_loop())
    # Mémoire épisodique : condensation des conversations pendant les temps morts.
    from episodic import episodic_loop
    from sirius_brain import summarize_episode
    _episodic_task = asyncio.create_task(episodic_loop(db, summarize_episode))
    # Cerveau vectoriel : pré-vectorisation des souvenirs en tâche de fond.
    from semantic_vectors import vector_warmup_loop
    _vector_task = asyncio.create_task(vector_warmup_loop())
    from auth_api import seed_admin_and_indexes
    try:
        await seed_admin_and_indexes(db)
        logger.info("[AUTH] Index et compte admin prêts")
    except Exception as e:
        logger.error(f"[AUTH] Init échouée: {e}")
    # (Stockage 100% local — plus d'initialisation cloud à faire ici.)
    try:
        yield
    finally:
        # --- Arrêt ---
        tasks = []
        for task in (_watch_task, _omega_task, _episodic_task, _vector_task):
            if task:
                task.cancel()
                tasks.append(task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        client.close()


app = FastAPI(title="Sirius Backend API", version="1.0.0", lifespan=_lifespan)

# Imports des modules Sirius
from storage import put_object, get_object, APP_NAME
from local_memory import list_facts, add_fact, delete_fact, update_fact, log_event, prime_overview, log_service, list_service_log, recall_facts, learn_fact, recent_episodes
from auth_api import is_direct_local_request, resolve_user_id, require_user  # noqa: E402
from omega_engine import OmegaEngine  # noqa: E402

# 5. Connexion base documentaire : MongoDB si disponible, sinon SQLite local.
# SIRIUS_DB=mongo force MongoDB ; SIRIUS_DB=local force le docstore SQLite ;
# sinon un ping au démarrage choisit automatiquement (voir _lifespan).
from local_docstore import DatabaseRouter, LocalDocStore  # noqa: E402
mongo_url = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
db_name = os.environ.get('DB_NAME', 'sirius_db')
_DB_MODE = (os.getenv("SIRIUS_DB") or "").strip().lower()
client = AsyncIOMotorClient(mongo_url, serverSelectionTimeoutMS=1500)
if _DB_MODE == "local":
    db = DatabaseRouter(LocalDocStore())
else:
    db = DatabaseRouter(client[db_name])


async def _select_database_backend():
    """Bascule sur le docstore SQLite local si MongoDB est injoignable."""
    if _DB_MODE == "local":
        logger.info("[DB] Docstore SQLite local (forcé par SIRIUS_DB=local)")
        return
    try:
        await asyncio.wait_for(client.admin.command("ping"), timeout=2.0)
        logger.info("[DB] MongoDB détecté : %s", mongo_url)
    except Exception:
        if _DB_MODE == "mongo":
            logger.error("[DB] SIRIUS_DB=mongo mais MongoDB est injoignable : %s", mongo_url)
            return
        db.use(LocalDocStore())
        logger.info("[DB] MongoDB absent → docstore SQLite local (aucun serveur requis)")

# 6. Initialisation du routeur principal pour /api
api_router = APIRouter(prefix="/api")
omega = OmegaEngine(PROJECT_DIR)
SELF_PATCH_ENABLED = os.getenv("SIRIUS_ENABLE_SELF_PATCH", "").strip() == "1"
ADMIN_TOKEN = (os.getenv("SIRIUS_ADMIN_TOKEN") or "").strip()
def _require_local_control(request: Request) -> None:
    if not is_direct_local_request(request):
        raise HTTPException(status_code=403, detail="Contrôle Omega réservé à la machine locale.")


def _admin_token_matches(candidate: str | None) -> bool:
    return bool(
        ADMIN_TOKEN
        and candidate
        and hmac.compare_digest(candidate.encode("utf-8"), ADMIN_TOKEN.encode("utf-8"))
    )

@app.get("/health")
async def health_check():
    """Sonde de santé agrégée : liveness + état DB, tâches de fond et clés présentes.

    N'expose jamais de valeur de secret — uniquement des booléens de présence.
    """
    checks = {}

    checks["database"] = db.backend_name
    if db.backend_name == "mongodb":
        try:
            await asyncio.wait_for(client.admin.command("ping"), timeout=2.0)
            checks["mongo"] = "ok"
        except Exception:
            checks["mongo"] = "down"
    else:
        checks["mongo"] = "unused"

    checks["push_watch"] = "running" if (_watch_task and not _watch_task.done()) else "stopped"
    checks["omega_watch"] = "running" if (_omega_task and not _omega_task.done()) else "stopped"

    keys = {
        "llm": bool(os.getenv("GROQ_API_KEY") or os.getenv("K3_API_KEY") or os.getenv("DANIEL_DEV_K3") or os.getenv("GEMINI_API_KEY")),
        "serpapi": bool(os.getenv("SERP_API_KEY")),
        "spotify": bool(os.getenv("SPOTIFY_CLIENT_ID")),
    }

    try:
        from push_notifications import subscriber_count
        subscribers = subscriber_count()
    except Exception:
        subscribers = None

    from resilience import breakers_snapshot

    overall = "ok" if checks["mongo"] == "ok" else "degraded"
    return {
        "status": overall,
        "service": "sirius-backend",
        "checks": checks,
        "keys": keys,
        "breakers": breakers_snapshot(),
        "push_subscribers": subscribers,
    }

# Routes extraites vers routes/ : supervision (argus/omega), suggestions proactives,
# mémoire locale/prime, stubs atlas/heracles — rattachées plus bas via make_*_router().

# Define Models
class StatusCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")  # Ignore MongoDB's _id field
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StatusCheckCreate(BaseModel):
    client_name: str

# ---- Cerveau intelligent ΣIRIUS (Kimi K3 + recherche web) ----
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
_RATE: dict[str, deque[float]] = {}

def _rate_ok(ip: str, limit: int = 30, window: int = 60) -> bool:
    now = time.monotonic()
    q = _RATE.setdefault(ip, deque())
    cutoff = now - window
    while q and q[0] <= cutoff:
        q.popleft()
    if len(q) >= limit:
        return False
    q.append(now)
    return True

class IntentRequest(BaseModel):
    text: str

@api_router.post("/intent")
async def ui_intent(req: IntentRequest, request: Request):
    """Compréhension naturelle d'une commande vocale → intention UI structurée (Groq)."""
    await require_user(request, db)

    ip = request.client.host if request.client else "?"
    if not _rate_ok(ip, limit=60, window=60):
        logger.warning("Intent rate limit exceeded", extra={"client_ip": ip})
        return {"action": "none"}

    result = await parse_intent((req.text or "").strip())
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
    autonomous_action = detect_autonomous_action(texte)

    # Historique de la session (8 derniers échanges)
    doc = await db.sirius_chats.find_one({"session_id": session_id}, {"_id": 0, "history": 1})
    history = (doc or {}).get("history", [])

    # Mémoire locale (faits + épisodes condensés), rappel par pertinence sémantique/mots-clés —
    # les deux branches sont récupérées en parallèle (voir _gather_memory_context).
    merged_memory = await _gather_memory_context(texte, uid, req.memory)
    logger.info(f"[CHAT] Début génération - Mode reçu: '{req.ia_mode}' | Mode appliqué: '{mode_ia_effectif}'")

    # Urgence détectée dans le texte (« vite », « urgent »...) → bascule automatique en mode
    # turbo, sans que l'utilisateur ait à activer explicitement ce mode.
    effective_mode = "turbo" if detect_urgency(texte) else (req.mode or "normal")

    try:
        t0 = time.perf_counter()
        if autonomous_action:
            answer = autonomous_action["technical_comment"]
            memories = []
            popups = []
        else:
            # ⚡ Appel direct à ask_sirius (cerveau unique)
            result = await ask_sirius(
                prompt=texte,
                history=history,
                profile=req.profile or {},
                memory=merged_memory,
                mode=effective_mode,
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

    # Persistance des nouveaux souvenirs dans la base locale (entre les sessions),
    # avec classement automatique en preference / projet / souvenir.
    for m in memories:
        try:
            learn_fact(m, user_id=uid)
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
        "action": autonomous_action,
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
    merged_memory = await _gather_memory_context(texte, uid, req.memory)
    autonomous_action = detect_autonomous_action(texte)
    effective_mode = "turbo" if detect_urgency(texte) else (req.mode or "normal")

    async def gen():
        t0 = time.perf_counter()
        try:
            if autonomous_action:
                answer = autonomous_action["technical_comment"]
                yield f"data: {json.dumps({'type': 'delta', 'text': answer}, ensure_ascii=False)}\n\n"
            else:
                from sirius_brain import ask_sirius_stream
                parts = []
                async for delta in ask_sirius_stream(
                    prompt=texte,
                    history=history,
                    profile=req.profile or {},
                    memory=merged_memory,
                    mode=effective_mode,
                    keys=req.keys or {},
                    mood=req.mood or {}
                ):
                    parts.append(delta)
                    yield f"data: {json.dumps({'type': 'delta', 'text': delta}, ensure_ascii=False)}\n\n"
                answer = "".join(parts).strip()

            brain_ms = int((time.perf_counter() - t0) * 1000)

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

            # Apprentissage automatique différé : n'ajoute AUCUNE latence à la réponse déjà
            # restituée (voix + affichage) — s'exécute en tâche de fond après coup.
            if not autonomous_action:
                async def _learn_later():
                    try:
                        from sirius_brain import extract_memory_background
                        for m in await extract_memory_background(texte, answer):
                            try:
                                learn_fact(m, user_id=uid)
                            except Exception as e:
                                logger.error(f"[LOCAL-MEM] Persistance échouée: {e}")
                    except Exception as e:
                        logger.warning(f"[LOCAL-MEM] Extraction différée échouée: {e}")
                asyncio.create_task(_learn_later())

            ev = {
                "type": "done",
                "answer": answer,
                "response": answer,
                "text": answer,
                "memories": [],
                "popups": [],
                "action": autonomous_action,
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
    # Sécurité : auto-patch désactivé par défaut (RCE si exposé). Exige explicitement
    # le flag d'activation, une requête locale directe et une session authentifiée.
    if not SELF_PATCH_ENABLED:
        raise HTTPException(status_code=403, detail="Auto-patch désactivé (SIRIUS_ENABLE_SELF_PATCH).")
    _require_local_control(request)
    await require_user(request, db)

    data = await request.json()
    file_path = data.get("file_path") # Ex: "server.py"
    new_content = data.get("content")

    if not isinstance(new_content, str):
        raise HTTPException(status_code=400, detail="Contenu invalide.")

    # Sécurité : On ne touche qu'aux fichiers autorisés, résolus sous le dossier backend.
    if file_path not in ("server.py", "sirius_brain.py"):
        raise HTTPException(status_code=403, detail="Fichier non autorisé à la modification.")
    target = (SOURCE_DIR / file_path).resolve()
    if target.parent != SOURCE_DIR or not target.exists():
        raise HTTPException(status_code=403, detail="Fichier non autorisé à la modification.")
    file_path = str(target)

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
        "label": "Cerveau ΣIRIUS",
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
        },
    }


@api_router.post("/keys/check")
async def keys_check_post(request: KeysCheckRequest):
    """Checks browser and server key availability without returning secret values."""
    return _keys_check_response(request.keys)


# =========================================================
# ROUTE DE LECTURE AUTONOME POUR ΣIRIUS
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

# ---- Médiathèque : fichiers & médias (stockage disque local) ----
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
    """Analyse IA d'un fichier déposé dans le ΣIRIUS DISPLAY (non stocké) + phrase à prononcer."""
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
    """Question vocale contextuelle sur le fichier actuellement affiché dans le ΣIRIUS DISPLAY."""
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
    """ΣIRIUS Voyant : capture caméra → description IA + OCR + synthèse vocale courte."""
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
    """ΣIRIUS Web Agent : navigateur invisible → recherche/action web + capture sauvegardée en Médiathèque."""
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

# ---- Archives ΣIRIUS : médiathèque automatique des créations ----
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

# Spotify (OAuth, lecture, recherche) : extrait vers routes/spotify_routes.py

# ---- Mémoire locale SQLite & ΣIRIUS PRIME : extraits vers routes/memory_routes.py ----

# ZEUS CORTEX / ORACLE DIVIN / PANTHEON : extraits vers routes/pantheon_oracle.py
# Infos externes (news, météo, pays, technews, documentaire, europeana) : extraits vers routes/infos.py
from routes.infos import NEWS_API_KEY, _fetch_headlines  # noqa: E402 (utilisés par oracle et veille push)

# ---- ΣIRIUS WebBrowser : ouverture + analyse technique de pages web ----
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

# ---- Rendu ΣIRIUS pour YouTube : grille de vidéos + lecteur embed officiel (fiable en iframe) ----
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
<div class="bar"><b>YOUTUBE · ΣIRIUS</b>
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

# ---- Fenêtres de tâches ΣIRIUS : génération d'images (Nano Banana) et clips (fal.ai) ----
FAL_VIDEO_MODEL = "fal-ai/ltx-2/text-to-video/fast"
_FAL_CLIENT_PACKAGE = "fal_client==1.0.0"
_FAL_INSTALL_LOCK = asyncio.Lock()
_VIDEO_MATERIALIZATION_LOCK = asyncio.Lock()
_VIDEO_OUTPUT_DIR = DATA_DIR / "generated-videos"
_VIDEO_MAX_BYTES = 250 * 1048576
_VIDEO_MIME_EXTENSIONS = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
}
_VIDEO_RESULT_CACHE = {}

class TaskImageRequest(BaseModel):
    prompt: str
    reference_image: Optional[str] = Field(default=None, max_length=14_000_000)
    reference_mime: Optional[str] = Field(default=None, max_length=64)

class TaskVideoRequest(BaseModel):
    prompt: str
    keys: dict = {}
    duration: int = 6


async def _ensure_fal_client():
    try:
        return importlib.import_module("fal_client"), False
    except ModuleNotFoundError as error:
        if error.name != "fal_client":
            raise

    installation_allowed = os.getenv("SIRIUS_ALLOW_RUNTIME_MODULE_INSTALL", "1").strip().lower()
    if installation_allowed in {"0", "false", "no"}:
        raise RuntimeError("Installation dynamique du client fal.ai désactivée")

    async with _FAL_INSTALL_LOCK:
        try:
            return importlib.import_module("fal_client"), False
        except ModuleNotFoundError as error:
            if error.name != "fal_client":
                raise

        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-input",
                _FAL_CLIENT_PACKAGE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as error:
            raise RuntimeError("Installation du client fal.ai impossible") from error

        try:
            await asyncio.wait_for(process.communicate(), timeout=120)
        except asyncio.TimeoutError as error:
            process.kill()
            await process.wait()
            raise RuntimeError("Installation du client fal.ai expirée") from error

        if process.returncode != 0:
            logger.error("[TASK VIDEO] installation fal_client échouée: code=%s", process.returncode)
            raise RuntimeError("Installation du client fal.ai échouée")

        importlib.invalidate_caches()
        try:
            return importlib.import_module("fal_client"), True
        except ModuleNotFoundError as error:
            raise RuntimeError("Client fal.ai indisponible après installation") from error


async def _fal_setup(keys: dict):
    fal_key = (keys or {}).get("fal") or os.environ.get("FAL_KEY")
    if not fal_key:
        raise HTTPException(status_code=400, detail="Clé fal.ai manquante")
    os.environ["FAL_KEY"] = fal_key
    try:
        return await _ensure_fal_client()
    except RuntimeError as error:
        logger.error("[TASK VIDEO] activation fal.ai impossible: %s", error)
        raise HTTPException(status_code=503, detail="Client fal.ai indisponible") from error


def _video_mime(source_url: str, content_type: str) -> str:
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    if mime in _VIDEO_MIME_EXTENSIONS:
        return mime
    source_path = source_url.split("?", 1)[0].lower()
    for known_mime, extension in _VIDEO_MIME_EXTENSIONS.items():
        if source_path.endswith(f".{extension}"):
            return known_mime
    return ""


async def _materialize_video_result(source_url: str):
    if not source_url.lower().startswith("https://"):
        raise HTTPException(status_code=502, detail="URL vidéo fal.ai invalide")

    import httpx

    _VIDEO_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    temporary_path = _VIDEO_OUTPUT_DIR / f".{uuid.uuid4().hex}.part"
    try:
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            async with client.stream("GET", source_url) as response:
                response.raise_for_status()
                declared_size = response.headers.get("content-length", "")
                if declared_size.isdecimal() and int(declared_size) > _VIDEO_MAX_BYTES:
                    raise HTTPException(status_code=413, detail="Vidéo générée trop volumineuse")
                mime = _video_mime(source_url, response.headers.get("content-type", ""))
                if not mime:
                    raise HTTPException(status_code=502, detail="Format vidéo fal.ai non exploitable")
                size = 0
                with temporary_path.open("wb") as output:
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > _VIDEO_MAX_BYTES:
                            raise HTTPException(status_code=413, detail="Vidéo générée trop volumineuse")
                        output.write(chunk)
        if size == 0:
            raise HTTPException(status_code=502, detail="Vidéo fal.ai vide")
        filename = f"{uuid.uuid4().hex}.{_VIDEO_MIME_EXTENSIONS[mime]}"
        destination_path = _VIDEO_OUTPUT_DIR / filename
        temporary_path.replace(destination_path)
        return {"filename": filename, "mime": mime, "size": size}
    except httpx.HTTPError as error:
        logger.error("[TASK VIDEO] téléchargement du rendu impossible: %s", error)
        raise HTTPException(status_code=502, detail="Téléchargement de la vidéo fal.ai impossible") from error
    except OSError as error:
        logger.error("[TASK VIDEO] écriture du rendu impossible: %s", error)
        raise HTTPException(status_code=502, detail="Enregistrement de la vidéo impossible") from error
    finally:
        if temporary_path.exists():
            temporary_path.unlink(missing_ok=True)


async def _displayable_video_result(request_id: str, source_url: str, request: Request):
    cached = _VIDEO_RESULT_CACHE.get(request_id)
    if cached and (_VIDEO_OUTPUT_DIR / cached["filename"]).is_file():
        return cached

    async with _VIDEO_MATERIALIZATION_LOCK:
        cached = _VIDEO_RESULT_CACHE.get(request_id)
        if cached and (_VIDEO_OUTPUT_DIR / cached["filename"]).is_file():
            return cached
        artifact = await _materialize_video_result(source_url)
        video_url = f"{str(request.base_url).rstrip('/')}/static/generated-videos/{artifact['filename']}"
        cached = {
            **artifact,
            "video_url": video_url,
            "display_url": video_url,
        }
        _VIDEO_RESULT_CACHE[request_id] = cached
        return cached

@api_router.post("/task/image")
async def task_image(req: TaskImageRequest):
    prompt = (req.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt vide")
    input_parts: list = [{"type": "text", "text": prompt}]
    if req.reference_image:
        allowed_mimes = {"image/jpeg", "image/png", "image/webp"}
        reference_mime = (req.reference_mime or "").lower().strip()
        if reference_mime not in allowed_mimes:
            raise HTTPException(status_code=400, detail="Format de référence non accepté (PNG, JPEG ou WebP uniquement).")
        try:
            decoded_reference = _b64.b64decode(req.reference_image, validate=True)
        except (ValueError, binascii.Error) as error:
            raise HTTPException(status_code=400, detail="Image de référence invalide.") from error
        if not decoded_reference:
            raise HTTPException(status_code=400, detail="Image de référence vide.")
        if len(decoded_reference) > 10 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Image de référence trop volumineuse (10 Mo maximum).")
        signatures = {
            "image/png": decoded_reference.startswith(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg": decoded_reference.startswith(b"\xff\xd8\xff"),
            "image/webp": (
                decoded_reference.startswith(b"RIFF")
                and len(decoded_reference) >= 12
                and decoded_reference[8:12] == b"WEBP"
            ),
        }
        if not signatures[reference_mime]:
            raise HTTPException(status_code=400, detail="Le contenu ne correspond pas au format d'image annoncé.")
        input_parts.append({
            "type": "image",
            "mime_type": reference_mime,
            "data": req.reference_image,
        })

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Clé Gemini absente")
    from google import genai
    client = genai.Client(api_key=api_key)
    try:
        interaction = await client.aio.interactions.create(
            model="gemini-3.1-flash-image",
            input=input_parts,
        )
    except Exception as e:
        logger.error(f"[TASK IMAGE] {e}")
        raise HTTPException(status_code=502, detail="Moteur de rendu indisponible")
    output_image = getattr(interaction, "output_image", None)
    if output_image is None and isinstance(interaction, dict):
        output_image = interaction.get("output_image")
    if output_image is None:
        raise HTTPException(status_code=502, detail="Aucune image produite")
    image_data = getattr(output_image, "data", None)
    if image_data is None and isinstance(output_image, dict):
        image_data = output_image.get("data")
    image_mime = getattr(output_image, "mime_type", None)
    if image_mime is None and isinstance(output_image, dict):
        image_mime = output_image.get("mime_type")
    if not image_data:
        raise HTTPException(status_code=502, detail="Aucune image produite")
    text = getattr(interaction, "output_text", None) or ""
    return {"image": image_data, "mime": image_mime or "image/png", "texte": text[:300]}

@api_router.post("/task/video/start")
async def task_video_start(req: TaskVideoRequest):
    prompt = (req.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt vide")
    fal_client, module_installed = await _fal_setup(req.keys)
    try:
        handler = await fal_client.submit_async(FAL_VIDEO_MODEL, arguments={"prompt": prompt})
    except Exception as e:
        msg = str(e).lower()
        logger.error(f"[TASK VIDEO] start: {e}")
        if "balance" in msg or "locked" in msg:
            raise HTTPException(status_code=402, detail="Solde fal.ai épuisé — rechargez votre compte sur fal.ai/dashboard/billing")
        raise HTTPException(status_code=502, detail="Pipeline vidéo indisponible (vérifiez votre clé fal.ai)")
    return {
        "request_id": handler.request_id,
        "etat": "en_cours",
        "module_installed": module_installed,
        "technical_comment": technical_video_comment("activation"),
    }

@api_router.post("/task/video/status/{request_id}")
async def task_video_status(request_id: str, req: TaskVideoRequest, request: Request):
    fal_client, _ = await _fal_setup(req.keys)
    try:
        status = await fal_client.status_async(FAL_VIDEO_MODEL, request_id, with_logs=False)
        if isinstance(status, fal_client.Completed):
            result = await fal_client.result_async(FAL_VIDEO_MODEL, request_id)
            url = ((result or {}).get("video") or {}).get("url") or ""
            if not url:
                raise HTTPException(status_code=502, detail="Vidéo introuvable dans le résultat")
            artifact = await _displayable_video_result(request_id, url, request)
            return {
                "etat": "termine",
                **artifact,
                "technical_comment": technical_video_comment("materialization"),
                "display_comment": technical_video_comment("display"),
            }
        if isinstance(status, fal_client.InProgress):
            return {"etat": "en_cours", "technical_comment": technical_video_comment("activation")}
        return {"etat": "attente", "technical_comment": technical_video_comment("activation")}
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

# TTS / STT / téléchargement d'archives : extraits vers routes/voice_io.py

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

# PLANS# : plans 2D cotés (style architecte) + export DXF AutoCAD
from floorplan import make_floorplan_router
api_router.include_router(make_floorplan_router(_rate_ok))

# PHOTO3D# : reconstruction 3D locale à partir d'une série de photos
from photo3d import make_photo3d_router
api_router.include_router(make_photo3d_router(_rate_ok, db))

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

from media_routes import make_media_router
api_router.include_router(make_media_router(db))

from productivite.routes_productivite import make_productivity_router
api_router.include_router(make_productivity_router(db))
# HÉPHAÏSTOS (diagnostic) + statut des clés : extraits vers routes/hephaistos.py

from push_notifications import make_push_router  # noqa: E402
api_router.include_router(make_push_router())

# ---- Routes extraites de server.py (découpe progressive) ----
from routes.supervision import make_supervision_router  # noqa: E402
from routes.proactive_routes import make_proactive_router  # noqa: E402
from routes.memory_routes import make_memory_router  # noqa: E402
from routes.atlas_heracles import make_stub_router  # noqa: E402
from routes.spotify_routes import make_spotify_router  # noqa: E402
from routes.infos import make_infos_router  # noqa: E402
from routes.pantheon_oracle import make_pantheon_oracle_router  # noqa: E402
from routes.voice_io import make_voice_io_router  # noqa: E402
from routes.hephaistos import make_hephaistos_router  # noqa: E402
from routes.feedback import make_feedback_router  # noqa: E402
api_router.include_router(
    make_supervision_router(db, omega, require_user, _require_local_control, _admin_token_matches)
)
api_router.include_router(make_proactive_router(db, require_user))
api_router.include_router(make_memory_router(db, require_user, resolve_user_id))
api_router.include_router(make_stub_router())
api_router.include_router(make_spotify_router())
api_router.include_router(make_infos_router())
api_router.include_router(make_pantheon_oracle_router(db, _rate_ok))
api_router.include_router(make_voice_io_router())
api_router.include_router(make_hephaistos_router(db))
api_router.include_router(make_feedback_router())

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
                    send_push_to_all("ΣIRIUS — Veille active", titre)
                    sent_titles.append(titre)
                w["sent_titles"] = sent_titles[-60:]
                w["last_run"] = time.time()
                save_watch(w)
                if fresh:
                    logger.info(f"[VEILLE PUSH] {len(fresh[:2])} actu(s) envoyée(s)")
        except Exception as e:
            logger.error(f"[VEILLE PUSH] {repr(e)}")
        await asyncio.sleep(60)


async def _omega_watch_loop():
    while True:
        try:
            result = await asyncio.to_thread(omega.scan)
            anomalies = [
                error for error in result["errors"]
                if error.get("errorType") != "none"
            ]
            if anomalies:
                logger.warning("[OMEGA] %d anomalie(s) active(s)", len(anomalies))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[OMEGA] Échec du cycle de supervision")
        await asyncio.sleep(120)


# =========================================================
# MODULE AUTO-ÉVOLUTIF ΣIRIUS : MODIFICATION LOCALE CONTRÔLÉE
# =========================================================
class PatchRequest(BaseModel):
    file_path: str = Field(min_length=1, max_length=80)
    content: str = Field(min_length=1, max_length=2_000_000)


class RollbackRequest(BaseModel):
    backup: str = Field(min_length=1, max_length=160)


BACKUP_DIR = DATA_DIR / "backups"
ALLOWED_FILES = {
    "server.py": ROOT_DIR / "server.py",
    "sirius_brain.py": ROOT_DIR / "sirius_brain.py",
    "auth_api.py": ROOT_DIR / "auth_api.py",
}


def verify_admin_token_only(x_admin_token: str | None = Header(default=None)):
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="Jeton administrateur non configuré.")
    if not _admin_token_matches(x_admin_token):
        raise HTTPException(status_code=403, detail="Jeton administrateur invalide.")
    return True


def verify_admin_token(x_admin_token: str | None = Header(default=None)):
    if not SELF_PATCH_ENABLED:
        raise HTTPException(status_code=503, detail="Auto-évolution désactivée par configuration.")
    return verify_admin_token_only(x_admin_token)


@app.post("/api/self/patch")
async def self_patch(
    data: PatchRequest,
    request: Request,
    authorized: bool = Depends(verify_admin_token),
):
    _require_local_control(request)
    user = await require_user(request, db)
    if user.get("role") != "admin" or not authorized:
        raise HTTPException(status_code=403, detail="Droits administrateur requis.")
    if omega.scan()["engine"]["frozen"]:
        raise HTTPException(
            status_code=409,
            detail="Chemins critiques gelés : effectuer un rollback validé avant tout nouveau patch.",
        )

    filename = Path(data.file_path).name
    if data.file_path.replace("\\", "/") != filename or filename not in ALLOWED_FILES:
        raise HTTPException(status_code=403, detail="Fichier hors liste blanche.")

    try:
        ast.parse(data.content, filename=filename)
    except SyntaxError as error:
        raise HTTPException(
            status_code=400,
            detail=f"Code invalide (ligne {error.lineno}) : {error.msg}",
        ) from error

    target_path = ALLOWED_FILES[filename].resolve()
    if target_path.parent != ROOT_DIR:
        raise HTTPException(status_code=403, detail="Chemin de destination invalide.")

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup_path = BACKUP_DIR / f"{filename}.{int(time.time())}.{uuid.uuid4().hex[:8]}.bak"
    temp_path = ROOT_DIR / f".{filename}.{uuid.uuid4().hex}.omega.tmp"
    try:
        shutil.copy2(target_path, backup_path)
        with temp_path.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(data.content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, target_path)
    except OSError as error:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Échec de l'écriture atomique du correctif.") from error

    omega.accept_path(f"backend/{filename}")
    logger.warning("[OMEGA] Correctif administrateur appliqué à %s", filename)
    return {
        "status": "success",
        "message": f"Module {filename} validé, sauvegardé et remplacé atomiquement.",
        "backup": backup_path.name,
    }


@app.post("/api/self/rollback")
async def self_rollback(
    data: RollbackRequest,
    request: Request,
    authorized: bool = Depends(verify_admin_token_only),
):
    _require_local_control(request)
    user = await require_user(request, db)
    if user.get("role") != "admin" or not authorized:
        raise HTTPException(status_code=403, detail="Droits administrateur requis.")

    if Path(data.backup).name != data.backup:
        raise HTTPException(status_code=403, detail="Chemin de sauvegarde invalide.")
    pattern = r"^(server\.py|sirius_brain\.py|auth_api\.py)\.\d{9,12}\.[0-9a-f]{8}\.bak$"
    match = re.fullmatch(pattern, data.backup)
    if not match:
        raise HTTPException(status_code=403, detail="Sauvegarde hors format Omega.")

    filename = match.group(1)
    target_path = ALLOWED_FILES[filename].resolve()
    backup_root = BACKUP_DIR.resolve()
    backup_path = (BACKUP_DIR / data.backup).resolve()
    if backup_path.parent != backup_root or not backup_path.is_file():
        raise HTTPException(status_code=404, detail="Sauvegarde Omega introuvable.")

    try:
        restored_content = backup_path.read_text(encoding="utf-8")
        ast.parse(restored_content, filename=filename)
    except (OSError, UnicodeError, SyntaxError) as error:
        raise HTTPException(status_code=409, detail="Sauvegarde Omega invalide.") from error

    safety_backup = BACKUP_DIR / f"{filename}.{int(time.time())}.{uuid.uuid4().hex[:8]}.bak"
    temp_path = ROOT_DIR / f".{filename}.{uuid.uuid4().hex}.rollback.tmp"
    try:
        shutil.copy2(target_path, safety_backup)
        with temp_path.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(restored_content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, target_path)
    except OSError as error:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Échec de la restauration atomique.") from error

    omega.accept_path(f"backend/{filename}")
    post_rollback_scan = omega.scan()
    logger.warning("[OMEGA] Rollback administrateur appliqué à %s", filename)
    return {
        "status": "rolled_back",
        "message": f"Module {filename} restauré depuis une sauvegarde validée.",
        "restored_from": backup_path.name,
        "safety_backup": safety_backup.name,
        "frozen_paths": post_rollback_scan["engine"]["frozen_paths"],
    }
# =========================================================
# ROUTES ET INCLUSION DU ROUTEUR API ΣIRIUS
# =========================================================

@api_router.post("/self/reload")
async def self_reload(
    request: Request,
    authorized: bool = Depends(verify_admin_token),
):
    _require_local_control(request)
    user = await require_user(request, db)
    if user.get("role") != "admin" or not authorized:
        raise HTTPException(status_code=403, detail="Droits administrateur requis.")
    if omega.scan()["engine"]["frozen"]:
        raise HTTPException(status_code=409, detail="Redémarrage refusé tant que les chemins critiques sont gelés.")
    raise HTTPException(
        status_code=409,
        detail="Redémarrage automatique désactivé : redémarrer ΣIRIUS manuellement après vérification.",
    )


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

class InstallStepRequest(BaseModel):
    step: str = "environment"
    context: dict = Field(default_factory=dict)


_INSTALL_STEPS = {
    "environment": {
        "message": "Environnement ΣIRIUS opérationnel.",
        "next": "micro",
        "items": ("Interface locale", "Configuration backend", "Accès au stockage"),
    },
    "micro": {
        "message": "Micro et synthèse vocale prêts.",
        "next": "backend",
        "items": ("Reconnaissance vocale", "Synthèse vocale"),
    },
    "backend": {
        "message": "Backend ΣIRIUS connecté.",
        "next": "ia",
        "items": ("API FastAPI", "WebSocket ΣIRIUS"),
    },
    "ia": {
        "message": "Moteur IA initialisé.",
        "next": "hud",
        "items": ("Parseur d'intentions", "Modèles de secours"),
    },
    "hud": {
        "message": "HUD ΣIRIUS disponible.",
        "next": "modules",
        "items": ("Interface React", "Commandes vocales"),
    },
    "modules": {
        "message": "Modules ΣIRIUS chargés.",
        "next": "completed",
        "items": ("ORACLE", "ATLAS", "PANTHÉON"),
    },
    "completed": {
        "message": "Installation terminée. ΣIRIUS est prêt.",
        "next": None,
        "items": ("Système ΣIRIUS",),
    },
    "restart": {
        "message": "Assistant d'installation réinitialisé.",
        "next": "environment",
        "items": ("Pipeline d'installation",),
    },
}


def _install_step_response(step: str) -> dict:
    normalized_step = (step or "environment").strip().lower()
    config = _INSTALL_STEPS.get(normalized_step)
    if config is None:
        raise HTTPException(status_code=422, detail=f"Étape d'installation inconnue : {normalized_step}")

    return {
        "step": normalized_step,
        "status": "ok",
        "message": config["message"],
        "next": config["next"],
        "items": [{"label": label, "state": "ok"} for label in config["items"]],
    }


@api_router.get("/health")
async def api_health_check():
    return {"status": "ok"}


@api_router.get("/install/step")
async def get_install_step():
    return _install_step_response("environment")


@api_router.post("/install/step")
async def process_install_step(request: InstallStepRequest):
    return _install_step_response(request.step)

# =========================================================
# CONFIGURATION CORS UNIFIÉE (dev local + production)
# =========================================================
_DEFAULT_DEV_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    # Electron's packaged renderer is loaded from file:// and sends Origin: null.
    "null",
]
_cors_env = os.environ.get('CORS_ORIGINS', '').strip()
_extra_origins = (
    [o.strip() for o in _cors_env.split(',') if o.strip()]
    if _cors_env and _cors_env != '*' else []
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(dict.fromkeys(_DEFAULT_DEV_ORIGINS + _extra_origins)),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rattachement final du routeur /api à l'application (une seule fois, après les middlewares)
app.include_router(api_router)

# Catalogue public des plateformes multimedia. La route reste hors de /api pour
# conserver le contrat frontend /modules/media et fonctionner avec le proxy CRA.
from routes.media_modules import router as media_modules_router
app.include_router(media_modules_router)
logger.info("Included routes.media_modules")

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

GENERATED_VIDEO_DIR = DATA_DIR / "generated-videos"
GENERATED_VIDEO_DIR.mkdir(parents=True, exist_ok=True)
app.mount(
    "/static/generated-videos",
    StaticFiles(directory=str(GENERATED_VIDEO_DIR)),
    name="generated_videos",
)
if (BUILD_DIR / "static").exists():
    app.mount("/static", StaticFiles(directory=str(BUILD_DIR / "static")), name="frontend_static")
if STATIC_DIR.exists():
    app.mount("/backend-static", StaticFiles(directory=str(STATIC_DIR)), name="backend_static")
if HOLO_DIR.exists():
    app.mount("/holo", StaticFiles(directory=str(HOLO_DIR)), name="holo")

@app.api_route("/{full_path:path}", methods=["GET", "HEAD"])
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
    uvicorn.run(
        "server:app",
        host="127.0.0.1",
        port=8001,
        reload=False,
        proxy_headers=False,
    )

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