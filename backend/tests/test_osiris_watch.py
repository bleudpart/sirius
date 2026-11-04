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


def flights_payload():
    return {
        "timestamp": iso(-timedelta(minutes=1)),
        "commercial_flights": [
            {"icao24": "abc123", "callsign": "AF123", "lat": 48.9, "lng": 2.4, "alt": 9000, "speed_knots": 420},
            {"icao24": "def456", "callsign": "FAR1", "lat": 40.7, "lng": -74.0, "alt": 11000, "speed_knots": 450},
            {"icao24": "bad", "callsign": "INVALID", "lat": "bad", "lng": 2.0},
        ],
        "private_flights": [{"icao24": "abc123", "callsign": "AF123", "lat": 48.9, "lng": 2.4}],
        "private_jets": [{"icao24": "ghi789", "callsign": "PAC1", "lat": -17.8, "lng": -175.0}],
        "military_flights": [],
    }


def satellites_payload():
    return {"timestamp": iso(-timedelta(minutes=2)), "source": "memory-cache", "satellites": [
        {"name": "Satellite A", "noradId": "12345", "lat": 49.0, "lng": 2.5, "alt": 550},
        {"name": "Satellite B", "noradId": "23456", "lat": 1.0, "lng": 120.0, "alt": 1000},
    ]}


def conflicts_payload():
    return {"timestamp": iso(-timedelta(minutes=2)), "zoneSource": "curated", "zones": [
        {"id": "z1", "label": "Zone A", "lat": 49.0, "lng": 2.5, "sourceUrl": "https://example.org/zone"},
        {"id": "z2", "label": "Zone B", "lat": 35.0, "lng": 45.0, "sourceUrl": "javascript:alert(1)"},
    ]}


def news_payload():
    return {"timestamp": iso(-timedelta(minutes=2)), "news": [
        {"id": "n1", "title": "Signalement A", "source_name": "Agence A", "link": "https://example.org/a",
         "published": iso(-timedelta(hours=1)), "coords": [49.0, 2.5], "coords_default": False,
         "location_precision": "settlement"},
        {"id": "n2", "title": "Signalement B", "source_name": "Agence B", "link": "https://example.org/b",
         "published": iso(-timedelta(hours=2)), "coords": [35.0, 45.0], "coords_default": False,
         "location_precision": "country-anchor"},
        {"id": "n3", "title": "Lieu inconnu", "source_name": "Agence C", "link": "https://example.org/c",
         "published": iso(), "coords": [0, 0], "coords_default": True},
        {"id": "n4", "title": "Lien invalide", "source_name": "Agence D", "link": "javascript:alert(1)",
         "published": iso(), "coords": [49.0, 2.5], "coords_default": False},
    ]}


def maritime_payload():
    return {
        "timestamp": iso(-timedelta(minutes=3)),
        "ports": [
            {"name": "Port près de Paris", "country": "FR", "lat": 48.9, "lng": 2.4,
             "type": "container", "volume": "3M TEU", "congestion": "NORMAL"},
            {"name": "Rotterdam", "country": "NL", "lat": 51.9, "lng": 4.5, "type": "container"},
        ],
        "chokepoints": [
            {"name": "Détroit de Gibraltar", "lat": 35.9, "lng": -5.8, "traffic": "90M tonnes", "risk": "HIGH"},
        ],
        "ships": [],
        "total_ports": 2, "total_chokepoints": 1, "total_ships": 0,
    }


def cameras_payload():
    return {"timestamp": iso(-timedelta(minutes=3)), "cameras": [
        {"id": "cam1", "name": "Place de Paris", "lat": 48.9, "lng": 2.4, "city": "Paris", "country": "FR",
         "source": "Source publique", "feed_url": "https://example.org/camera.jpg?version=1",
         "stream_url": "https://example.org/live"},
        {"id": "cam2", "name": "Caméra distante", "lat": 40.7, "lng": -74.0,
         "feed_url": "https://example.org/other.png"},
        {"id": "cam3", "name": "Sans lien", "lat": 49.0, "lng": 2.5,
         "feed_url": "http://example.org/camera.jpg", "stream_url": "javascript:alert(1)"},
        {"id": "invalid", "name": "Position invalide", "lat": "bad", "lng": 2.0},
    ]}


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
    payloads = {
        "/api/weather": events_payload(), "/api/earthquakes": quakes_payload(), "/api/markets": markets_payload(),
        "/api/flights": flights_payload(), "/api/satellites": satellites_payload(),
        "/api/conflicts": conflicts_payload(), "/api/news": news_payload(), "/api/maritime": maritime_payload(),
        "/api/cctv": cameras_payload(),
    }

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


WORLD_BOUNDS = {"south": -90, "west": -180, "north": 90, "east": 180}
FRANCE_BOUNDS = {"south": 41, "west": -5, "north": 51.5, "east": 10}


def build_layer(kind, settings=SETTINGS, bounds=WORLD_BOUNDS, radius_km=None, **kwargs):
    return asyncio.run(watch.build_map_layer(
        settings, kind, bounds, radius_km, now=NOW, transport=transport(**kwargs),
    ))


@pytest.mark.parametrize("kind, title", [
    ("avion", "Avion AF123"),
    ("satellite", "Satellite Satellite A"),
    ("conflit", "Zone de conflit : Zone A"),
    ("actualite", "Signalement A"),
])
def test_map_layers_filter_the_view_and_radius_without_sending_the_position(kind, title):
    report = build_layer(kind, bounds=FRANCE_BOUNDS, radius_km=300)
    assert report["source"]["ok"] is True and report["read_only"] is True
    assert report["source"]["updated_at"] is not None
    assert report["total"] == 1 and report["truncated"] == 0
    assert report["items"][0]["title"] == title
    assert report["items"][0]["distance_km"] < 300


def test_transport_details_and_publication_precision_are_preserved():
    flight = build_layer("avion", bounds=FRANCE_BOUNDS)["items"][0]
    assert flight["altitude_m"] == 9000 and flight["speed_knots"] == 420
    satellite = build_layer("satellite", bounds=FRANCE_BOUNDS)["items"][0]
    assert satellite["altitude_km"] == 550
    news = build_layer("actualite")
    assert news["ignored"] == 2
    assert news["items"][0]["date"] == iso(-timedelta(hours=1)).replace("Z", "+00:00")
    assert news["items"][0]["provider"] == "Agence A"
    assert news["items"][1]["location_precision"] == "country-anchor"
    assert news["items"][1]["url"] == "https://example.org/b"
    zones = build_layer("conflit")
    assert zones["items"][1]["url"] is None


def test_maritime_layer_filters_ports_and_passages_and_reports_live_ships_separately():
    report = build_layer("maritime", bounds=FRANCE_BOUNDS, radius_km=300)
    assert report["source"]["ok"] is True and report["read_only"] is True
    assert report["total"] == 1
    assert report["counts"] == {"port": 1, "chokepoint": 0, "ship": 0}
    item = report["items"][0]
    assert item["id"] == "port:Port près de Paris" and item["title"] == "Port près de Paris"
    assert item["country"] == "FR" and item["volume"] == "3M TEU" and item["distance_km"] < 300

    world = build_layer("maritime")
    assert world["total"] == 3
    assert world["counts"] == {"port": 2, "chokepoint": 1, "ship": 0}
    passage = next(item for item in world["items"] if item["subtype"] == "chokepoint")
    assert passage["traffic"] == "90M tonnes" and passage["risk"] == "HIGH"


def test_maritime_layer_accepts_live_ship_positions_only_when_supplied():
    payload = maritime_payload()
    payload["ships"] = [
        {"mmsi": "123456789", "name": "Vessel A", "lat": 48.9, "lng": 2.4, "speed_knots": 12.5},
    ]
    report = build_layer("maritime", bounds=FRANCE_BOUNDS, overrides={
        "/api/maritime": lambda _r: httpx.Response(200, json=payload),
    })
    ship = next(item for item in report["items"] if item["subtype"] == "ship")
    assert ship["id"] == "ship:123456789" and ship["title"] == "Navire Vessel A"
    assert ship["speed_knots"] == 12.5
    assert report["counts"] == {"port": 1, "chokepoint": 0, "ship": 1}


def test_camera_layer_filters_the_view_and_preserves_safe_links():
    report = build_layer("camera", bounds=FRANCE_BOUNDS, radius_km=300)
    assert report["source"]["ok"] is True and report["read_only"] is True
    assert report["total"] == 2 and report["ignored"] == 1
    camera = next(item for item in report["items"] if item["id"] == "cam1")
    assert camera["title"] == "Caméra : Place de Paris"
    assert camera["provider"] == "OSIRIS — Source publique"
    assert camera["city"] == "Paris" and camera["country"] == "FR"
    assert camera["url"] == "https://example.org/live"
    assert camera["preview_url"] == "https://example.org/camera.jpg?version=1"
    without_link = next(item for item in report["items"] if item["id"] == "cam3")
    assert without_link["url"] is None and without_link["preview_url"] is None


@pytest.mark.parametrize("url", [
    "https://localhost/camera.jpg", "https://127.0.0.1/camera.jpg", "https://[::1]/camera.jpg",
    "https://192.168.1.1/camera.jpg", "https://127.0.0.01/camera.jpg",
    "https://user:password@example.org/camera.jpg", "https://example.org:bad/camera.jpg",
    "https://[invalid/camera.jpg", "https://example.org/cam\n.jpg",
])
def test_camera_links_reject_invalid_or_local_addresses(url):
    assert watch._camera_link(url) is None


def test_layer_wraps_the_antimeridian_and_works_without_a_city():
    pacific = {"south": -30, "west": 170, "north": 0, "east": 190}
    report = build_layer("avion", settings=None, bounds=pacific)
    assert [item["title"] for item in report["items"]] == ["Avion PAC1"]
    assert report["items"][0]["distance_km"] is None


def test_layer_caps_points_and_reuses_only_global_feed_cache(monkeypatch):
    monkeypatch.setattr(watch, "MAP_LAYER_LIMIT", 1)
    hits = []
    paris = build_layer("avion", hits=hits)
    assert paris["total"] == 3 and paris["truncated"] == 2
    assert paris["items"][0]["title"] == "Avion AF123"
    pacific_settings = {"location": {"name": "Fidji", "country": "", "latitude": -17.8, "longitude": -175.0}}
    pacific = build_layer("avion", settings=pacific_settings, hits=hits)
    assert pacific["items"][0]["title"] == "Avion PAC1"
    assert hits == ["/api/flights"]


@pytest.mark.parametrize("kind, payload, detail", [
    ("avion", {**flights_payload(), "timestamp": iso(-timedelta(minutes=11))}, "trop ancien"),
    ("satellite", {**satellites_payload(), "source": "emergency-fallback"}, "secours non vérifiables"),
    ("conflit", {**conflicts_payload(), "source": "simulated"}, "données simulées"),
    ("actualite", {**news_payload(), "news": []}, "aucune donnée"),
    ("maritime", {**maritime_payload(), "ports": [], "chokepoints": [], "ships": []}, "aucune donnée"),
    ("camera", {**cameras_payload(), "timestamp": iso(-timedelta(hours=2))}, "trop ancien"),
])
def test_map_layers_report_stale_simulated_and_empty_sources(kind, payload, detail):
    path = watch.MAP_LAYERS[kind]["path"]
    report = build_layer(kind, overrides={path: lambda _r: httpx.Response(200, json=payload)})
    assert report["source"]["ok"] is False
    assert detail in report["source"]["detail"]
    assert report["items"] == [] and report["total"] == 0


def test_map_layer_rejects_oversized_and_unusable_data(monkeypatch):
    monkeypatch.setitem(watch.MAP_LAYERS, "avion", {**watch.MAP_LAYERS["avion"], "max_bytes": 100})
    assert "trop volumineuse" in build_layer("avion")["source"]["detail"]
    invalid = {**news_payload(), "news": news_payload()["news"][2:]}
    report = build_layer("actualite", overrides={"/api/news": lambda _r: httpx.Response(200, json=invalid)})
    assert report["source"]["ok"] is False and "géolocalisée exploitable" in report["source"]["detail"]


def wind_metadata():
    return {"run": iso(-timedelta(hours=6)), "times": [
        iso(-timedelta(hours=3)), iso(), iso(timedelta(hours=3)), iso(timedelta(hours=6)),
    ]}


def wind_grid(at):
    return {"refTime": wind_metadata()["run"], "ni": 360, "nj": 181, "la1": 90, "lo1": 0, "dx": 1, "dy": 1,
            "u": [30] * (360 * 181), "v": [40] * (360 * 181)}


def wind_transport(metadata=None, grid=None, hits=None):
    def handler(request):
        assert request.url.host == "www.osirisai.live" and request.url.path == "/api/wind"
        params = dict(request.url.params)
        assert not params or set(params) == {"run", "t"}, "la position ne doit pas être transmise à OSIRIS"
        if hits is not None:
            hits.append(params)
        if not params:
            return httpx.Response(200, json=metadata if metadata is not None else wind_metadata())
        assert params["run"] == (metadata if metadata is not None else wind_metadata())["run"]
        data = grid(params["t"]) if callable(grid) else wind_grid(params["t"]) if grid is None else grid
        return httpx.Response(200, json=data)

    return httpx.MockTransport(handler)


def build_wind(settings=SETTINGS, bounds=FRANCE_BOUNDS, radius_km=None, forecast_time=None, **kwargs):
    return asyncio.run(watch.build_map_wind(
        settings, bounds, radius_km, forecast_time, now=NOW, transport=wind_transport(**kwargs),
    ))


def test_wind_uses_global_grid_converts_units_and_filters_without_sending_the_position():
    hits = []
    report = build_wind(radius_km=300, hits=hits)
    assert report["source"]["ok"] is True and report["read_only"] is True
    assert report["time"] == NOW.isoformat() and len(report["times"]) == 4
    assert report["run"] == (NOW - timedelta(hours=6)).isoformat()
    assert 0 < len(report["points"]) <= 192
    for point in report["points"]:
        assert point["east_ms"] == 3 and point["north_ms"] == 4 and point["speed_kmh"] == 18
        assert watch.distance_km(PARIS["latitude"], PARIS["longitude"], point["latitude"], point["longitude"]) <= 300.1
    assert hits == [{}, {"run": wind_metadata()["run"], "t": iso()}]
    assert build_wind(bounds=WORLD_BOUNDS, radius_km=300, hits=hits)["points"]
    assert len(hits) == 2, "le cache est global, mais les points sont filtrés à chaque demande"


def test_wind_handles_small_views_antimeridian_and_polar_radius():
    tiny = {"south": 48.8, "west": 2.3, "north": 48.9, "east": 2.4}
    assert len(build_wind(bounds=tiny, radius_km=50)["points"]) == 1
    pacific = {"south": -20, "west": 170, "north": -10, "east": 190}
    fiji = {"location": {"name": "Fidji", "country": "", "latitude": -17.8, "longitude": -179.0}}
    points = build_wind(settings=fiji, bounds=pacific, radius_km=1000)["points"]
    assert points and any(item["longitude"] > 180 for item in points)
    assert all(watch.distance_km(-17.8, -179, item["latitude"], item["longitude"]) <= 1000.1 for item in points)
    polar = {"location": {"name": "Pôle", "country": "", "latitude": 89, "longitude": 0}}
    polar_bounds = {"south": 80, "west": -180, "north": 90, "east": 180}
    assert build_wind(settings=polar, bounds=polar_bounds, radius_km=300)["points"]


def test_wind_only_accepts_advertised_times_and_bounds_the_grid_cache():
    hits = []
    rejected = build_wind(forecast_time=NOW + timedelta(hours=1), hits=hits)
    assert rejected["source"]["ok"] is False and "plus disponible" in rejected["source"]["detail"]
    assert len(hits) == 1 and len(rejected["times"]) == 4
    for delta in (-3, 0, 3, 6):
        assert build_wind(forecast_time=NOW + timedelta(hours=delta), hits=hits)["source"]["ok"]
    assert len(watch._wind_grids) == 3
    assert build_wind(forecast_time=NOW - timedelta(hours=3), hits=hits)["source"]["ok"]
    assert len(hits) == 6


def test_wind_reports_the_actual_historical_model_cycle_not_the_latest_run():
    metadata = {"run": iso(-timedelta(hours=3)), "times": [iso(-timedelta(hours=6))]}
    grid = {**wind_grid(iso(-timedelta(hours=6))), "refTime": iso(-timedelta(hours=9))}
    report = build_wind(metadata=metadata, grid=grid)
    assert report["source"]["ok"] is True
    assert report["time"] == (NOW - timedelta(hours=6)).isoformat()
    assert report["run"] == (NOW - timedelta(hours=9)).isoformat()
    assert report["latest_run"] == (NOW - timedelta(hours=3)).isoformat()


def test_wind_reports_stale_metadata_and_inconsistent_grids():
    stale = {**wind_metadata(), "run": iso(-timedelta(hours=40))}
    report = build_wind(metadata=stale)
    assert report["source"]["ok"] is False and "trop ancien" in report["source"]["detail"]
    watch.clear_watch_cache()
    report = build_wind(grid={**wind_grid(iso()), "refTime": iso(timedelta(hours=3))})
    assert report["source"]["ok"] is False and "incohérente" in report["source"]["detail"]
    assert report["points"] == [] and isinstance(next(iter(watch._wind_grids.values()))[2], str)


def test_wind_rejects_incomplete_vectors_instead_of_fabricating_data():
    grid = wind_grid(iso())
    grid["u"] = [None] * (360 * 181)
    report = build_wind(grid=grid)
    assert report["source"]["ok"] is False and "Aucun vecteur" in report["source"]["detail"]
    assert report["points"] == []
