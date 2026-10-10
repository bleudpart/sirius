import asyncio
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import httpx

import briefing_news
from sports_news import parse_news_feed


def test_recent_news_carries_description_source_url_and_timezone():
    now = datetime(2026, 10, 10, 16, tzinfo=timezone.utc)
    published = format_datetime(now - timedelta(hours=30))
    xml = f"""<rss><channel><item><title>Un fait</title>
    <description>&lt;p&gt;Un contexte &amp;amp; une explication.&lt;/p&gt;</description>
    <link>https://www.franceinfo.fr/actualite</link><pubDate>{published}</pubDate>
    </item></channel></rss>""".encode()
    articles = parse_news_feed(xml, now, "Franceinfo", max_age_hours=48)
    assert articles[0]["description"] == "Un contexte & une explication."
    assert articles[0]["date"] == "2026-10-09T10:00:00+00:00"
    assert parse_news_feed(xml, now, "Franceinfo", max_age_hours=24) == []


def test_all_nine_news_categories_fetch_without_key_and_report_partial_failure(monkeypatch):
    monkeypatch.setattr(briefing_news, "_cache", {"t": 0.0, "date": "", "sections": []})
    called = []

    class Client:
        def __init__(self, **kwargs):
            assert kwargs["timeout"] == 8

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url):
            called.append(url)
            await asyncio.sleep(0)
            if url.endswith("/sante.rss"):
                return httpx.Response(503, request=httpx.Request("GET", url))
            date = format_datetime(datetime.now(timezone.utc) - timedelta(minutes=1))
            xml = f"""<rss><channel><item><title>Actualite recente</title>
            <description>Contexte</description><link>{url.replace('.rss', '/article')}</link>
            <pubDate>{date}</pubDate></item></channel></rss>"""
            return httpx.Response(200, text=xml, request=httpx.Request("GET", url))

    monkeypatch.setattr(briefing_news.httpx, "AsyncClient", Client)
    result = asyncio.run(briefing_news.fetch_briefing_news())
    assert len(called) == 9
    assert len(result["sections"]) == 9
    health = next(section for section in result["sections"] if section["id"] == "sante")
    assert health["status"] == "unavailable"
    assert health["articles"] == []
    assert briefing_news._cache["sections"] == result["sections"]
    assert asyncio.run(briefing_news.fetch_briefing_news()) == result
    assert len(called) == 9
    text = briefing_news.news_briefing_text(result["sections"])
    for _, label, _ in briefing_news.NEWS_SECTIONS:
        assert f"{label} :" in text
    assert "Santé : source temporairement indisponible" in text
    assert "Source : Franceinfo" in text


def test_duplicate_events_and_empty_sections_are_not_invented():
    article = {"titre": "Fait confirmé", "description": "Contexte", "source": "Franceinfo",
               "date": "2026-10-10T14:00:00+00:00", "url": "https://www.franceinfo.fr/item"}
    text = briefing_news.news_briefing_text([
        {"label": "France", "status": "ok", "articles": [article]},
        {"label": "Politique", "status": "ok", "articles": [article]},
        {"label": "Sport", "status": "empty", "articles": []},
    ])
    assert text.count("Fait confirmé") == 1
    assert "Politique : même événement déjà cité" in text
    assert "Sport : aucune information datée" in text
