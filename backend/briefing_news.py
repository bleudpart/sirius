"""Dated, categorized briefing sources fetched concurrently without API keys."""

import asyncio
import logging
import time
from datetime import datetime, timezone

import httpx

from sports_news import parse_news_feed

logger = logging.getLogger(__name__)
NEWS_SECTIONS = (
    ("france", "France", "france"),
    ("monde", "International", "monde"),
    ("politique", "Politique", "politique"),
    ("economie", "Économie", "economie"),
    ("sport", "Sport", "sports"),
    ("sante", "Santé", "sante"),
    ("sciences", "Sciences et technologies", "sciences"),
    ("environnement", "Environnement", "monde/environnement"),
    ("culture", "Culture", "culture"),
)
_cache = {"t": 0.0, "date": "", "sections": []}
_lock = asyncio.Lock()


async def fetch_briefing_news() -> dict:
    async with _lock:
        now = datetime.now(timezone.utc)
        ttl = 60 if any(section["status"] == "unavailable" for section in _cache["sections"]) else 300
        if _cache["sections"] and _cache["date"] == now.date().isoformat() and time.monotonic() - _cache["t"] < ttl:
            return {"sections": _cache["sections"]}
        async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            async def fetch_section(section_id, label, path):
                try:
                    response = await client.get(f"https://www.franceinfo.fr/{path}.rss")
                    response.raise_for_status()
                    articles = parse_news_feed(response.content, now, "Franceinfo", max_age_hours=48)[:2]
                except (httpx.HTTPError, ValueError) as error:
                    logger.warning("[BRIEFING NEWS] %s unavailable (%s)", section_id, type(error).__name__)
                    return {"id": section_id, "label": label, "status": "unavailable", "articles": []}
                if not articles:
                    logger.info("[BRIEFING NEWS] %s has no recent dated articles", section_id)
                return {"id": section_id, "label": label, "status": "ok" if articles else "empty", "articles": articles}
            sections = await asyncio.gather(*(fetch_section(*section) for section in NEWS_SECTIONS))
        _cache.update({"t": time.monotonic(), "date": now.date().isoformat(), "sections": sections})
        return {"sections": sections}


def news_briefing_text(sections: list[dict]) -> str:
    parts = []
    seen = set()
    for section in sections:
        articles = [article for article in section["articles"] if article["url"] not in seen]
        if articles:
            article = articles[0]
            seen.add(article["url"])
            detail = article.get("description", "")
            parts.append(f"{section['label']} : {article['titre']}. {detail} "
                         f"Source : {article['source']}, publié le {article['date'][:10]}.")
        elif section["status"] == "unavailable":
            parts.append(f"{section['label']} : source temporairement indisponible.")
        elif not section["articles"]:
            parts.append(f"{section['label']} : aucune information datée des dernières 48 heures disponible.")
        else:
            parts.append(f"{section['label']} : même événement déjà cité dans une autre rubrique.")
    return " ".join(parts)
