# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Stockage de fichiers ΣIRIUS — disque local uniquement (aucune dépendance cloud tierce).

Fichiers écrits dans backend/uploads/ (ou son équivalent d'export/desktop via data_dir())."""
import logging
from pathlib import Path
from runtime_paths import data_dir

logger = logging.getLogger(__name__)

APP_NAME = "sirius"
UPLOADS_DIR = data_dir() / "uploads"


def _safe_local_path(path: str) -> Path:
    """Résout `path` sous UPLOADS_DIR en rejetant toute évasion (../, chemin absolu)."""
    base = UPLOADS_DIR.resolve()
    candidate = (base / path).resolve()
    if candidate != base and base not in candidate.parents:
        raise ValueError(f"Chemin de stockage non autorisé : {path!r}")
    return candidate


def cloud_available() -> bool:
    return False


def put_object(path: str, data: bytes, content_type: str) -> dict:
    p = _safe_local_path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return {"path": path, "size": len(data)}


def get_object(path: str):
    """Retourne (bytes, content_type|None)."""
    p = _safe_local_path(path)
    if not p.exists():
        raise FileNotFoundError(path)
    return p.read_bytes(), None
