"""File locale transactionnelle : reservations inter-processus et resultats idempotents."""
import asyncio
import hashlib
import json
import logging
import sqlite3
import uuid
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, ParamSpec, TypeVar

from pydantic import TypeAdapter

from tri_cortex.schemas import (
    AgentId, Job, JsonObject, QueueUnavailable, TASK_AGENTS, TaskConflict, TaskContext, TaskInput,
)

T = TypeVar("T")
P = ParamSpec("P")
INPUT_ADAPTER = TypeAdapter(TaskInput)
logger = logging.getLogger(__name__)


async def run_io(operation: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    """Une annulation attend la fin de l'operation atomique deja partie dans le thread."""
    task = asyncio.create_task(asyncio.to_thread(operation, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


class OfflineStore:
    def __init__(self, path: Path, *, capacity: int = 64, max_attempts: int = 3):
        if capacity < 1 or max_attempts < 1:
            raise ValueError("Capacite et nombre de tentatives doivent etre positifs.")
        self.path = path
        self.capacity = capacity
        self.max_attempts = max_attempts

    @contextmanager
    def connection(self, *, write: bool = False) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        try:
            if write:
                connection.execute("BEGIN IMMEDIATE")
            yield connection
            if write:
                connection.commit()
        finally:
            connection.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS cortex_images (
                    scope TEXT NOT NULL, digest TEXT NOT NULL, content BLOB NOT NULL,
                    mime_type TEXT NOT NULL, created_at REAL NOT NULL,
                    PRIMARY KEY (scope, digest)
                );
                CREATE TABLE IF NOT EXISTS cortex_jobs (
                    id TEXT PRIMARY KEY, scope TEXT NOT NULL, actor_id TEXT,
                    agent TEXT NOT NULL, kind TEXT NOT NULL, request_key TEXT NOT NULL,
                    input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
                    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL, updated_at REAL NOT NULL, next_attempt_at REAL NOT NULL,
                    lease_owner TEXT, lease_until REAL, result_json TEXT,
                    error_code TEXT, error_message TEXT,
                    UNIQUE(scope, kind, request_key)
                );
                CREATE INDEX IF NOT EXISTS ix_cortex_due
                    ON cortex_jobs(agent, state, next_attempt_at, created_at);
                CREATE INDEX IF NOT EXISTS ix_cortex_scope ON cortex_jobs(scope, created_at);
            """)

    def put_image(self, scope: str, content: bytes, mime_type: str) -> str:
        if not content or len(content) > 20 * 1024 * 1024:
            raise ValueError("Image absente ou superieure a 20 Mio.")
        digest = hashlib.sha256(content).hexdigest()
        with self.connection(write=True) as connection:
            connection.execute(
                "INSERT OR IGNORE INTO cortex_images VALUES (?, ?, ?, ?, ?)",
                (scope, digest, content, mime_type, utc_now().timestamp()),
            )
        return digest

    def image(self, scope: str, digest: str, mime_type: str) -> bytes:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT content, mime_type FROM cortex_images WHERE scope=? AND digest=?", (scope, digest),
            ).fetchone()
        if row is None or row["mime_type"] != mime_type or hashlib.sha256(row["content"]).hexdigest() != digest:
            raise ValueError("Image de la file absente ou alteree.")
        return bytes(row["content"])

    @staticmethod
    def _job(row: sqlite3.Row) -> Job:
        if not isinstance(row["input_json"], str) or hashlib.sha256(row["input_json"].encode()).hexdigest() != row["input_hash"]:
            raise ValueError("Tache locale alteree.")
        payload = INPUT_ADAPTER.validate_json(row["input_json"])
        if row["kind"] != payload.kind or row["agent"] != TASK_AGENTS[payload.kind]:
            raise ValueError("Destination de tache locale incoherente.")
        return Job(
            id=row["id"], context=TaskContext(scope=row["scope"], actor_id=row["actor_id"]),
            input=payload, state=row["state"],
            attempts=row["attempts"],
            created_at=datetime.fromtimestamp(row["created_at"], timezone.utc),
            updated_at=datetime.fromtimestamp(row["updated_at"], timezone.utc),
            next_attempt_at=datetime.fromtimestamp(row["next_attempt_at"], timezone.utc),
            result=json.loads(row["result_json"]) if row["result_json"] is not None else None,
            error_code=row["error_code"], error_message=row["error_message"],
        )

    def _check_capacity(self, connection: sqlite3.Connection, agent: AgentId) -> None:
        count = connection.execute(
            "SELECT count(*) FROM cortex_jobs WHERE agent=? AND state IN ('pending','retry','running')",
            (agent,),
        ).fetchone()[0]
        if count >= self.capacity:
            raise QueueUnavailable("File Sentinel pleine ; aucune tache acceptee.")

    def put(self, context: TaskContext, payload: TaskInput, request_key: str) -> Job:
        if not request_key or len(request_key) > 200:
            raise ValueError("Reference de tache invalide.")
        serialized = canonical(payload.model_dump(mode="json"))
        digest = hashlib.sha256(serialized.encode()).hexdigest()
        agent = TASK_AGENTS[payload.kind]
        with self.connection(write=True) as connection:
            previous = connection.execute(
                "SELECT * FROM cortex_jobs WHERE scope=? AND kind=? AND request_key=?",
                (context.scope, payload.kind, request_key),
            ).fetchone()
            if previous is not None:
                if previous["input_hash"] != digest:
                    raise TaskConflict("Cette reference correspond deja a une autre analyse.")
                return self._job(previous)
            self._check_capacity(connection, agent)
            job_id, now = uuid.uuid4().hex, utc_now().timestamp()
            connection.execute(
                """INSERT INTO cortex_jobs
                   (id, scope, actor_id, agent, kind, request_key, input_json, input_hash, state,
                    created_at, updated_at, next_attempt_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)""",
                (job_id, context.scope, context.actor_id, agent, payload.kind, request_key,
                 serialized, digest, now, now, now),
            )
            row = connection.execute("SELECT * FROM cortex_jobs WHERE id=?", (job_id,)).fetchone()
            return self._job(row)

    def get(self, job_id: str, scopes: frozenset[str]) -> Job:
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM cortex_jobs WHERE id=?", (job_id,)).fetchone()
        if row is None or row["scope"] not in scopes:
            raise LookupError("Tache introuvable dans ce perimetre.")
        return self._job(row)

    def recent(self, scopes: frozenset[str], limit: int = 20) -> list[Job]:
        if not scopes or not 1 <= limit <= 100:
            raise ValueError("Perimetre ou limite de consultation invalide.")
        marks = ",".join("?" for _ in scopes)
        with self.connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM cortex_jobs WHERE scope IN ({marks}) ORDER BY created_at DESC LIMIT ?",
                (*sorted(scopes), limit),
            ).fetchall()
        return [self._job(row) for row in rows]

    def due(self, agent: AgentId) -> list[str]:
        now = utc_now().timestamp()
        with self.connection(write=True) as connection:
            connection.execute(
                """UPDATE cortex_jobs SET state=CASE WHEN attempts>=? THEN 'failed' ELSE 'retry' END,
                   lease_owner=NULL, lease_until=NULL, updated_at=?, next_attempt_at=?,
                   error_code='Interrupted', error_message='Traitement interrompu ; reprise bornee.'
                   WHERE agent=? AND state='running' AND lease_until<?""",
                (self.max_attempts, now, now, agent, now),
            )
            rows = connection.execute(
                """SELECT id FROM cortex_jobs WHERE agent=? AND state IN ('pending','retry')
                   AND attempts<? AND next_attempt_at<=? ORDER BY created_at, id LIMIT ?""",
                (agent, self.max_attempts, now, self.capacity),
            ).fetchall()
        return [row["id"] for row in rows]

    def claim(self, job_id: str, owner: str, lease_seconds: float) -> Job | None:
        now = utc_now().timestamp()
        with self.connection(write=True) as connection:
            changed = connection.execute(
                """UPDATE cortex_jobs SET state='running', attempts=attempts+1, updated_at=?,
                   lease_owner=?, lease_until=? WHERE id=? AND state IN ('pending','retry')
                   AND next_attempt_at<=? AND attempts<?""",
                (now, owner, now + lease_seconds, job_id, now, self.max_attempts),
            ).rowcount
            if not changed:
                return None
            try:
                return self._job(connection.execute("SELECT * FROM cortex_jobs WHERE id=?", (job_id,)).fetchone())
            except ValueError:
                connection.execute(
                    """UPDATE cortex_jobs SET state='failed', lease_owner=NULL, lease_until=NULL,
                       error_code='IntegrityError', error_message='Tache alteree ; restauration requise.'
                       WHERE id=?""", (job_id,),
                )
                logger.error("[SENTINEL] Tache %s mise en quarantaine ; donnees conservees", job_id)
                return None

    def finish(self, job_id: str, owner: str, result: JsonObject) -> None:
        with self.connection(write=True) as connection:
            changed = connection.execute(
                """UPDATE cortex_jobs SET state='done', result_json=?, updated_at=?,
                   lease_owner=NULL, lease_until=NULL, error_code=NULL, error_message=NULL
                   WHERE id=? AND lease_owner=? AND state='running'""",
                (canonical(result), utc_now().timestamp(), job_id, owner),
            ).rowcount
            if changed != 1:
                raise TaskConflict("La reservation de la tache a expire ; resultat non confirme.")

    def fail(self, job: Job, owner: str, code: str, message: str, retry: bool, delay: float) -> None:
        state = "retry" if retry and job.attempts < self.max_attempts else "failed"
        now = utc_now().timestamp()
        with self.connection(write=True) as connection:
            changed = connection.execute(
                """UPDATE cortex_jobs SET state=?, updated_at=?, next_attempt_at=?,
                   lease_owner=NULL, lease_until=NULL, error_code=?, error_message=?
                   WHERE id=? AND lease_owner=? AND state='running'""",
                (state, now, now + delay, code, message, job.id, owner),
            ).rowcount
            if changed != 1:
                raise TaskConflict("Echec non enregistre : reservation de tache perdue.")

    def release(self, job_id: str, owner: str) -> None:
        now = utc_now().timestamp()
        with self.connection(write=True) as connection:
            connection.execute(
                """UPDATE cortex_jobs SET state=CASE WHEN attempts>=? THEN 'failed' ELSE 'retry' END,
                   updated_at=?, next_attempt_at=?, lease_owner=NULL, lease_until=NULL,
                   error_code='Interrupted', error_message='Arret pendant le traitement.'
                   WHERE id=? AND lease_owner=? AND state='running'""",
                (self.max_attempts, now, now, job_id, owner),
            )

    def backlog(self) -> list[tuple[str, AgentId, int]]:
        with self.connection() as connection:
            rows = connection.execute(
                """SELECT scope, agent, count(*) AS n FROM cortex_jobs
                   WHERE state IN ('pending','retry') GROUP BY scope, agent"""
            ).fetchall()
        return [(row["scope"], row["agent"], row["n"]) for row in rows]

    def retry(self, job_id: str, scopes: frozenset[str], actor_id: str) -> Job:
        with self.connection(write=True) as connection:
            row = connection.execute("SELECT * FROM cortex_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None or row["scope"] not in scopes:
                raise LookupError("Tache introuvable dans ce perimetre.")
            if row["state"] != "failed":
                raise TaskConflict("Seule une analyse en echec peut etre relancee manuellement.")
            previous = self._job(row)
            self._check_capacity(connection, TASK_AGENTS[previous.input.kind])
            now = utc_now().timestamp()
            connection.execute(
                """UPDATE cortex_jobs SET state='pending', attempts=0, actor_id=?, updated_at=?,
                   next_attempt_at=?, error_code=NULL, error_message=NULL WHERE id=?""",
                (actor_id, now, now, job_id),
            )
            return self._job(connection.execute("SELECT * FROM cortex_jobs WHERE id=?", (job_id,)).fetchone())
