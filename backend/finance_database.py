"""Persistance locale, ouverte à la première requête, de la finance d'entreprise ; distincte du portefeuille personnel."""
import logging
import sqlite3
from collections.abc import Iterator
from functools import lru_cache
from threading import Lock

from fastapi import HTTPException
from sqlalchemy import Connection, Engine, URL, create_engine, event
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.pool import ConnectionPoolEntry

from models.finance import Base
from runtime_paths import data_file

logger = logging.getLogger(__name__)
_engine_lock = Lock()


def create_finance_engine(url: URL) -> Engine:
    engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})

    @event.listens_for(engine, "connect")
    def configure(connection: sqlite3.Connection, _record: ConnectionPoolEntry) -> None:
        connection.execute("PRAGMA foreign_keys=ON")
        # Le BEGIN explicite ci-dessous garantit un instantané cohérent à toutes les requêtes du tableau de bord.
        connection.isolation_level = None

    @event.listens_for(engine, "begin")
    def begin(connection: Connection) -> None:
        connection.exec_driver_sql("BEGIN")

    Base.metadata.create_all(engine)
    return engine


@lru_cache(maxsize=1)
def _configured_engine() -> Engine:
    return create_finance_engine(URL.create("sqlite", database=str(data_file("finance.sqlite3"))))


def get_engine() -> Engine:
    with _engine_lock:
        return _configured_engine()


def get_db() -> Iterator[Session]:
    try:
        engine = get_engine()
    except (OSError, SQLAlchemyError) as error:
        logger.exception("[FINANCE] Initialisation du registre financier impossible")
        raise HTTPException(503, "Le registre financier est indisponible.") from error
    with Session(engine, expire_on_commit=False) as session:
        yield session
