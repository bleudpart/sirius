"""Mémoire épisodique SIRIUS : condensation des conversations pendant les temps morts.

Une boucle de fond scanne les sessions de chat inactives depuis plus de
IDLE_MINUTES. Pour chaque session ayant de nouveaux échanges non condensés,
le LLM produit un résumé (épisode) + des faits durables, stockés dans la
mémoire locale SQLite. Le curseur `condensed_len` de la session avance pour
ne jamais condenser deux fois le même passage.
"""

import asyncio
import logging
from datetime import datetime, timezone, timedelta

from local_memory import add_episode, learn_fact

logger = logging.getLogger("sirius.episodic")

IDLE_MINUTES = 15
SCAN_INTERVAL_SECONDS = 600  # passage toutes les 10 minutes
MIN_NEW_TURNS = 4            # au moins 2 échanges complets avant condensation


def _user_id_from_session(session_id: str) -> str:
    # Format serveur : "<user_id>:<nom_de_session>"
    return (session_id or "").rsplit(":", 1)[0] or "legacy"


async def condense_idle_sessions(db, summarize, now=None) -> int:
    """Condense les sessions inactives. Retourne le nombre d'épisodes créés.

    `summarize` est injecté (généralement sirius_brain.summarize_episode) pour
    rester testable sans réseau.
    """
    now = now or datetime.now(timezone.utc)
    idle_cutoff = (now - timedelta(minutes=IDLE_MINUTES)).isoformat()
    created = 0

    cursor = db.sirius_chats.find(
        {"updated_at": {"$lt": idle_cutoff}},
        {"_id": 0, "session_id": 1, "history": 1, "updated_at": 1, "condensed_len": 1},
    )
    async for doc in cursor:
        session_id = doc.get("session_id") or ""
        history = doc.get("history") or []
        condensed_len = int(doc.get("condensed_len") or 0)
        fresh = history[condensed_len:]
        if len(fresh) < MIN_NEW_TURNS:
            continue

        episode = await summarize(fresh)
        if not episode:
            continue

        user_id = _user_id_from_session(session_id)
        add_episode(user_id, episode["resume"], session_id=session_id)
        for fact in episode.get("faits") or []:
            try:
                learn_fact(fact, user_id=user_id)
            except Exception:
                logger.exception("[EPISODIC] fait non persisté")

        await db.sirius_chats.update_one(
            {"session_id": session_id},
            {"$set": {"condensed_len": len(history)}},
        )
        created += 1
        logger.info("[EPISODIC] Épisode condensé pour %s (%d tours)", session_id, len(fresh))
        await asyncio.sleep(2.0)  # espace les appels Groq pour rester sous la limite TPM

    return created


async def episodic_loop(db, summarize):
    """Boucle de fond : condensation périodique pendant les temps morts."""
    while True:
        try:
            await condense_idle_sessions(db, summarize)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[EPISODIC] cycle de condensation échoué")
        await asyncio.sleep(SCAN_INTERVAL_SECONDS)
