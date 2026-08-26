# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Stockage de fichiers SIRIUS — Emergent Object Storage avec repli disque local.

Cloud (EMERGENT_LLM_KEY présent) : stockage persistant Emergent.
Local (export Windows, pas de clé) : fichiers écrits dans backend/uploads/."""
import os
import logging
from pathlib import Path
import requests
from resilience import resilient_call_sync
from runtime_paths import data_dir

logger = logging.getLogger(__name__)

STORAGE_URL = "https://integrations.emergentagent.com/objstore/api/v1/storage"
EMERGENT_KEY = os.environ.get("EMERGENT_LLM_KEY")
APP_NAME = "sirius"
UPLOADS_DIR = data_dir() / "uploads"

_storage_key = None


def _safe_local_path(path: str) -> Path:
    """Résout `path` sous UPLOADS_DIR en rejetant toute évasion (../, chemin absolu)."""
    base = UPLOADS_DIR.resolve()
    candidate = (base / path).resolve()
    if candidate != base and base not in candidate.parents:
        raise ValueError(f"Chemin de stockage non autorisé : {path!r}")
    return candidate


def cloud_available() -> bool:
    return bool(EMERGENT_KEY)


def init_storage():
    """À appeler une seule fois : récupère la clé de session du stockage."""
    global _storage_key
    if _storage_key:
        return _storage_key

    def _init():
        resp = requests.post(f"{STORAGE_URL}/init", json={"emergent_key": EMERGENT_KEY}, timeout=30)
        resp.raise_for_status()
        return resp.json()["storage_key"]

    _storage_key = resilient_call_sync(
        _init, service="emergent-storage", retry_on=(requests.RequestException,)
    )
    return _storage_key


def put_object(path: str, data: bytes, content_type: str) -> dict:
    if not cloud_available():
        p = _safe_local_path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return {"path": path, "size": len(data)}
    key = init_storage()

    def _put():
        resp = requests.put(
            f"{STORAGE_URL}/objects/{path}",
            headers={"X-Storage-Key": key, "Content-Type": content_type},
            data=data, timeout=120,
        )
        resp.raise_for_status()
        return resp.json()

    return resilient_call_sync(
        _put, service="emergent-storage", retry_on=(requests.RequestException,)
    )


def get_object(path: str):
    """Retourne (bytes, content_type|None)."""
    global _storage_key
    if not cloud_available():
        p = _safe_local_path(path)
        if not p.exists():
            raise FileNotFoundError(path)
        return p.read_bytes(), None
    key = init_storage()

    def _get():
        global _storage_key
        resp = requests.get(f"{STORAGE_URL}/objects/{path}", headers={"X-Storage-Key": key}, timeout=60)
        if resp.status_code == 403:
            # Clé de session expirée : on la régénère une fois puis on rejoue l'appel.
            _storage_key = None
            fresh = init_storage()
            resp = requests.get(f"{STORAGE_URL}/objects/{path}", headers={"X-Storage-Key": fresh}, timeout=60)
        resp.raise_for_status()
        return resp.content, resp.headers.get("Content-Type")

    return resilient_call_sync(
        _get, service="emergent-storage", retry_on=(requests.RequestException,)
    )
