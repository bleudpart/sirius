"""Archivage local et isole des actions multimedia SIRIUS."""

import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from runtime_paths import data_file


class MediaArchive:
    """Journal SQLite des commandes multimedia, sans jeton ni URL de flux."""

    def __init__(self, path: Path | None = None):
        configured_path = os.environ.get("SIRIUS_MEDIA_DB", "").strip()
        if path:
            self.path = path
        elif configured_path:
            self.path = Path(configured_path)
        else:
            self.path = data_file("sirius_local.db")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS media_events ("
                "id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, "
                "provider TEXT NOT NULL, status TEXT NOT NULL, title TEXT, query TEXT, "
                "external_url TEXT, created_at TEXT NOT NULL)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_media_events_user_created "
                "ON media_events (user_id, created_at DESC)"
            )

    def record(self, user_id: str, action: str, state: dict) -> dict:
        event = {
            "id": str(uuid.uuid4()),
            "user_id": (user_id or "legacy")[:200],
            "action": (action or "unknown")[:40],
            "provider": (state.get("provider") or "unknown")[:40],
            "status": (state.get("status") or "idle")[:40],
            "title": (state.get("title") or "")[:300],
            "query": (state.get("query") or "")[:300],
            "external_url": (state.get("external_url") or "")[:2048],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO media_events "
                "(id, user_id, action, provider, status, title, query, external_url, created_at) "
                "VALUES (:id, :user_id, :action, :provider, :status, :title, :query, :external_url, :created_at)",
                event,
            )
        return event

    def list(self, user_id: str, limit: int = 50) -> list[dict]:
        bounded_limit = max(1, min(int(limit), 200))
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, action, provider, status, title, query, external_url, created_at "
                "FROM media_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
                ((user_id or "legacy")[:200], bounded_limit),
            ).fetchall()
        return [dict(row) for row in rows]
