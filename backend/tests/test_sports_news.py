import asyncio
from datetime import datetime, timezone

import httpx
import pytest

import sports_news


def test_sports_feed_only_uses_today_dated_trusted_unique_headlines():
    feed = b"""<rss><channel>
    <item><title>Today's result</title><link>https://www.franceinfo.fr/sports/result</link><pubDate>Sat, 10 Oct 2026 16:00:00 +0200</pubDate></item>
    <item><title>Duplicate</title><link>https://www.franceinfo.fr/sports/result</link><pubDate>Sat, 10 Oct 2026 16:00:00 +0200</pubDate></item>
    <item><title>Yesterday</title><link>https://www.franceinfo.fr/sports/old</link><pubDate>Fri, 09 Oct 2026 16:00:00 +0200</pubDate></item>
    <item><title>Future</title><link>https://www.franceinfo.fr/sports/future</link><pubDate>Sat, 10 Oct 2026 20:00:00 +0200</pubDate></item>
    <item><title>No date</title><link>https://www.franceinfo.fr/sports/undated</link></item>
    <item><title>Untrusted</title><link>https://example.com/sports</link><pubDate>Sat, 10 Oct 2026 16:00:00 +0200</pubDate></item>
    </channel></rss>"""
    articles = sports_news.parse_sports_feed(feed, datetime(2026, 10, 10, 16, tzinfo=timezone.utc))
    assert len(articles) == 1
    assert articles[0]["titre"] == "Today's result"
    assert articles[0]["source"] == "Franceinfo Sport"
    assert articles[0]["date"] == "2026-10-10T16:00:00+02:00"


@pytest.mark.parametrize("payload", [b"<broken", b"<!DOCTYPE rss><rss/>", b"x" * (2 * 1024 * 1024 + 1)],
                         ids=["malformed", "doctype", "oversized"])
def test_invalid_sports_feeds_fail_explicitly(payload):
    with pytest.raises(ValueError):
        sports_news.parse_sports_feed(payload, datetime.now(timezone.utc))


def test_sports_http_failure_is_logged_and_not_cached(monkeypatch, caplog):
    monkeypatch.setattr(sports_news, "_cache", {"t": 0.0, "articles": []})

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url):
            return httpx.Response(503, request=httpx.Request("GET", url))

    monkeypatch.setattr(sports_news.httpx, "AsyncClient", Client)
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(sports_news.fetch_sports_headlines())
    assert "Franceinfo RSS unavailable" in caplog.text
    assert sports_news._cache["articles"] == []
