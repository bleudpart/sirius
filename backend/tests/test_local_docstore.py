"""Tests du docstore SQLite local (compatibilité motor/MongoDB)."""
import asyncio

import pytest

import local_docstore
from local_docstore import DatabaseRouter, LocalDocStore


@pytest.fixture()
def store(tmp_path):
    return LocalDocStore(tmp_path / "docstore.db")


def run(coro):
    return asyncio.run(coro)


# ---------- CRUD de base ----------

def test_insert_et_find_one(store):
    run(store.users.insert_one({"id": "u1", "email": "a@b.c", "role": "admin"}))
    doc = run(store.users.find_one({"email": "a@b.c"}))
    assert doc["id"] == "u1" and doc["role"] == "admin"
    assert run(store.users.find_one({"email": "absent@x.y"})) is None


def test_insert_ne_mute_pas_le_document(store):
    original = {"id": "x", "n": 1}
    run(store.items.insert_one(original))
    assert "_id" not in original


def test_update_one_et_set(store):
    run(store.chats.insert_one({"session_id": "s1", "history": []}))
    result = run(store.chats.update_one({"session_id": "s1"}, {"$set": {"history": ["a"], "meta.x": 1}}))
    assert result.matched_count == 1 and result.modified_count == 1
    doc = run(store.chats.find_one({"session_id": "s1"}))
    assert doc["history"] == ["a"] and doc["meta"]["x"] == 1


def test_upsert_cree_le_document(store):
    result = run(store.prefs.update_one({"user_id": "u1"}, {"$set": {"tz": "Europe/Paris"}}, upsert=True))
    assert result.upserted_id is not None
    doc = run(store.prefs.find_one({"user_id": "u1"}))
    assert doc["tz"] == "Europe/Paris"


def test_delete_et_count(store):
    for i in range(3):
        run(store.logs.insert_one({"id": str(i), "kind": "test"}))
    assert run(store.logs.count_documents({"kind": "test"})) == 3
    assert run(store.logs.delete_one({"id": "0"})).deleted_count == 1
    assert run(store.logs.delete_many({"kind": "test"})).deleted_count == 2


# ---------- Opérateurs de filtre ----------

def test_operateurs_comparaison_et_exists(store):
    run(store.evts.insert_one({"id": "a", "score": 5, "updated_at": "2026-01-01T10:00:00"}))
    run(store.evts.insert_one({"id": "b", "score": 9}))
    assert run(store.evts.find_one({"score": {"$gte": 6}}))["id"] == "b"
    assert run(store.evts.find_one({"updated_at": {"$lt": "2026-06-01"}}))["id"] == "a"
    assert run(store.evts.find_one({"updated_at": {"$exists": False}}))["id"] == "b"
    assert run(store.evts.find_one({"id": {"$ne": "a"}}))["id"] == "b"


def test_or_et_regex(store):
    run(store.files.insert_one({"id": "1", "content_type": "video/mp4", "user_id": "u1"}))
    run(store.files.insert_one({"id": "2", "content_type": "image/png"}))
    # Requête réelle de server.py : portée utilisateur avec champ absent.
    docs = run(store.files.find(
        {"$or": [{"user_id": "u1"}, {"user_id": {"$exists": False}}]}
    ).to_list(10))
    assert len(docs) == 2
    video = run(store.files.find_one({"content_type": {"$regex": "^video/"}}))
    assert video["id"] == "1"


# ---------- Opérateurs de mise à jour ----------

def test_inc_push_addtoset(store):
    run(store.counters.insert_one({"key": "F-2026", "seq": 1}))
    run(store.counters.update_one({"key": "F-2026"}, {"$inc": {"seq": 1}}))
    assert run(store.counters.find_one({"key": "F-2026"}))["seq"] == 2

    run(store.orders.insert_one({"id": "o1", "emails": []}))
    run(store.orders.update_one({"id": "o1"}, {"$push": {"emails": {"to": "x"}}}))
    assert run(store.orders.find_one({"id": "o1"}))["emails"] == [{"to": "x"}]

    # $addToSet + $each (marquage des mails vus, microsoft_graph.py).
    run(store.seen.update_one(
        {"user_id": "u1"},
        {"$addToSet": {"ids": {"$each": ["a", "b"]}}, "$set": {"updated_at": "now"}},
        upsert=True,
    ))
    run(store.seen.update_one({"user_id": "u1"}, {"$addToSet": {"ids": {"$each": ["b", "c"]}}}))
    assert run(store.seen.find_one({"user_id": "u1"}))["ids"] == ["a", "b", "c"]


def test_find_one_and_update_compteur_themis(store):
    # Compteur de facturation THEMIS : upsert + $inc + return_document.
    doc = run(store.themis_counters.find_one_and_update(
        {"key": "FAC-2026"}, {"$inc": {"seq": 1}}, upsert=True, return_document=True))
    assert doc["seq"] == 1
    doc = run(store.themis_counters.find_one_and_update(
        {"key": "FAC-2026"}, {"$inc": {"seq": 1}}, upsert=True, return_document=True))
    assert doc["seq"] == 2


# ---------- Curseurs ----------

def test_sort_limit_to_list(store):
    for i, stamp in enumerate(["2026-01-03", "2026-01-01", "2026-01-02"]):
        run(store.trace.insert_one({"id": str(i), "created_at": stamp}))
    docs = run(store.trace.find({}, {"_id": 0}).sort("created_at", -1).to_list(2))
    assert [d["created_at"] for d in docs] == ["2026-01-03", "2026-01-02"]


def test_projection_inclusion_exclusion(store):
    run(store.diag.insert_one({"id": "1", "at": "2026-01-01", "data": {"heavy": True}}))
    only_at = run(store.diag.find_one({}, {"at": 1}))
    assert only_at == {"at": "2026-01-01"}
    no_data = run(store.diag.find_one({}, {"_id": 0, "data": 0}))
    assert no_data == {"id": "1", "at": "2026-01-01"}


def test_async_for_sur_curseur(store):
    for i in range(3):
        run(store.chats.insert_one({"session_id": f"s{i}", "updated_at": f"2026-01-0{i+1}"}))

    async def collect():
        return [d async for d in store.chats.find({"updated_at": {"$lt": "2026-01-03"}}, {"session_id": 1})]

    docs = run(collect())
    assert {d["session_id"] for d in docs} == {"s0", "s1"}


# ---------- Router (bascule Mongo → SQLite) ----------

def test_database_router_delegue_et_bascule(store, tmp_path):
    router = DatabaseRouter(store)
    assert router.backend_name == "sqlite"
    run(router.users.insert_one({"id": "u1"}))
    assert run(router.users.find_one({"id": "u1"}))["id"] == "u1"
    assert run(router["users"].find_one({"id": "u1"}))["id"] == "u1"

    other = LocalDocStore(tmp_path / "other.db")
    router.use(other)
    assert run(router.users.find_one({"id": "u1"})) is None


def test_create_index_est_un_noop(store):
    assert run(store.users.create_index("email", unique=True)) == "local"


def test_datetime_serialise_en_iso(store):
    from datetime import datetime, timezone
    stamp = datetime(2026, 1, 1, tzinfo=timezone.utc)
    run(store.status_checks.insert_one({"id": "1", "timestamp": stamp}))
    doc = run(store.status_checks.find_one({"id": "1"}))
    assert doc["timestamp"].startswith("2026-01-01T00:00:00")
