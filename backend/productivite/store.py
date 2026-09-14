"""Stockage SQLite local et isole du module Productivite."""

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from runtime_paths import data_file


class ProductivityStore:
    """Conserve les notes, taches et rapports sans transmettre de donnees tierces."""

    def __init__(self, path: Path | None = None):
        configured_path = os.environ.get("SIRIUS_PRODUCTIVITY_DB", "").strip()
        if path:
            self.path = path
        elif configured_path:
            self.path = Path(configured_path)
        else:
            self.path = data_file("sirius_local.db")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS productivity_notes ("
                "id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, "
                "content TEXT NOT NULL, tags TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, "
                "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS productivity_tasks ("
                "id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, "
                "description TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, "
                "due_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT)"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS productivity_reports ("
                "id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, "
                "content TEXT NOT NULL, report_type TEXT NOT NULL, created_at TEXT NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS productivity_sync_changes ("
                "id TEXT PRIMARY KEY, user_id TEXT NOT NULL, entity_type TEXT NOT NULL, "
                "entity_id TEXT NOT NULL, operation TEXT NOT NULL, device_id TEXT NOT NULL, "
                "payload TEXT NOT NULL, updated_at TEXT NOT NULL)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_productivity_notes_user_updated "
                "ON productivity_notes (user_id, updated_at DESC)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_productivity_tasks_user_status "
                "ON productivity_tasks (user_id, status, due_at)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_productivity_reports_user_created "
                "ON productivity_reports (user_id, created_at DESC)"
            )

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _safe_user_id(user_id: str) -> str:
        return (user_id or "legacy")[:200]

    @staticmethod
    def _tags(value) -> list[str]:
        if not isinstance(value, list):
            return []
        seen = set()
        tags = []
        for tag in value:
            clean = " ".join(str(tag or "").split())[:48]
            key = clean.lower()
            if clean and key not in seen:
                seen.add(key)
                tags.append(clean)
        return tags[:12]

    @staticmethod
    def _note_from_row(row: sqlite3.Row) -> dict:
        note = dict(row)
        try:
            note["tags"] = json.loads(note.get("tags") or "[]")
        except json.JSONDecodeError:
            note["tags"] = []
        note["pinned"] = bool(note.get("pinned"))
        return note

    def list_notes(self, user_id: str, query: str = "", limit: int = 100) -> list[dict]:
        bounded_limit = max(1, min(int(limit), 200))
        user = self._safe_user_id(user_id)
        terms = " ".join((query or "").split())[:160]
        with self._connect() as connection:
            if terms:
                like = f"%{terms}%"
                rows = connection.execute(
                    "SELECT * FROM productivity_notes WHERE user_id = ? "
                    "AND (title LIKE ? OR content LIKE ? OR tags LIKE ?) "
                    "ORDER BY pinned DESC, updated_at DESC LIMIT ?",
                    (user, like, like, like, bounded_limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM productivity_notes WHERE user_id = ? "
                    "ORDER BY pinned DESC, updated_at DESC LIMIT ?",
                    (user, bounded_limit),
                ).fetchall()
        return [self._note_from_row(row) for row in rows]

    def get_note(self, user_id: str, note_id: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM productivity_notes WHERE id = ? AND user_id = ?",
                (note_id, self._safe_user_id(user_id)),
            ).fetchone()
        return self._note_from_row(row) if row else None

    def create_note(self, user_id: str, title: str, content: str, tags=None, pinned: bool = False) -> dict:
        now = self._now()
        note = {
            "id": str(uuid.uuid4()),
            "user_id": self._safe_user_id(user_id),
            "title": " ".join((title or "").split())[:180],
            "content": (content or "").strip()[:50000],
            "tags": self._tags(tags),
            "pinned": bool(pinned),
            "created_at": now,
            "updated_at": now,
        }
        if not note["title"] or not note["content"]:
            raise ValueError("Le titre et le contenu de la note sont requis.")
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO productivity_notes "
                "(id, user_id, title, content, tags, pinned, created_at, updated_at) "
                "VALUES (:id, :user_id, :title, :content, :tags, :pinned, :created_at, :updated_at)",
                {**note, "tags": json.dumps(note["tags"], ensure_ascii=False), "pinned": int(note["pinned"])},
            )
        return note

    def update_note(self, user_id: str, note_id: str, **changes) -> dict | None:
        note = self.get_note(user_id, note_id)
        if not note:
            return None
        if "title" in changes and changes["title"] is not None:
            note["title"] = " ".join(str(changes["title"]).split())[:180]
        if "content" in changes and changes["content"] is not None:
            note["content"] = str(changes["content"]).strip()[:50000]
        if "tags" in changes and changes["tags"] is not None:
            note["tags"] = self._tags(changes["tags"])
        if "pinned" in changes and changes["pinned"] is not None:
            note["pinned"] = bool(changes["pinned"])
        if not note["title"] or not note["content"]:
            raise ValueError("Le titre et le contenu de la note sont requis.")
        note["updated_at"] = self._now()
        with self._connect() as connection:
            connection.execute(
                "UPDATE productivity_notes SET title = ?, content = ?, tags = ?, pinned = ?, updated_at = ? "
                "WHERE id = ? AND user_id = ?",
                (
                    note["title"],
                    note["content"],
                    json.dumps(note["tags"], ensure_ascii=False),
                    int(note["pinned"]),
                    note["updated_at"],
                    note_id,
                    self._safe_user_id(user_id),
                ),
            )
        return note

    def delete_note(self, user_id: str, note_id: str) -> bool:
        with self._connect() as connection:
            result = connection.execute(
                "DELETE FROM productivity_notes WHERE id = ? AND user_id = ?",
                (note_id, self._safe_user_id(user_id)),
            )
        return result.rowcount > 0

    def list_tasks(self, user_id: str, status: str = "", limit: int = 200) -> list[dict]:
        bounded_limit = max(1, min(int(limit), 300))
        user = self._safe_user_id(user_id)
        with self._connect() as connection:
            if status:
                rows = connection.execute(
                    "SELECT * FROM productivity_tasks WHERE user_id = ? AND status = ? "
                    "ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, "
                    "CASE WHEN due_at IS NULL OR due_at = '' THEN 1 ELSE 0 END, due_at, updated_at DESC LIMIT ?",
                    (user, status, bounded_limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM productivity_tasks WHERE user_id = ? "
                    "ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, "
                    "CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, "
                    "CASE WHEN due_at IS NULL OR due_at = '' THEN 1 ELSE 0 END, due_at, updated_at DESC LIMIT ?",
                    (user, bounded_limit),
                ).fetchall()
        return [dict(row) for row in rows]

    def get_task(self, user_id: str, task_id: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM productivity_tasks WHERE id = ? AND user_id = ?",
                (task_id, self._safe_user_id(user_id)),
            ).fetchone()
        return dict(row) if row else None

    def create_task(
        self,
        user_id: str,
        title: str,
        description: str = "",
        status: str = "todo",
        priority: str = "medium",
        due_at: str = "",
    ) -> dict:
        now = self._now()
        task = {
            "id": str(uuid.uuid4()),
            "user_id": self._safe_user_id(user_id),
            "title": " ".join((title or "").split())[:180],
            "description": (description or "").strip()[:4000],
            "status": status,
            "priority": priority,
            "due_at": (due_at or "").strip()[:40],
            "created_at": now,
            "updated_at": now,
            "completed_at": None,
        }
        if not task["title"]:
            raise ValueError("Le titre de la tache est requis.")
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO productivity_tasks "
                "(id, user_id, title, description, status, priority, due_at, created_at, updated_at, completed_at) "
                "VALUES (:id, :user_id, :title, :description, :status, :priority, :due_at, :created_at, :updated_at, :completed_at)",
                task,
            )
        return task

    def update_task(self, user_id: str, task_id: str, **changes) -> dict | None:
        task = self.get_task(user_id, task_id)
        if not task:
            return None
        for field, limit in (("title", 180), ("description", 4000), ("due_at", 40)):
            if field in changes and changes[field] is not None:
                value = str(changes[field]).strip()
                task[field] = " ".join(value.split())[:limit] if field == "title" else value[:limit]
        for field in ("status", "priority"):
            if field in changes and changes[field] is not None:
                task[field] = str(changes[field]).strip()
        if not task["title"]:
            raise ValueError("Le titre de la tache est requis.")
        task["completed_at"] = self._now() if task["status"] == "done" else None
        task["updated_at"] = self._now()
        with self._connect() as connection:
            connection.execute(
                "UPDATE productivity_tasks SET title = ?, description = ?, status = ?, priority = ?, due_at = ?, "
                "updated_at = ?, completed_at = ? WHERE id = ? AND user_id = ?",
                (
                    task["title"],
                    task["description"],
                    task["status"],
                    task["priority"],
                    task["due_at"],
                    task["updated_at"],
                    task["completed_at"],
                    task_id,
                    self._safe_user_id(user_id),
                ),
            )
        return task

    def delete_task(self, user_id: str, task_id: str) -> bool:
        with self._connect() as connection:
            result = connection.execute(
                "DELETE FROM productivity_tasks WHERE id = ? AND user_id = ?",
                (task_id, self._safe_user_id(user_id)),
            )
        return result.rowcount > 0

    def list_reports(self, user_id: str, limit: int = 50) -> list[dict]:
        bounded_limit = max(1, min(int(limit), 100))
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM productivity_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
                (self._safe_user_id(user_id), bounded_limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def create_report(self, user_id: str, title: str, content: str, report_type: str = "work") -> dict:
        report = {
            "id": str(uuid.uuid4()),
            "user_id": self._safe_user_id(user_id),
            "title": " ".join((title or "").split())[:180],
            "content": (content or "").strip()[:100000],
            "report_type": (report_type or "work").strip()[:40],
            "created_at": self._now(),
        }
        if not report["title"] or not report["content"]:
            raise ValueError("Le titre et le contenu du rapport sont requis.")
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO productivity_reports (id, user_id, title, content, report_type, created_at) "
                "VALUES (:id, :user_id, :title, :content, :report_type, :created_at)",
                report,
            )
        return report

    def summary(self, user_id: str) -> dict:
        user = self._safe_user_id(user_id)
        with self._connect() as connection:
            note_count = connection.execute(
                "SELECT COUNT(*) FROM productivity_notes WHERE user_id = ?", (user,)
            ).fetchone()[0]
            rows = connection.execute(
                "SELECT status, COUNT(*) AS count FROM productivity_tasks WHERE user_id = ? GROUP BY status",
                (user,),
            ).fetchall()
            next_task = connection.execute(
                "SELECT * FROM productivity_tasks WHERE user_id = ? AND status != 'done' "
                "AND due_at IS NOT NULL AND due_at != '' ORDER BY due_at LIMIT 1",
                (user,),
            ).fetchone()
            report_count = connection.execute(
                "SELECT COUNT(*) FROM productivity_reports WHERE user_id = ?", (user,)
            ).fetchone()[0]
        task_counts = {row["status"]: row["count"] for row in rows}
        return {
            "notes": note_count,
            "tasks": {
                "todo": task_counts.get("todo", 0),
                "in_progress": task_counts.get("in_progress", 0),
                "done": task_counts.get("done", 0),
                "total": sum(task_counts.values()),
            },
            "next_task": dict(next_task) if next_task else None,
            "reports": report_count,
        }

    def delete_user_data(self, user_id: str) -> None:
        user = self._safe_user_id(user_id)
        with self._connect() as connection:
            connection.execute("DELETE FROM productivity_notes WHERE user_id = ?", (user,))
            connection.execute("DELETE FROM productivity_tasks WHERE user_id = ?", (user,))
            connection.execute("DELETE FROM productivity_reports WHERE user_id = ?", (user,))

    def sync_pull(self, user_id: str, since: str = "") -> dict:
        user = self._safe_user_id(user_id)
        with self._connect() as connection:
            note_rows = connection.execute("SELECT * FROM productivity_notes WHERE user_id = ? AND updated_at > ? ORDER BY updated_at", (user, since or "")).fetchall()
            task_rows = connection.execute("SELECT * FROM productivity_tasks WHERE user_id = ? AND updated_at > ? ORDER BY updated_at", (user, since or "")).fetchall()
        return {"notes": [self._note_from_row(row) for row in note_rows], "tasks": [dict(row) for row in task_rows], "server_time": self._now()}

    def sync_push(self, user_id: str, device_id: str, changes: list[dict]) -> dict:
        user = self._safe_user_id(user_id)
        accepted, conflicts = [], []
        with self._connect() as connection:
            for change in changes[:500]:
                entity_type = change.get("entity_type")
                entity_id = str(change.get("entity_id") or "")
                payload = change.get("payload") or {}
                if entity_type not in ("note", "task") or not entity_id or not isinstance(payload, dict):
                    conflicts.append({"entity_id": entity_id, "reason": "Changement invalide."})
                    continue
                table = "productivity_notes" if entity_type == "note" else "productivity_tasks"
                remote = connection.execute(f"SELECT updated_at FROM {table} WHERE id = ? AND user_id = ?", (entity_id, user)).fetchone()
                foreign = connection.execute(f"SELECT user_id FROM {table} WHERE id = ? AND user_id != ?", (entity_id, user)).fetchone()
                if foreign:
                    conflicts.append({"entity_id": entity_id, "entity_type": entity_type, "reason": "Enregistrement appartenant à un autre utilisateur."})
                    continue
                incoming_time = str(payload.get("updated_at") or "")
                if remote and incoming_time and str(remote[0]) > incoming_time:
                    conflicts.append({"entity_id": entity_id, "entity_type": entity_type, "reason": "Version distante plus récente."})
                    continue
                now = self._now()
                if change.get("operation") == "delete":
                    connection.execute(f"DELETE FROM {table} WHERE id = ? AND user_id = ?", (entity_id, user))
                elif entity_type == "note":
                    connection.execute("INSERT INTO productivity_notes (id,user_id,title,content,tags,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,tags=excluded.tags,pinned=excluded.pinned,updated_at=excluded.updated_at", (entity_id, user, str(payload.get("title") or "")[:180], str(payload.get("content") or "")[:50000], json.dumps(self._tags(payload.get("tags")), ensure_ascii=False), int(bool(payload.get("pinned"))), payload.get("created_at") or now, incoming_time or now))
                else:
                    connection.execute("INSERT INTO productivity_tasks (id,user_id,title,description,status,priority,due_at,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,status=excluded.status,priority=excluded.priority,due_at=excluded.due_at,updated_at=excluded.updated_at,completed_at=excluded.completed_at", (entity_id, user, str(payload.get("title") or "")[:180], str(payload.get("description") or "")[:4000], str(payload.get("status") or "todo"), str(payload.get("priority") or "medium"), str(payload.get("due_at") or "")[:40], payload.get("created_at") or now, incoming_time or now, payload.get("completed_at")))
                accepted.append(entity_id)
        return {"accepted": accepted, "conflicts": conflicts, "server_time": self._now()}
