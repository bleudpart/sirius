"""Tests de la mémoire épisodique et du rappel sémantique."""
import asyncio
from datetime import datetime, timezone, timedelta

import pytest

import local_memory
import semantic_vectors
from episodic import condense_idle_sessions, IDLE_MINUTES, MIN_NEW_TURNS


@pytest.fixture()
def memory_db(tmp_path, monkeypatch):
    monkeypatch.setattr(local_memory, "DB_PATH", tmp_path / "test_memory.db")
    local_memory.init_local_db()
    return local_memory


# ---------- Synonymes hors-ligne : « bistrot » retrouve « restaurant » ----------

def test_bistrot_retrouve_restaurant(memory_db):
    memory_db.add_fact("souvenir", "mon restaurant Le Zenith ouvre à 11h30", user_id="u1")
    memory_db.add_fact("souvenir", "le chat s'appelle Plume", user_id="u1")

    recalled = memory_db.recall_facts("à quelle heure ouvre le bistrot ?", user_id="u1", limit=1)
    assert recalled and "restaurant" in recalled[0]["text"]


def test_synonymes_voiture(memory_db):
    memory_db.add_fact("souvenir", "ma voiture est garée au parking Vinci", user_id="u1")
    recalled = memory_db.recall_facts("où est ma bagnole ?", user_id="u1", limit=1)
    assert recalled and "voiture" in recalled[0]["text"]


# ---------- Épisodes : stockage et rappel ----------

def test_episode_roundtrip(memory_db):
    memory_db.add_episode("u1", "L'utilisateur a préparé son audit HACCP avec SIRIUS.", session_id="u1:demo")
    episodes = memory_db.recent_episodes("u1")
    assert len(episodes) == 1
    assert "HACCP" in episodes[0]["summary"]
    assert memory_db.recent_episodes("u2") == []


# ---------- Condensation des sessions inactives ----------

class _FakeCursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def __aiter__(self):
        self._iter = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


class _FakeCollection:
    def __init__(self, docs):
        self.docs = docs
        self.updates = []

    def find(self, query, projection=None):
        cutoff = query["updated_at"]["$lt"]
        return _FakeCursor([d for d in self.docs if d["updated_at"] < cutoff])

    async def update_one(self, query, update):
        self.updates.append((query, update))


class _FakeDb:
    def __init__(self, docs):
        self.sirius_chats = _FakeCollection(docs)


def _history(n):
    return [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"tour {i}"}
        for i in range(n)
    ]


def test_condensation_session_inactive(memory_db):
    old_stamp = (datetime.now(timezone.utc) - timedelta(minutes=IDLE_MINUTES + 5)).isoformat()
    db = _FakeDb([{
        "session_id": "u1:demo", "history": _history(6),
        "updated_at": old_stamp, "condensed_len": 0,
    }])

    async def fake_summarize(history):
        assert len(history) == 6
        return {"resume": "L'utilisateur a organisé sa semaine.", "faits": ["projet: audit du vendredi"]}

    created = asyncio.run(condense_idle_sessions(db, fake_summarize))
    assert created == 1
    episodes = memory_db.recent_episodes("u1")
    assert episodes and "semaine" in episodes[0]["summary"]
    facts = memory_db.list_facts(user_id="u1")
    assert any("audit" in f["text"] for f in facts)
    assert facts[0]["category"] == "projet" or any(f["category"] == "projet" for f in facts)
    # Le curseur avance : la même conversation ne sera pas condensée deux fois.
    assert db.sirius_chats.updates[0][1]["$set"]["condensed_len"] == 6


def test_pas_de_condensation_session_active(memory_db):
    db = _FakeDb([{
        "session_id": "u1:demo", "history": _history(6),
        "updated_at": datetime.now(timezone.utc).isoformat(), "condensed_len": 0,
    }])

    async def fail_summarize(history):
        raise AssertionError("ne doit pas être appelé pour une session active")

    assert asyncio.run(condense_idle_sessions(db, fail_summarize)) == 0


def test_pas_de_condensation_sans_nouveaux_tours(memory_db):
    old_stamp = (datetime.now(timezone.utc) - timedelta(minutes=IDLE_MINUTES + 5)).isoformat()
    db = _FakeDb([{
        "session_id": "u1:demo", "history": _history(MIN_NEW_TURNS),
        "updated_at": old_stamp, "condensed_len": MIN_NEW_TURNS - 1,  # 1 seul tour nouveau
    }])

    async def fail_summarize(history):
        raise AssertionError("trop peu de nouveaux tours")

    assert asyncio.run(condense_idle_sessions(db, fail_summarize)) == 0


# ---------- Rerank sémantique ----------

def test_rerank_sans_cle_est_transparent(memory_db, monkeypatch):
    monkeypatch.setattr(semantic_vectors, "_EMBED_API_KEY", "")
    facts = [{"id": "1", "text": "a"}, {"id": "2", "text": "b"}, {"id": "3", "text": "c"}]
    result = asyncio.run(semantic_vectors.semantic_rerank("question", facts, top_k=2))
    assert result == facts[:2]


def test_rerank_reordonne_par_similarite(memory_db, monkeypatch):
    monkeypatch.setattr(semantic_vectors, "_EMBED_API_KEY", "fake-key")
    monkeypatch.setattr(semantic_vectors, "_query_cache", {})

    vectors = {
        "question": [1.0, 0.0],
        "hors sujet": [0.0, 1.0],
        "tres proche": [0.9, 0.1],
    }

    async def fake_embed(texts):
        return [vectors[t] for t in texts]

    monkeypatch.setattr(semantic_vectors, "_embed_batch", fake_embed)

    f1 = memory_db.add_fact("souvenir", "hors sujet", user_id="u1")
    f2 = memory_db.add_fact("souvenir", "tres proche", user_id="u1")
    facts = [dict(f1), dict(f2)]  # ordre mots-clés : hors sujet d'abord

    result = asyncio.run(semantic_vectors.semantic_rerank("question", facts, top_k=2))
    assert result[0]["text"] == "tres proche"  # la sémantique a corrigé l'ordre

    # Les vecteurs sont mis en cache localement : plus d'appel réseau ensuite.
    assert memory_db.get_cached_vector(f2["id"], semantic_vectors.EMBED_MODEL) is not None


def test_rerank_survit_a_une_panne_embeddings(memory_db, monkeypatch):
    monkeypatch.setattr(semantic_vectors, "_EMBED_API_KEY", "fake-key")
    monkeypatch.setattr(semantic_vectors, "_query_cache", {})

    async def broken_embed(texts):
        raise ConnectionError("api morte")

    monkeypatch.setattr(semantic_vectors, "_embed_batch", broken_embed)
    facts = [{"id": "1", "text": "a"}, {"id": "2", "text": "b"}]
    result = asyncio.run(semantic_vectors.semantic_rerank("question", facts, top_k=1))
    assert result == facts[:1]  # repli mots-clés, jamais bloquant
