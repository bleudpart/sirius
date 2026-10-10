"""Recent sports headlines from the public Franceinfo RSS feed."""

import logging
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
import re
from urllib.parse import urlparse
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

import httpx

logger = logging.getLogger(__name__)
SPORTS_FEED_URL = "https://www.franceinfo.fr/sports.rss"
_cache = {"t": 0.0, "articles": []}


def parse_news_feed(content: bytes, now: datetime, source: str, max_age_hours=None) -> list[dict]:
    if len(content) > 2 * 1024 * 1024 or b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
        raise ValueError("Invalid sports RSS payload")
    try:
        root = ElementTree.fromstring(content)
    except ElementTree.ParseError as error:
        raise ValueError("Invalid sports RSS XML") from error
    paris = ZoneInfo("Europe/Paris")
    articles = []
    seen = set()
    for item in root.findall("./channel/item"):
        title = " ".join((item.findtext("title") or "").split())
        url = (item.findtext("link") or "").strip()
        raw_date = item.findtext("pubDate") or ""
        try:
            published = parsedate_to_datetime(raw_date)
        except (ValueError, TypeError, OverflowError):
            continue
        if published is None or published.tzinfo is None:
            continue
        if published > now:
            continue
        if max_age_hours is None and published.astimezone(paris).date() != now.astimezone(paris).date():
            continue
        if max_age_hours is not None and (now - published).total_seconds() > max_age_hours * 3600:
            continue
        parsed_url = urlparse(url)
        if not title or parsed_url.scheme != "https" or parsed_url.hostname not in {"www.franceinfo.fr", "www.francetvinfo.fr"}:
            continue
        if url in seen:
            continue
        seen.add(url)
        description = " ".join(unescape(re.sub(r"<[^>]*>", " ", item.findtext("description") or "")).split())
        articles.append({"titre": title, "source": source, "url": url, "date": published.isoformat(),
                         "description": description[:300]})
    return sorted(articles, key=lambda article: datetime.fromisoformat(article["date"]), reverse=True)


def parse_sports_feed(content: bytes, now: datetime) -> list[dict]:
    return parse_news_feed(content, now, "Franceinfo Sport")


async def fetch_sports_headlines(limit: int = 5) -> dict:
    now = datetime.now(timezone.utc)
    if time.monotonic() - _cache["t"] < 300 and _cache["articles"]:
        paris = ZoneInfo("Europe/Paris")
        articles = [article for article in _cache["articles"]
                    if datetime.fromisoformat(article["date"]).astimezone(paris).date() == now.astimezone(paris).date()]
        if articles:
            return {"articles": articles[:limit]}
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            response = await client.get(SPORTS_FEED_URL)
            response.raise_for_status()
        articles = parse_sports_feed(response.content, now)
    except (httpx.HTTPError, ElementTree.ParseError, ValueError) as error:
        logger.warning("[SPORT] Franceinfo RSS unavailable (%s)", type(error).__name__)
        raise
    if not articles:
        logger.warning("[SPORT] No dated sports headlines for today in Franceinfo RSS")
    _cache.update({"t": time.monotonic(), "articles": articles})
    return {"articles": articles[:limit]}
