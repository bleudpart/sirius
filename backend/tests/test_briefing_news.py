import asyncio
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from xml.sax.saxutils import escape

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


def test_all_ten_news_categories_fetch_without_key_and_report_partial_failure(monkeypatch):
    monkeypatch.setattr(briefing_news, "_cache", {"t": 0.0, "date": "", "sections": []})
    called = []

    class Client:
        def __init__(self, **kwargs):
            assert kwargs["timeout"] == 8

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url, **kwargs):
            called.append(url)
            await asyncio.sleep(0)
            if url.endswith("/sante.rss") or "sant%C3%A9" in url:
                return httpx.Response(503, request=httpx.Request("GET", url))
            date = format_datetime(datetime.now(timezone.utc) - timedelta(minutes=1))
            xml = f"""<rss><channel><item><title>Actualite recente</title>
            <description>Contexte</description><link>{escape(url.replace('.rss', '/article'))}</link>
            <pubDate>{date}</pubDate></item></channel></rss>"""
            return httpx.Response(200, text=xml, request=httpx.Request("GET", url))

    monkeypatch.setattr(briefing_news.httpx, "AsyncClient", Client)
    result = asyncio.run(briefing_news.fetch_briefing_news())
    assert len(called) == 11
    assert len(result["sections"]) == 10
    assert briefing_news.MARKET_NEWS_URL in called
    market = next(section for section in result["sections"] if section["id"] == "bourse")
    assert market["label"] == "Bourse internationale"
    assert market["articles"][0]["source"] == "Google Actualités"
    health = next(section for section in result["sections"] if section["id"] == "sante")
    assert health["status"] == "unavailable"
    assert health["articles"] == []
    assert briefing_news._cache["sections"] == result["sections"]
    assert asyncio.run(briefing_news.fetch_briefing_news()) == result
    assert len(called) == 11
    text = briefing_news.news_briefing_text(result["sections"])
    for _, label, _ in briefing_news.NEWS_SECTIONS:
        assert f"{label} :" in text
    assert "Santé : source temporairement indisponible" in text
    assert "Source : Franceinfo" in text


def test_market_feed_keeps_recent_publisher_and_link_without_weakening_default_hosts():
    now = datetime(2026, 10, 16, 15, tzinfo=timezone.utc)
    def item(title, hours, url="https://news.google.com/rss/articles/example"):
        published = format_datetime(now - timedelta(hours=hours))
        return f"<item><title>{title}</title><link>{url}</link><pubDate>{published}</pubDate><source>Journal financier</source></item>"
    xml = ("<rss><channel>" + item("Wall Street - Journal financier", 1)
           + item("Wall Street - Journal financier", 1, "https://news.google.com/rss/articles/duplicate")
           + item("Ancienne clôture", 49)
           + item("Futur", -1) + item("Lien interdit", 1, "https://untrusted.example/article")
           + "</channel></rss>").encode()
    assert parse_news_feed(xml, now, "Franceinfo", max_age_hours=48) == []
    articles = parse_news_feed(xml, now, "Google Actualités", max_age_hours=48,
                               allowed_hosts=("news.google.com",), use_item_source=True)
    assert len(articles) == 1
    assert articles[0]["titre"] == "Wall Street"
    assert articles[0]["source"] == "Journal financier"
    assert articles[0]["url"] == "https://news.google.com/rss/articles/example"
    assert articles[0]["date"] == "2026-10-16T14:00:00+00:00"


def test_market_failure_is_explicit_and_does_not_remove_other_sections(monkeypatch, caplog):
    monkeypatch.setattr(briefing_news, "_cache", {"t": 0.0, "date": "", "sections": []})
    real_client = httpx.AsyncClient
    def handler(request):
        if request.url.host == "news.google.com":
            return httpx.Response(503)
        return httpx.Response(200, text="<rss><channel/></rss>")
    monkeypatch.setattr(briefing_news.httpx, "AsyncClient", lambda **kwargs: real_client(
        transport=httpx.MockTransport(handler), **kwargs,
    ))
    result = asyncio.run(briefing_news.fetch_briefing_news())
    assert len(result["sections"]) == 10
    market = next(section for section in result["sections"] if section["id"] == "bourse")
    assert market["status"] == "unavailable"
    assert "Bourse internationale : source temporairement indisponible" in briefing_news.news_briefing_text(result["sections"])
    assert "bourse unavailable" in caplog.text


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


def test_sections_recover_from_failed_or_empty_primary_feed(monkeypatch, caplog):
    monkeypatch.setattr(briefing_news, "_cache", {"t": 0.0, "date": "", "sections": []})
    real_client = httpx.AsyncClient
    calls = []
    date = format_datetime(datetime.now(timezone.utc) - timedelta(minutes=1))

    def handler(request):
        calls.append(request)
        if request.url.host != "news.google.com":
            if request.url.path == "/sante.rss":
                return httpx.Response(503)
            return httpx.Response(200, text="<rss><channel/></rss>")
        return httpx.Response(200, text=f"""<rss><channel><item>
            <title>Information vérifiée - Journal</title>
            <link>https://news.google.com/rss/articles/verified</link>
            <pubDate>{date}</pubDate><source>Journal</source>
            </item></channel></rss>""")

    monkeypatch.setattr(briefing_news.httpx, "AsyncClient", lambda **kwargs: real_client(
        transport=httpx.MockTransport(handler), **kwargs,
    ))
    sections = asyncio.run(briefing_news.fetch_briefing_news())["sections"]
    assert len(sections) == 10
    assert all(section["status"] == "ok" for section in sections)
    assert all(section["articles"][0]["source"] == "Journal" for section in sections)
    assert len(calls) == 19
    assert all(request.extensions["timeout"]["read"] == 4 for request in calls)
    assert "sante unavailable via www.franceinfo.fr" in caplog.text


def test_all_sources_failed_report_unavailable_without_inventing_articles(monkeypatch):
    monkeypatch.setattr(briefing_news, "_cache", {"t": 0.0, "date": "", "sections": []})
    real_client = httpx.AsyncClient
    monkeypatch.setattr(briefing_news.httpx, "AsyncClient", lambda **kwargs: real_client(
        transport=httpx.MockTransport(lambda request: httpx.Response(503)), **kwargs,
    ))
    sections = asyncio.run(briefing_news.fetch_briefing_news())["sections"]
    assert len(sections) == 10
    assert all(section["status"] == "unavailable" and section["articles"] == [] for section in sections)


def test_fallback_develops_two_distinct_available_stories_per_section():
    def article(title, url):
        return {"titre": title, "description": "Contexte factuel fourni.", "source": "Franceinfo",
                "date": "2026-10-13T08:00:00+00:00", "url": url}
    text = briefing_news.news_briefing_text([{
        "label": "France", "status": "ok",
        "articles": [article("Premier fait", "https://example.com/1"),
                     article("Deuxième fait", "https://example.com/2")],
    }])
    assert "Premier fait" in text and "Deuxième fait" in text
    assert text.count("Contexte factuel fourni.") == 2
