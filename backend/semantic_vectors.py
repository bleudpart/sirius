"""Rappel sémantique SIRIUS : reclassement des souvenirs par similarité d'embeddings.

Les vecteurs sont calculés via une API d'embeddings compatible OpenAI quand une
clé est disponible (OPENAI_API_KEY), puis MIS EN CACHE LOCALEMENT en SQLite :
chaque fait n'est vectorisé qu'une seule fois. Sans clé ou hors-ligne, le module
se retire silencieusement — le rappel par mots-clés + synonymes reste actif.
"""

import logging
import math
import os

from local_memory import get_cached_vector, store_vector
from resilience import resilient_call

logger = logging.getLogger("sirius.semantic")

EMBED_MODEL = os.getenv("SIRIUS_EMBED_MODEL", "text-embedding-3-small")
_EMBED_API_KEY = (os.getenv("OPENAI_API_KEY") or "").strip()
_QUERY_CACHE_MAX = 128
_query_cache = {}


def embeddings_available() -> bool:
    return bool(_EMBED_API_KEY)


def _cosine(a, b) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


async def _embed_batch(texts):
    """Vectorise un lot de textes via l'API, protégé par la couche de résilience."""
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=_EMBED_API_KEY, max_retries=0, timeout=8.0)

    async def _call():
        response = await client.embeddings.create(model=EMBED_MODEL, input=list(texts))
        return [item.embedding for item in response.data]

    return await resilient_call(
        _call, service="embeddings", attempts=2, timeout=10.0, base_delay=0.3
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

        # Vectorise uniquement les faits absents du cache local.
        missing = [f for f in facts if get_cached_vector(f["id"], EMBED_MODEL) is None]
        if missing:
            vectors = await _embed_batch([f["text"][:400] for f in missing])
            for fact, vector in zip(missing, vectors):
                store_vector(fact["id"], EMBED_MODEL, vector)

        scored = []
        for position, fact in enumerate(facts):
            vector = get_cached_vector(fact["id"], EMBED_MODEL)
            similarity = _cosine(query_vec, vector) if vector else 0.0
            # Combine similarité sémantique (dominante) et rang mots-clés (stabilité).
            keyword_rank_bonus = (len(facts) - position) / len(facts) * 0.15
            scored.append((similarity + keyword_rank_bonus, fact))
        scored.sort(key=lambda item: -item[0])
        return [fact for _, fact in scored[:top_k]]
    except Exception as error:
        logger.warning("[SEMANTIC] repli mots-clés: %r", error)
        return facts[:top_k]
