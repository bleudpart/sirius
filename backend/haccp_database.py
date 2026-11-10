"""Sessions SQLite du registre HACCP, independantes du docstore historique."""
import logging
import sqlite3
from collections.abc import Iterator
from datetime import datetime, timezone
from functools import lru_cache
from threading import Lock

from fastapi import HTTPException
from sqlalchemy import Engine, URL, create_engine, event, inspect
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.pool import ConnectionPoolEntry

from models.haccp import Base
from models import haccp_printing, haccp_reception  # Enregistre les tables des files et projections.
from runtime_paths import data_file
from schemas.haccp import PARIS

logger = logging.getLogger(__name__)
_engine_lock = Lock()


def _paris_day(value: str | None) -> str | None:
    if value is None:
        return None
    stamp = datetime.fromisoformat(value)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(PARIS).date().isoformat()


@lru_cache(maxsize=1)
def _configured_engine() -> Engine:
    engine = create_engine(
        URL.create("sqlite", database=str(data_file("haccp.sqlite3"))),
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    @event.listens_for(engine, "connect")
    def configure(connection: sqlite3.Connection, _record: ConnectionPoolEntry) -> None:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.create_function(
            "haccp_casefold", 1, lambda value: value.casefold() if value is not None else None,
            deterministic=True,
        )
        connection.create_function("haccp_paris_day", 1, _paris_day, deterministic=True)

    # create_all ne met pas a jour une table existante. Les archives restent intactes.
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        Base.metadata.create_all(connection)
        columns = {column["name"] for column in inspect(connection).get_columns("etiquettes_haccp")}
        additions = {
            "type_operation": "VARCHAR(16) NOT NULL DEFAULT 'reception'",
            "date_ouverture": "DATETIME",
            "date_fabrication": "DATETIME",
            "conditions_conservation": "VARCHAR(500)",
            "restaurant_name": "VARCHAR(160)",
            "dlc_secondaire": "DATETIME",
            "duree_conservation_heures": "INTEGER",
            "justification_duree": "VARCHAR(500)",
            "regle_confirmee": "BOOLEAN NOT NULL DEFAULT 0",
            "capture_id": "VARCHAR(36)",
            "capture_hash": "VARCHAR(64)",
            "categorie": "VARCHAR(32) NOT NULL DEFAULT 'Non classé'",
            "origines": "JSON",
            "poids_net": "JSON",
            "traces_allergenes": "JSON NOT NULL DEFAULT '[]'",
            "mentions_traces": "VARCHAR(500)",
            "allergenes_lecture": "VARCHAR(16) NOT NULL DEFAULT 'non_verifiee'",
            "champs_incertains": "JSON NOT NULL DEFAULT '[]'",
            "raw_image_path": "VARCHAR(512)",
            "raw_image_sha256": "VARCHAR(64)",
            "reception_source_id": "INTEGER",
        }
        for name, definition in additions.items():
            if name not in columns:
                connection.exec_driver_sql(f"ALTER TABLE etiquettes_haccp ADD COLUMN {name} {definition}")
        print_columns = {column["name"] for column in inspect(connection).get_columns("haccp_print_jobs")}
        if "accepted_at" not in print_columns:
            connection.exec_driver_sql("ALTER TABLE haccp_print_jobs ADD COLUMN accepted_at DATETIME")
        connection.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_haccp_print_activity "
            "ON haccp_print_jobs(scope_key, status, accepted_at)",
        )
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_haccp_releve_print_active "
            "ON haccp_releve_print_jobs(scope_key, releve_id) "
            "WHERE status IN ('pending', 'claimed')",
        )
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_haccp_capture "
            "ON etiquettes_haccp(scope_key, capture_id)",
        )
        connection.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_haccp_scope_categorie "
            "ON etiquettes_haccp(scope_key, categorie)",
        )
        for table in ("haccp_reception_sources", "haccp_reception_journal"):
            for operation in ("UPDATE", "DELETE"):
                connection.exec_driver_sql(
                    f"CREATE TRIGGER IF NOT EXISTS immutable_{table}_{operation.lower()} "
                    f"BEFORE {operation} ON {table} BEGIN "
                    "SELECT RAISE(ABORT, 'HACCP: archive append-only'); END",
                )
            duplicate = "reception_id = NEW.reception_id"
            if table == "haccp_reception_journal":
                duplicate += " OR (scope_key = NEW.scope_key AND sequence = NEW.sequence)"
            connection.exec_driver_sql(
                f"CREATE TRIGGER IF NOT EXISTS immutable_{table}_replace BEFORE INSERT ON {table} "
                f"WHEN EXISTS (SELECT 1 FROM {table} WHERE {duplicate}) BEGIN "
                "SELECT RAISE(ABORT, 'HACCP: archive append-only'); END",
            )
    return engine


def get_engine() -> Engine:
    with _engine_lock:
        return _configured_engine()


def get_db() -> Iterator[Session]:
    try:
        engine = get_engine()
    except (OSError, SQLAlchemyError) as error:
        logger.exception("[HACCP] Initialisation SQLite impossible")
        raise HTTPException(500, "Le registre HACCP local est indisponible.") from error
    with Session(engine, expire_on_commit=False) as session:
        yield session
