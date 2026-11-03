import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

import osiris_watch as watch
import weather_bulletin

NOW = datetime(2026, 5, 2, 6, 0, tzinfo=timezone.utc)
PARIS = {"name": "Paris", "country": "France", "latitude": 48.8566, "longitude": 2.3522}
SETTINGS = {"enabled": True, "city": "Paris", "location": PARIS,
            "meteo_locale": True, "evenements": True, "marches": True}


def iso(delta=timedelta()):
    return (NOW + delta).isoformat().replace("+00:00", "Z")


def events_payload():
    return {"timestamp": iso(-timedelta(minutes=10)), "total": 5, "events": [
        {"id": "a", "title": "Crue de la Seine", "type": "Flood", "severity": "medium",
         "lat": 49.44, "lng": 1.10, "date": iso(-timedelta(hours=3)), "provider": "NASA EONET",
         "source": "https://eonet.gsfc.nasa.gov/a"},
        {"id": "b", "title": "Orage violent", "type": "Storm", "severity": "high",
         "lat": 47.9, "lng": 1.9, "date": iso(-timedelta(hours=1)), "expires": iso(timedelta(hours=5)),
         "provider": "NASA EONET", "source": "javascript:alert(1)"},
        {"id": "c", "title": "Flood Warning", "severity": "high", "lat": 32.2, "lng": -110.9,
         "date": iso(), "provider": "NOAA/NWS"},
        {"id": "d", "title": "Ancienne alerte", "severity": "high", "lat": 48.9, "lng": 2.4,
         "date": iso(-timedelta(days=1)), "expires": iso(-timedelta(hours=1)), "provider": "NOAA/NWS"},
        {"id": "e", "title": "Ligne cassée", "lat": "abc", "lng": 2.4, "date": iso(), "provider": "X"},
    ]}


def quakes_payload():
    ms = lambda delta: (NOW + delta).timestamp() * 1000  # noqa: E731
    return {"timestamp": iso(-timedelta(minutes=5)), "earthquakes": [
        {"id": "q1", "lat": 48.9, "lng": 2.4, "magnitude": 2.8, "place": "Trop faible", "time": ms(-timedelta(hours=1))},
        {"id": "q2", "lat": 49.25, "lng": 4.03, "magnitude": 4.1, "place": "Près de Reims",
         "time": ms(-timedelta(hours=2)), "url": "https://earthquake.usgs.gov/q2"},
        {"id": "q3", "lat": 49.0, "lng": 2.5, "magnitude": 5.0, "place": "Trop ancien", "time": ms(-timedelta(days=10))},
    ]}


def markets_payload():
    epoch = lambda delta: int((NOW + delta).timestamp())  # noqa: E731
    return {"timestamp": iso(-timedelta(minutes=2)),
            "oil": {"Brent Crude": {"name": "Brent Crude", "symbol": "BZ=F", "price": 82.5, "currency": "USD",
                                    "change_percent": -1.23, "time": epoch(-timedelta(hours=1))}},
            "commodities": {"Wheat": {"name": "Wheat", "symbol": "ZW=F", "price": 545.25, "currency": "USX",
                                      "change_percent": 0.02, "time": epoch(-timedelta(days=2))}},
            "fx": {}}


def bulletin(max_c=24.0):
    return {"timezone": "Europe/Paris", "current": {"time": "2026-05-02T08:00"},
            "days": [{"date": "2026-05-02", "temperature_2m_min": 11.4, "temperature_2m_max": max_c,
                      "precipitation_probability_max": 40, "wind_speed_10m_max": 22.6}]}


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    watch.clear_watch_cache()
    monkeypatch.delenv("OSIRIS_BASE_URL", raising=False)
    calls = []

    async def fake_weather(name, country, latitude, longitude):
        calls.append((name, country, latitude, longitude))
        return bulletin()

    monkeypatch.setattr(weather_bulletin, "fetch_weather_at", fake_weather)
    yield calls
    watch.clear_watch_cache()


def transport(overrides=None, hits=None):
    payloads = {"/api/weather": events_payload(), "/api/earthquakes": quakes_payload(), "/api/markets": markets_payload()}

    def handler(request):
        assert request.url.host == "www.osirisai.live"
        assert not request.url.query, "aucune position ne doit être envoyée à OSIRIS"
        if hits is not None:
            hits.append(request.url.path)
        override = (overrides or {}).get(request.url.path)
        if callable(override):
            return override(request)
        return httpx.Response(200, json=payloads[request.url.path])

    return httpx.MockTransport(handler)


def build(settings=SETTINGS, **kwargs):
    return asyncio.run(watch.build_watch(settings, now=NOW, transport=transport(**kwargs)))


def test_full_watch_filters_by_distance_expiry_and_magnitude(isolated):
    report = build()
    assert report["status"] == "ok" and report["read_only"] is True
    assert report["location"] == {"name": "Paris", "country": "France"}
    assert "latitude" not in report["location"]
    assert isolated == [("Paris", "France", 48.8566, 2.3522)]
    assert [item["title"] for item in report["events"]] == [
        "Orage violent", "Crue de la Seine", "Séisme de magnitude 4,1",
    ]
    storm = report["events"][0]
    assert storm["url"] is None and storm["severity"] == "high" and 100 < storm["distance_km"] < 130
    assert all("_rank" not in item for item in report["events"])
    sources = {item["id"]: item for item in report["sources"]}
    assert sources["evenements"]["detail"] == "1 entrée(s) incomplète(s) ignorée(s)."
    assert sources["seismes"]["ok"] and sources["marches"]["ok"]
    assert [item["label"] for item in report["markets"]] == ["pétrole Brent", "blé (Chicago)"]
    assert report["missing_markets"] == ["euro/dollar"]
    assert report["meteo"]["max_c"] == 24.0 and report["meteo"]["heat"] is False


def test_watch_lines_are_sourced_french_text():
    text = "\n".join(watch.watch_lines(build()))
    assert "Veille autour de Paris (France) — informations publiques, aucune action déclenchée" in text
    assert "Météo locale aujourd'hui (prévision Open-Meteo) : 11 à 24 °C, pluie jusqu'à 40 %, vent jusqu'à 23 km/h." in text
    assert "à moins de 300 km (OSIRIS : NASA EONET, NOAA/NWS, USGS, flux mis à jour aujourd'hui à 07 h 50) : 3 signalé(s)." in text
    assert "« Orage violent » — NASA EONET, gravité élevée" in text and "jusqu'au 02/05 à 13 h 00" in text
    assert "Séisme de magnitude 4,1 — Près de Reims" in text
    assert "pas vos tarifs fournisseurs" in text
    assert "pétrole Brent 82,50 dollars, en baisse de 1,2 %" in text
    assert "blé (Chicago) 545,25 cents US, stable, cours du 30/04" in text
    assert "Non disponible : euro/dollar." in text
    assert "Vigilance officielle Météo-France non incluse." in text
    assert "Flood Warning" not in text and "Ancienne alerte" not in text and "Trop ancien" not in text


def test_heat_warning_only_from_forecast(monkeypatch):
    async def hot(*_args):
        return bulletin(max_c=31.5)

    monkeypatch.setattr(weather_bulletin, "fetch_weather_at", hot)
    text = "\n".join(watch.watch_lines(build()))
    assert "Chaleur prévue (au moins 30 °C) : relevés de température des enceintes froides à surveiller." in text


def test_not_configured_and_disabled_states_do_not_call_sources(isolated):
    hits = []
    for settings in (None, {}, {"enabled": True, "location": {"name": "X"}}):
        report = build(settings, hits=hits)
        assert report["status"] == "not_configured"
        assert "Veille locale non configurée" in watch.watch_lines(report)[1]
    disabled = build({**SETTINGS, "enabled": False}, hits=hits)
    assert disabled["status"] == "disabled" and watch.watch_lines(disabled) == []
    assert hits == [] and isolated == []


def test_toggles_limit_requested_sources(isolated):
    hits = []
    report = build({**SETTINGS, "meteo_locale": False, "evenements": False}, hits=hits)
    assert hits == ["/api/markets"] and isolated == []
    assert [item["id"] for item in report["sources"]] == ["marches"]
    assert "Météo-France" not in "\n".join(watch.watch_lines(report))


@pytest.mark.parametrize("response, message", [
    (lambda _r: httpx.Response(503, json={}), "OSIRIS a répondu HTTP 503."),
    (lambda _r: httpx.Response(200, content=b"<html>"), "Réponse OSIRIS illisible."),
    (lambda _r: httpx.Response(200, json={"ok": False, "events": []}), "OSIRIS signale une source amont indisponible."),
    (lambda _r: httpx.Response(200, json={"timestamp": iso()}), "Flux d'événements OSIRIS sans liste exploitable."),
    (lambda _r: httpx.Response(200, json={"timestamp": iso(-timedelta(hours=7)), "events": []}),
     "Flux OSIRIS trop ancien (mis à jour aujourd'hui à 01 h 00)."),
])
def test_feed_failures_are_reported_never_replaced(response, message):
    report = build(overrides={"/api/weather": response})
    sources = {item["id"]: item for item in report["sources"]}
    assert report["status"] == "partial"
    assert sources["evenements"]["ok"] is False and sources["evenements"]["detail"] == message
    assert [item["title"] for item in report["events"]] == ["Séisme de magnitude 4,1"]
    text = "\n".join(watch.watch_lines(report))
    assert f"Source indisponible : Événements naturels (OSIRIS — NASA EONET, NOAA/NWS) — {message} Aucune valeur remplacée." in text
    assert "Crue de la Seine" not in text


def test_network_error_and_oversized_payload(monkeypatch):
    def broken(request):
        raise httpx.ConnectError("refus", request=request)

    monkeypatch.setattr(watch, "MAX_PAYLOAD_BYTES", 100)
    report = build(overrides={"/api/earthquakes": broken})
    details = {item["id"]: item["detail"] for item in report["sources"]}
    assert details["seismes"] == "OSIRIS ne répond pas pour le moment."
    assert details["evenements"] == details["marches"] == "Réponse OSIRIS trop volumineuse."
    assert report["meteo"] is not None and report["status"] == "partial"


def test_all_sources_down_is_unavailable(monkeypatch):
    async def limited(*_args):
        raise weather_bulletin.WeatherRateLimitedError("429")

    monkeypatch.setattr(weather_bulletin, "fetch_weather_at", limited)
    down = lambda _r: httpx.Response(502)  # noqa: E731
    report = build(overrides={path: down for path in ("/api/weather", "/api/earthquakes", "/api/markets")})
    assert report["status"] == "unavailable"
    assert report["events"] == [] and report["markets"] == [] and report["meteo"] is None
    assert {item["id"]: item["detail"] for item in report["sources"]}["meteo"] == "Limite de requêtes Open-Meteo atteinte."


def test_stale_market_quotes_are_missing_not_shown():
    old = markets_payload()
    for group in ("oil", "commodities"):
        for row in old[group].values():
            row["time"] = int((NOW - timedelta(days=6)).timestamp())
    report = build(overrides={"/api/markets": lambda _r: httpx.Response(200, json=old)})
    sources = {item["id"]: item for item in report["sources"]}
    assert sources["marches"]["detail"] == "Aucun repère de marché exploitable dans le flux OSIRIS."
    assert report["markets"] == []


def test_successes_and_failures_are_cached():
    hits = []
    build(hits=hits)
    build(hits=hits)
    assert sorted(hits) == ["/api/earthquakes", "/api/markets", "/api/weather"]
    watch.clear_watch_cache()
    failing = []
    for _ in range(2):
        build(overrides={"/api/markets": lambda _r: httpx.Response(500)}, hits=failing)
    assert failing.count("/api/markets") == 1


def test_base_url_must_be_safe(monkeypatch):
    monkeypatch.setenv("OSIRIS_BASE_URL", "http://osiris.example")
    report = build()
    details = {item["id"]: item["detail"] for item in report["sources"]}
    assert details["evenements"] == "Adresse OSIRIS mal configurée (OSIRIS_BASE_URL)."
    monkeypatch.setenv("OSIRIS_BASE_URL", "http://127.0.0.1:8080/")
    assert watch.base_url() == "http://127.0.0.1:8080"


def test_payload_is_not_echoed_when_rows_are_hostile():
    hostile = events_payload()
    hostile["events"][0]["title"] = "Crue\x00\n" + "x" * 500
    report = build(overrides={"/api/weather": lambda _r: httpx.Response(200, content=json.dumps(hostile))})
    title = next(item["title"] for item in report["events"] if item["title"].startswith("Crue"))
    assert "\x00" not in title and "\n" not in title and len(title) == 200


def build_map(settings=SETTINGS, **kwargs):
    return asyncio.run(watch.build_map(settings, now=NOW, transport=transport(**kwargs)))


def test_briefing_events_do_not_expose_coordinates():
    assert all("latitude" not in item and "longitude" not in item for item in build()["events"])


def test_map_lists_worldwide_points_sorted_by_distance_without_sending_position():
    hits = []
    report = build_map(hits=hits)
    assert sorted(hits) == ["/api/earthquakes", "/api/weather"]
    assert report["read_only"] is True and report["status"] == "ok"
    assert report["origin"] == PARIS
    assert report["default_radius_km"] == 300 and report["radii_km"] == [50, 100, 300, 1000]
    titles = [item["title"] for item in report["events"]]
    assert titles == ["Orage violent", "Crue de la Seine", "Séisme de magnitude 4,1", "Flood Warning"]
    far = report["events"][-1]
    assert far["distance_km"] > 8000 and far["latitude"] == 32.2 and far["longitude"] == -110.9
    assert all("_rank" not in item for item in report["events"])
    assert report["truncated"] == 0


def test_map_without_configured_city_has_no_origin_or_distance():
    report = build_map(settings=None)
    assert report["origin"] is None
    assert len(report["events"]) == 4
    assert all(item["distance_km"] is None for item in report["events"])


def test_map_caps_points_and_reports_partial_sources(monkeypatch):
    monkeypatch.setattr(watch, "MAP_MAX_EVENTS", 2)
    report = build_map(overrides={"/api/earthquakes": lambda _r: httpx.Response(503)})
    assert report["status"] == "partial"
    assert [item["title"] for item in report["events"]] == ["Orage violent", "Crue de la Seine"]
    assert report["truncated"] == 1
    assert {item["id"]: item["detail"] for item in report["sources"]}["seismes"] == "OSIRIS a répondu HTTP 503."
