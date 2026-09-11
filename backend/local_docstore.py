# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Docstore SQLite local, compatible avec le sous-ensemble motor/MongoDB utilisé par ΣIRIUS.

Permet à l'application installée de fonctionner SANS serveur MongoDB : les
conversations, fichiers, données HACCP/THEMIS et transactions sont persistés
dans une base SQLite du dossier utilisateur (documents JSON).

API couverte (celle réellement utilisée par le backend) :
- collections dynamiques : `db.ma_collection` ou `db["ma_collection"]`
- find / find_one / insert_one / update_one / update_many / delete_one /
  delete_many / count_documents / find_one_and_update / find_one_and_delete
- curseurs : sort(champ, ±1), limit(n), skip(n), to_list(n), itération `async for`
- filtres : égalité (clés pointées incluses), $lt, $lte, $gt, $gte, $ne, $in,
  $nin, $exists, $regex, $or, $and
- mises à jour : $set, $unset, $inc, $push, $addToSet (+ $each)
- create_index / create_indexes : no-op (SQLite locale, volumétrie personnelle)
"""

import json
import re
import sqlite3
import threading
from datetime import date, datetime

from runtime_paths import data_file

_DB_PATH = data_file("sirius_docstore.db")
_lock = threading.Lock()


def _json_default(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def _dumps(doc: dict) -> str:
    return json.dumps(doc, ensure_ascii=False, default=_json_default)


def _get(doc, path):
    """Valeur d'une clé, avec support des clés pointées (« a.b.c »)."""
    current = doc
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None, False
        current = current[part]
    return current, True


def _set(doc, path, value):
    parts = path.split(".")
    current = doc
    for part in parts[:-1]:
        nxt = current.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            current[part] = nxt
        current = nxt
    current[parts[-1]] = value


def _unset(doc, path):
    parts = path.split(".")
    current = doc
    for part in parts[:-1]:
        current = current.get(part)
        if not isinstance(current, dict):
            return
    current.pop(parts[-1], None)


def _normalize(value):
    """Rend comparables les opérandes hétérogènes (datetime ↔ chaîne ISO)."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _compare(actual, operator, expected) -> bool:
    actual, expected = _normalize(actual), _normalize(expected)
    try:
        if operator == "$lt":
            return actual is not None and actual < expected
        if operator == "$lte":
            return actual is not None and actual <= expected
        if operator == "$gt":
            return actual is not None and actual > expected
        if operator == "$gte":
            return actual is not None and actual >= expected
    except TypeError:
        return False
    if operator == "$ne":
        return actual != expected
    if operator == "$in":
        return actual in expected
    if operator == "$nin":
        return actual not in expected
    raise ValueError(f"Opérateur non supporté : {operator}")


def _matches(doc: dict, query: dict) -> bool:
    for key, condition in (query or {}).items():
        if key == "$or":
            if not any(_matches(doc, q) for q in condition):
                return False
            continue
        if key == "$and":
            if not all(_matches(doc, q) for q in condition):
                return False
            continue
        value, present = _get(doc, key)
        if isinstance(condition, dict) and any(k.startswith("$") for k in condition):
            for operator, expected in condition.items():
                if operator == "$exists":
                    if bool(expected) != present:
                        return False
                elif operator == "$regex":
                    flags = re.I if "i" in str(condition.get("$options", "")) else 0
                    if not isinstance(value, str) or not re.search(expected, value, flags):
                        return False
                elif operator == "$options":
                    continue  # géré avec $regex
                elif not _compare(value, operator, expected):
                    return False
        else:
            # Égalité Mongo : un champ absent équivaut à None.
            if _normalize(value) != _normalize(condition):
                return False
    return True


def _apply_update(doc: dict, update: dict):
    for operator, fields in (update or {}).items():
        if operator == "$set":
            for path, value in fields.items():
                _set(doc, path, value)
        elif operator == "$unset":
            for path in fields:
                _unset(doc, path)
        elif operator == "$inc":
            for path, amount in fields.items():
                current, _ = _get(doc, path)
                _set(doc, path, (current or 0) + amount)
        elif operator == "$push":
            for path, value in fields.items():
                current, _ = _get(doc, path)
                items = current if isinstance(current, list) else []
                items.append(value)
                _set(doc, path, items)
        elif operator == "$addToSet":
            for path, value in fields.items():
                current, _ = _get(doc, path)
                items = current if isinstance(current, list) else []
                new_values = value["$each"] if isinstance(value, dict) and "$each" in value else [value]
                for item in new_values:
                    if item not in items:
                        items.append(item)
                _set(doc, path, items)
        elif operator.startswith("$"):
            raise ValueError(f"Opérateur de mise à jour non supporté : {operator}")
        else:
            # Document de remplacement complet (sans opérateur $).
            doc.clear()
            doc.update(update)
            return


def _project(doc: dict, projection) -> dict:
    if not projection:
        return doc
    include = {k for k, v in projection.items() if v and k != "_id"}
    if include:
        return {k: doc[k] for k in include if k in doc}
    excluded = {k for k, v in projection.items() if not v}
    return {k: v for k, v in doc.items() if k not in excluded}


def _sort_key(field):
    def key(doc):
        value = _normalize(_get(doc, field)[0])
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return (1, value, "")
        if isinstance(value, str):
            return (2, 0, value)
        return (0, 0, "")  # valeurs absentes en premier (comme Mongo, ordre croissant)

    return key


class _Results:
    """Objet résultat minimal (inserted_id / matched / modified / deleted / upserted)."""

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class LocalCursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, field, direction=1):
        if isinstance(field, (list, tuple)) and field and isinstance(field[0], (list, tuple)):
            for name, way in reversed(field):
                self._docs.sort(key=_sort_key(name), reverse=way < 0)
        else:
            self._docs.sort(key=_sort_key(field), reverse=direction < 0)
        return self

    def skip(self, count):
        self._docs = self._docs[count:]
        return self

    def limit(self, count):
        if count:
            self._docs = self._docs[:count]
        return self

    async def to_list(self, length=None):
        return self._docs[:length] if length else list(self._docs)

    def __aiter__(self):
        self._iter = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


class LocalCollection:
    def __init__(self, store, name: str):
        self._store = store
        self._name = name

    # --- lecture ---

    def find(self, query=None, projection=None):
        docs = [_project(d, projection) for _, d in self._store._scan(self._name, query)]
        return LocalCursor(docs)

    async def find_one(self, query=None, projection=None):
        for _, doc in self._store._scan(self._name, query, limit=1):
            return _project(doc, projection)
        return None

    async def count_documents(self, query=None):
        return sum(1 for _ in self._store._scan(self._name, query))

    # --- écriture ---

    async def insert_one(self, document: dict):
        pk = self._store._insert(self._name, dict(document))
        return _Results(inserted_id=pk, acknowledged=True)

    async def update_one(self, query, update, upsert=False):
        return self._store._update(self._name, query, update, upsert=upsert, many=False)

    async def update_many(self, query, update, upsert=False):
        return self._store._update(self._name, query, update, upsert=upsert, many=True)

    async def delete_one(self, query):
        return self._store._delete(self._name, query, many=False)

    async def delete_many(self, query):
        return self._store._delete(self._name, query, many=True)

    async def find_one_and_update(self, query, update, upsert=False, return_document=False, projection=None):
        doc = self._store._find_one_and_update(self._name, query, update, upsert, bool(return_document))
        return _project(doc, projection) if doc else None

    async def find_one_and_delete(self, query, projection=None):
        for pk, doc in self._store._scan(self._name, query, limit=1):
            self._store._delete_pk(self._name, pk)
            return _project(doc, projection)
        return None

    # --- index : no-op en SQLite locale ---

    async def create_index(self, *args, **kwargs):
        return "local"

    async def create_indexes(self, *args, **kwargs):
        return []


class LocalDocStore:
    """Base documentaire locale : `store.collection` ↔ `db.collection` motor."""

    def __init__(self, path=None):
        self._path = str(path or _DB_PATH)
        with self._conn() as con:
            con.execute(
                "CREATE TABLE IF NOT EXISTS documents ("
                "pk INTEGER PRIMARY KEY AUTOINCREMENT, "
                "collection TEXT NOT NULL, doc TEXT NOT NULL)"
            )
            con.execute(
                "CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection)"
            )
            con.execute("PRAGMA journal_mode=WAL")

    def _conn(self):
        con = sqlite3.connect(self._path)
        con.row_factory = sqlite3.Row
        return con

    def __getattr__(self, name: str) -> LocalCollection:
        if name.startswith("_"):
            raise AttributeError(name)
        return LocalCollection(self, name)

    def __getitem__(self, name: str) -> LocalCollection:
        return LocalCollection(self, name)

    # --- primitives internes (synchrones : SQLite locale, opérations courtes) ---

    def _scan(self, collection: str, query=None, limit=None):
        with self._conn() as con:
            rows = con.execute(
                "SELECT pk, doc FROM documents WHERE collection = ? ORDER BY pk", (collection,)
            ).fetchall()
        found = 0
        for row in rows:
            try:
                doc = json.loads(row["doc"])
            except Exception:
                continue
            if _matches(doc, query or {}):
                yield row["pk"], doc
                found += 1
                if limit and found >= limit:
                    return

    def _insert(self, collection: str, document: dict) -> int:
        document.pop("_id", None)
        with _lock, self._conn() as con:
            cur = con.execute(
                "INSERT INTO documents (collection, doc) VALUES (?, ?)",
                (collection, _dumps(document)),
            )
        return cur.lastrowid

    def _replace_pk(self, collection: str, pk: int, document: dict):
        with _lock, self._conn() as con:
            con.execute(
                "UPDATE documents SET doc = ? WHERE pk = ? AND collection = ?",
                (_dumps(document), pk, collection),
            )

    def _delete_pk(self, collection: str, pk: int):
        with _lock, self._conn() as con:
            con.execute("DELETE FROM documents WHERE pk = ? AND collection = ?", (pk, collection))

    def _upsert_seed(self, query: dict, update: dict) -> dict:
        """Document initial d'un upsert : champs d'égalité du filtre + mise à jour."""
        seed = {
            key: value
            for key, value in (query or {}).items()
            if not key.startswith("$") and not (isinstance(value, dict) and any(k.startswith("$") for k in value))
        }
        _apply_update(seed, update)
        return seed

    def _update(self, collection: str, query, update, upsert: bool, many: bool):
        matched = modified = 0
        upserted_id = None
        for pk, doc in list(self._scan(collection, query, limit=None if many else 1)):
            matched += 1
            before = _dumps(doc)
            _apply_update(doc, update)
            if _dumps(doc) != before:
                self._replace_pk(collection, pk, doc)
                modified += 1
            if not many:
                break
        if matched == 0 and upsert:
            upserted_id = self._insert(collection, self._upsert_seed(query, update))
        return _Results(
            matched_count=matched, modified_count=modified,
            upserted_id=upserted_id, acknowledged=True,
        )

    def _find_one_and_update(self, collection, query, update, upsert, return_after):
        for pk, doc in self._scan(collection, query, limit=1):
            before = dict(doc)
            _apply_update(doc, update)
            self._replace_pk(collection, pk, doc)
            return doc if return_after else before
        if upsert:
            seed = self._upsert_seed(query, update)
            self._insert(collection, seed)
            return seed if return_after else None
        return None

    def _delete(self, collection: str, query, many: bool):
        deleted = 0
        for pk, _ in list(self._scan(collection, query, limit=None if many else 1)):
            self._delete_pk(collection, pk)
            deleted += 1
        return _Results(deleted_count=deleted, acknowledged=True)


class DatabaseRouter:
    """Proxy de base documentaire : Mongo si disponible, sinon docstore SQLite.

    Le backend cible est interchangeable à chaud (au démarrage, après le ping) :
    tous les routeurs ayant reçu ce proxy suivent automatiquement.
    """

    def __init__(self, backend):
        object.__setattr__(self, "_backend", backend)

    def use(self, backend):
        object.__setattr__(self, "_backend", backend)

    @property
    def backend_name(self) -> str:
        return "sqlite" if isinstance(self._backend, LocalDocStore) else "mongodb"

    def __getattr__(self, name):
        return getattr(object.__getattribute__(self, "_backend"), name)

    def __getitem__(self, name):
        return object.__getattribute__(self, "_backend")[name]
