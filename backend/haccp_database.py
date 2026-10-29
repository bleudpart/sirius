"""Sessions SQLite du registre HACCP, independantes du docstore historique."""
import logging
import sqlite3
from collections.abc import Iterator
from functools import lru_cache
from threading import Lock

from fastapi import HTTPException
from sqlalchemy import Engine, URL, create_engine, event, inspect
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.pool import ConnectionPoolEntry

from models.haccp import Base
from models import haccp_printing  # Enregistre les tables de la file dans les metadonnees.
from runtime_paths import data_file

logger = logging.getLogger(__name__)
_engine_lock = Lock()


@lru_cache(maxsize=1)
def _configured_engine() -> Engine:
    engine = create_engine(
        URL.create("sqlite", database=str(data_file("haccp.sqlite3"))),
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    @event.listens_for(engine, "connect")
    def configure(connection: sqlite3.Connection, _record: ConnectionPoolEntry) -> None:
        connection.create_function(
            "haccp_casefold", 1, lambda value: value.casefold() if value is not None else None,
            deterministic=True,
        )

    Base.metadata.create_all(engine)
    # create_all ne met pas a jour une table existante. Les archives restent intactes.
    with engine.begin() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        columns = {column["name"] for column in inspect(connection).get_columns("etiquettes_haccp")}
        additions = {
            "type_operation": "VARCHAR(10) NOT NULL DEFAULT 'reception'",
            "date_ouverture": "DATETIME",
            "dlc_secondaire": "DATETIME",
            "duree_conservation_heures": "INTEGER",
            "justification_duree": "VARCHAR(500)",
            "regle_confirmee": "BOOLEAN NOT NULL DEFAULT 0",
            "capture_id": "VARCHAR(36)",
            "capture_hash": "VARCHAR(64)",
            "categorie": "VARCHAR(32) NOT NULL DEFAULT 'Non classé'",
        }
        for name, definition in additions.items():
            if name not in columns:
                connection.exec_driver_sql(f"ALTER TABLE etiquettes_haccp ADD COLUMN {name} {definition}")
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_haccp_capture "
            "ON etiquettes_haccp(scope_key, capture_id)",
        )
        connection.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_haccp_scope_categorie "
            "ON etiquettes_haccp(scope_key, categorie)",
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
