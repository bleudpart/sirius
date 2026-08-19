# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Stockage de fichiers SIRIUS — Emergent Object Storage avec repli disque local.

Cloud (EMERGENT_LLM_KEY présent) : stockage persistant Emergent.
Local (export Windows, pas de clé) : fichiers écrits dans backend/uploads/."""
import os
import logging
from pathlib import Path
import requests

logger = logging.getLogger(__name__)

STORAGE_URL = "https://integrations.emergentagent.com/objstore/api/v1/storage"
EMERGENT_KEY = os.environ.get("EMERGENT_LLM_KEY")
APP_NAME = "sirius"
UPLOADS_DIR = Path(__file__).parent / "uploads"

_storage_key = None


def cloud_available() -> bool:
    return bool(EMERGENT_KEY)


def init_storage():
    """À appeler une seule fois : récupère la clé de session du stockage."""
    global _storage_key
    if _storage_key:
        return _storage_key
    resp = requests.post(f"{STORAGE_URL}/init", json={"emergent_key": EMERGENT_KEY}, timeout=30)
    resp.raise_for_status()
    _storage_key = resp.json()["storage_key"]
    return _storage_key


def put_object(path: str, data: bytes, content_type: str) -> dict:
    if not cloud_available():
        p = UPLOADS_DIR / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return {"path": path, "size": len(data)}
    key = init_storage()
    resp = requests.put(
        f"{STORAGE_URL}/objects/{path}",
        headers={"X-Storage-Key": key, "Content-Type": content_type},
        data=data, timeout=120,
    )
    resp.raise_for_status()
    return resp.json()


def get_object(path: str):
    """Retourne (bytes, content_type|None)."""
    global _storage_key
    if not cloud_available():
        p = UPLOADS_DIR / path
        if not p.exists():
            raise FileNotFoundError(path)
        return p.read_bytes(), None
    key = init_storage()
    resp = requests.get(f"{STORAGE_URL}/objects/{path}", headers={"X-Storage-Key": key}, timeout=60)
    if resp.status_code == 403:
        _storage_key = None
        key = init_storage()
        resp = requests.get(f"{STORAGE_URL}/objects/{path}", headers={"X-Storage-Key": key}, timeout=60)
    resp.raise_for_status()
    return resp.content, resp.headers.get("Content-Type")
