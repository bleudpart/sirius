"""Cerveau vectoriel ΣIRIUS : rappel sémantique rapide des souvenirs.

Trois niveaux de fournisseur d'embeddings, du meilleur au repli :
1. LOCAL (fastembed/ONNX, modèle multilingue quantisé ~100 Mo téléchargé une seule
   fois) : hors-ligne, sans clé API, ~10 ms par texte.
2. API Gemini (GEMINI_API_KEY déjà utilisée par ΣIRIUS, aucune clé supplémentaire).
3. Mots-clés + synonymes (toujours actif, jamais bloquant).

Deux niveaux de vitesse :
1. Les vecteurs sont PRÉ-CALCULÉS en tâche de fond et mis en cache SQLite + RAM :
   au moment d'une question, seule la requête reste à vectoriser, et elle aussi
   est mise en cache.
2. Les similarités sont calculées en une seule opération matricielle numpy
   (repli Python pur si numpy est absent).

Le rappel vectoriel (`semantic_recall`) cherche dans TOUS les souvenirs vectorisés,
pas seulement ceux remontés par mots-clés : un souvenir sans aucun mot commun avec
la question reste retrouvable par le sens.
"""

import asyncio
import logging
import math
import os
import threading
import time

from local_memory import (
    facts_missing_vectors,
    get_cached_vector,
    store_vector,
    vectorized_facts,
)
from resilience import resilient_call

try:
    import numpy as _np
except ImportError:  # numpy est optionnel : repli Python pur
    _np = None

logger = logging.getLogger("sirius.semantic")

EMBED_MODEL = os.getenv("SIRIUS_EMBED_MODEL", "gemini-embedding-001")
_EMBED_API_KEY = (os.getenv("GEMINI_API_KEY") or "").strip()
_QUERY_CACHE_MAX = 128
_query_cache = {}

# Embeddings 100 % locaux (fastembed) : chargés en tâche de fond, jamais bloquants.
LOCAL_EMBED_REPO = os.getenv(
    "SIRIUS_LOCAL_EMBED_REPO", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
)
LOCAL_EMBED_NAME = "local-paraphrase-multilingual-minilm-l12"
_LOCAL_EMBED_ENABLED = (os.getenv("SIRIUS_LOCAL_EMBEDDINGS", "1").strip() != "0")
_local_model_instance = None
_local_model_lock = threading.Lock()

# Cache RAM des vecteurs de faits : évite lecture SQLite + décodage JSON par requête.
_VECTOR_CACHE_MAX = 5000
_vector_cache = {}

# Index vectoriel par utilisateur (faits + vecteurs), reconstruit au plus toutes les 60 s.
_USER_INDEX_TTL = 60.0
_user_index = {}


def local_embeddings_ready() -> bool:
    return _local_model_instance is not None


def embeddings_available() -> bool:
    return local_embeddings_ready() or bool(_EMBED_API_KEY)


def _load_local_model_sync():
    from fastembed import TextEmbedding
    from runtime_paths import data_dir

    cache = data_dir() / "embeddings"
    cache.mkdir(parents=True, exist_ok=True)
    return TextEmbedding(LOCAL_EMBED_REPO, cache_dir=str(cache), providers=["CPUExecutionProvider"])


def _activate_local_model(model):
    """Bascule sur les embeddings locaux : nouvel espace vectoriel, caches purgés."""
    global _local_model_instance, EMBED_MODEL
    _local_model_instance = model
    EMBED_MODEL = LOCAL_EMBED_NAME
    _query_cache.clear()
    _vector_cache.clear()
    _user_index.clear()


async def init_local_embeddings() -> bool:
    """Charge le modèle local (téléchargé une seule fois dans le dossier ΣIRIUS).

    Échec silencieux (hors-ligne, fastembed absent…) : les niveaux API Gemini
    puis mots-clés restent disponibles. Réessayé à chaque cycle de warmup.
    """
    if not _LOCAL_EMBED_ENABLED:
        return False
    if _local_model_instance is not None:
        return True
    try:
        model = await asyncio.to_thread(_load_local_model_sync)
    except Exception as error:
        logger.info("[SEMANTIC] embeddings locaux indisponibles (%r) — repli API/mots-clés", error)
        return False
    with _local_model_lock:
        if _local_model_instance is None:
            _activate_local_model(model)
            logger.info("[SEMANTIC] embeddings 100%% locaux actifs : %s", LOCAL_EMBED_REPO)
    return True


def _local_encode(model, texts):
    return [[float(x) for x in vector] for vector in model.embed(list(texts))]


def _remember_vector(fact_id: str, vector):
    if len(_vector_cache) >= _VECTOR_CACHE_MAX:
        _vector_cache.pop(next(iter(_vector_cache)))
    _vector_cache[fact_id] = list(vector)


def _fact_vector(fact_id: str):
    """Vecteur d'un fait : RAM d'abord, sinon SQLite (puis mémorisé en RAM)."""
    vector = _vector_cache.get(fact_id)
    if vector is None:
        vector = get_cached_vector(fact_id, EMBED_MODEL)
        if vector is not None:
            _remember_vector(fact_id, vector)
    return vector


def _cosine(a, b) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def _batch_similarities(query_vec, vectors):
    """Similarités cosinus requête ↔ N vecteurs, en une opération matricielle."""
    if not vectors:
        return []
    if _np is not None:
        matrix = _np.asarray(vectors, dtype=_np.float32)
        query = _np.asarray(query_vec, dtype=_np.float32)
        query_norm = float(_np.linalg.norm(query)) or 1.0
        norms = _np.linalg.norm(matrix, axis=1) * query_norm
        norms[norms == 0.0] = 1.0
        return [float(s) for s in (matrix @ query) / norms]
    return [_cosine(query_vec, v) for v in vectors]


async def _embed_batch(texts):
    """Vectorise un lot de textes : modèle local d'abord, sinon API Gemini.

    Réglages serrés côté API : le rappel sémantique est un bonus de pertinence,
    jamais un goulot — au pire ~2,5 s puis repli mots-clés, et disjoncteur après
    3 échecs (60 s). Le modèle local, lui, répond en ~10 ms sans réseau.
    """
    model = _local_model_instance
    if model is not None:
        return await asyncio.to_thread(_local_encode, model, texts)

    from google import genai

    client = genai.Client(api_key=_EMBED_API_KEY)

    async def _call():
        response = await client.aio.models.embed_content(model=EMBED_MODEL, contents=list(texts))
        return [item.values for item in response.embeddings]

    return await resilient_call(
        _call, service="embeddings", attempts=1, timeout=2.5,
        failure_threshold=3, reset_timeout=60.0,
    )


async def _query_vector(query: str):
    key = (query or "").strip().lower()[:300]
    if not key:
        return None
    if key in _query_cache:
        return _query_cache[key]
    vectors = await _embed_batch([key])
    vector = vectors[0] if vectors else None
    if vector:
        if len(_query_cache) >= _QUERY_CACHE_MAX:
            _query_cache.pop(next(iter(_query_cache)))
        _query_cache[key] = vector
    return vector


async def _ensure_vectors(facts):
    """Vectorise (et met en cache) uniquement les faits sans vecteur connu."""
    missing = [f for f in facts if _fact_vector(f["id"]) is None]
    if not missing:
        return
    vectors = await _embed_batch([f["text"][:400] for f in missing])
    for fact, vector in zip(missing, vectors or []):
        if vector:
            store_vector(fact["id"], EMBED_MODEL, vector)
            _remember_vector(fact["id"], vector)
    _user_index.clear()  # l'index par utilisateur intégrera les nouveaux vecteurs


async def semantic_rerank(query: str, facts: list, top_k: int = 8) -> list:
    """Reclasse les faits par similarité sémantique avec la requête.

    Sans clé d'embeddings ou en cas d'échec réseau, renvoie simplement les
    `top_k` premiers faits (ordre du rappel par mots-clés) : jamais bloquant.
    """
    if not facts:
        return []
    if not embeddings_available() or len(facts) <= 1:
        return facts[:top_k]
    try:
        query_vec = await _query_vector(query)
        if not query_vec:
            return facts[:top_k]

        await _ensure_vectors(facts)

        dim = len(query_vec)
        entries = []
        for position, fact in enumerate(facts):
            vector = _fact_vector(fact["id"])
            entries.append((position, fact, vector if vector and len(vector) == dim else None))
        valid = [(p, v) for p, _, v in entries if v is not None]
        sims = _batch_similarities(query_vec, [v for _, v in valid])
        sim_by_pos = {p: s for (p, _), s in zip(valid, sims)}

        scored = []
        for position, fact, _ in entries:
            # Combine similarité sémantique (dominante) et rang mots-clés (stabilité).
            keyword_rank_bonus = (len(facts) - position) / len(facts) * 0.15
            scored.append((sim_by_pos.get(position, 0.0) + keyword_rank_bonus, position, fact))
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [fact for _, _, fact in scored[:top_k]]
    except Exception as error:
        logger.warning("[SEMANTIC] repli mots-clés: %r", error)
        return facts[:top_k]


def _user_vector_index(user_id: str):
    """Index vectoriel d'un utilisateur (faits + vecteurs), avec TTL en RAM."""
    entry = _user_index.get(user_id)
    if entry and time.monotonic() - entry["stamp"] < _USER_INDEX_TTL:
        return entry["facts"]
    facts = vectorized_facts(user_id, EMBED_MODEL)
    _user_index[user_id] = {"stamp": time.monotonic(), "facts": facts}
    return facts


async def semantic_recall(query: str, seed_facts: list, user_id: str, top_k: int = 8) -> list:
    """Rappel vectoriel complet : cherche dans TOUS les souvenirs vectorisés.

    Fusionne les candidats mots-clés (`seed_facts`) avec l'index vectoriel de
    l'utilisateur : un souvenir sans aucun mot commun avec la question reste
    retrouvable par le sens. Repli transparent sur les mots-clés si indisponible.
    """
    if not embeddings_available():
        return seed_facts[:top_k]
    try:
        query_vec = await _query_vector(query)
        if not query_vec:
            return seed_facts[:top_k]

        await _ensure_vectors(seed_facts)

        dim = len(query_vec)
        pool, vectors = {}, {}
        for fact in _user_vector_index(user_id):
            vector = fact.get("vector")
            if vector and len(vector) == dim:
                fact_id = fact["id"]
                pool[fact_id] = {k: v for k, v in fact.items() if k != "vector"}
                vectors[fact_id] = vector
        seed_rank = {}
        for position, fact in enumerate(seed_facts):
            fact_id = fact["id"]
            seed_rank[fact_id] = position
            pool.setdefault(fact_id, fact)
            if fact_id not in vectors:
                vector = _fact_vector(fact_id)
                if vector and len(vector) == dim:
                    vectors[fact_id] = vector
        if not pool:
            return seed_facts[:top_k]

        ids = list(pool)
        with_vector = [fact_id for fact_id in ids if fact_id in vectors]
        sims = _batch_similarities(query_vec, [vectors[fact_id] for fact_id in with_vector])
        sim_by_id = dict(zip(with_vector, sims))

        total_seeds = max(len(seed_facts), 1)
        scored = []
        for fact_id in ids:
            bonus = 0.0
            if fact_id in seed_rank:
                # Bonus mots-clés : stabilise l'ordre des candidats déjà pertinents.
                bonus = (total_seeds - seed_rank[fact_id]) / total_seeds * 0.15
            scored.append((sim_by_id.get(fact_id, 0.0) + bonus, pool[fact_id]))
        scored.sort(key=lambda item: -item[0])
        return [fact for _, fact in scored[:top_k]]
    except Exception as error:
        logger.warning("[SEMANTIC] rappel vectoriel replié sur mots-clés: %r", error)
        return seed_facts[:top_k]


# =========================================================
# PRÉ-VECTORISATION EN TÂCHE DE FOND : zéro latence au rappel
# =========================================================

async def vectorize_missing(batch_size: int = 32, max_batches: int = 8) -> int:
    """Vectorise les faits en attente, par lots. Renvoie le nombre traité."""
    if not embeddings_available():
        return 0
    total = 0
    for _ in range(max_batches):
        pending = facts_missing_vectors(EMBED_MODEL, limit=batch_size)
        if not pending:
            break
        vectors = await _embed_batch([f["text"][:400] for f in pending])
        if not vectors:
            break
        for fact, vector in zip(pending, vectors):
            if vector:
                store_vector(fact["id"], EMBED_MODEL, vector)
                _remember_vector(fact["id"], vector)
                total += 1
        _user_index.clear()
    if total:
        logger.info("[SEMANTIC] %d souvenir(s) pré-vectorisé(s)", total)
    return total


async def vector_warmup_loop(interval: float = 300.0):
    """Pré-vectorise en continu les nouveaux souvenirs, sans bloquer le rappel.

    Tente aussi d'activer les embeddings locaux (téléchargement du modèle la
    première fois, puis chargement instantané) : réessayé à chaque cycle tant
    qu'ils ne sont pas prêts (ex. premier démarrage hors-ligne).
    """
    while True:
        try:
            await init_local_embeddings()
            await vectorize_missing()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning("[SEMANTIC] pré-vectorisation reportée: %r", error)
        await asyncio.sleep(interval)
