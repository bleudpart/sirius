"""Dated, categorized briefing sources fetched concurrently without API keys."""

import asyncio
import logging
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx

from sports_news import parse_news_feed

logger = logging.getLogger(__name__)
NEWS_SECTIONS = (
    ("france", "France", "france"),
    ("monde", "International", "monde"),
    ("politique", "Politique", "politique"),
    ("economie", "Économie", "economie"),
    ("bourse", "Bourse internationale", "bourse"),
    ("sport", "Sport", "sports"),
    ("sante", "Santé", "sante"),
    ("sciences", "Sciences et technologies", "sciences"),
    ("environnement", "Environnement", "monde/environnement"),
    ("culture", "Culture", "culture"),
)
MARKET_NEWS_URL = "https://news.google.com/rss/search?" + urlencode({
    "q": '(bourse OR "marchés boursiers") ("Wall Street" OR Nasdaq OR "S&P 500" OR Nikkei OR "Hang Seng" OR "Euro Stoxx") when:2d',
    "hl": "fr", "gl": "FR", "ceid": "FR:fr",
})
_SECTION_QUERIES = {
    "france": "actualité France",
    "monde": "actualité internationale",
    "politique": "politique France",
    "economie": "économie",
    "sport": "sport",
    "sante": "santé",
    "sciences": "sciences technologies",
    "environnement": "environnement climat",
    "culture": "culture",
}
_cache = {"t": 0.0, "date": "", "sections": []}
_lock = asyncio.Lock()


async def fetch_briefing_news() -> dict:
    async with _lock:
        now = datetime.now(timezone.utc)
        ttl = 60 if any(section["status"] != "ok" for section in _cache["sections"]) else 300
        if _cache["sections"] and _cache["date"] == now.date().isoformat() and time.monotonic() - _cache["t"] < ttl:
            return {"sections": _cache["sections"]}
        async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            async def fetch_section(section_id, label, path):
                market = section_id == "bourse"
                urls = [MARKET_NEWS_URL] if market else [
                    f"https://www.franceinfo.fr/{path}.rss",
                    "https://news.google.com/rss/search?" + urlencode({
                        "q": _SECTION_QUERIES[section_id] + " when:2d",
                        "hl": "fr", "gl": "FR", "ceid": "FR:fr",
                    }),
                ]
                received_feed = False
                for url in urls:
                    google = url.startswith("https://news.google.com/")
                    try:
                        response = await client.get(url, timeout=4)
                        response.raise_for_status()
                        articles = parse_news_feed(
                            response.content, now, "Google Actualités" if google else "Franceinfo",
                            max_age_hours=48,
                            allowed_hosts=("news.google.com",) if google else ("www.franceinfo.fr", "www.francetvinfo.fr"),
                            use_item_source=google,
                        )[:2]
                        received_feed = True
                    except (httpx.HTTPError, ValueError) as error:
                        logger.warning("[BRIEFING NEWS] %s unavailable via %s (%s)",
                                       section_id, url.split("/")[2], type(error).__name__)
                        continue
                    if articles:
                        return {"id": section_id, "label": label, "status": "ok", "articles": articles}
                    logger.info("[BRIEFING NEWS] %s has no recent dated articles via %s", section_id, url.split("/")[2])
                return {"id": section_id, "label": label,
                        "status": "empty" if received_feed else "unavailable", "articles": []}
            sections = await asyncio.gather(*(fetch_section(*section) for section in NEWS_SECTIONS))
        _cache.update({"t": time.monotonic(), "date": now.date().isoformat(), "sections": sections})
        return {"sections": sections}


def news_briefing_text(sections: list[dict]) -> str:
    parts = []
    seen = set()
    for section in sections:
        articles = [article for article in section["articles"] if article["url"] not in seen]
        if articles:
            details = []
            for article in articles[:2]:
                if article["url"] in seen:
                    continue
                seen.add(article["url"])
                detail = article.get("description", "")
                details.append(f"{article['titre']}. {detail} "
                               f"Source : {article['source']}, publié le {article['date']}. "
                               f"URL : {article['url']}")
            parts.append(f"{section['label']} : " + " ".join(details))
        elif section["status"] == "unavailable":
            parts.append(f"{section['label']} : source temporairement indisponible.")
        elif not section["articles"]:
            parts.append(f"{section['label']} : aucune information datée des dernières 48 heures disponible.")
        else:
            parts.append(f"{section['label']} : même événement déjà cité dans une autre rubrique.")
    return " ".join(parts)
