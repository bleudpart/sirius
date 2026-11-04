import asyncio
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import daily_briefing
import google_calendar
import microsoft_graph
import osiris_watch
import weather_bulletin
from local_docstore import LocalDocStore
from routes.veille import make_veille_router
from routes.work_dossiers import make_work_dossiers_router

OWNER = {"x-test-user": "u1"}
OTHER = {"x-test-user": "u2"}
PARIS_TZ = ZoneInfo("Europe/Paris")


async def require_user(request, _db):
    uid = request.headers.get("x-test-user")
    if not uid:
        raise HTTPException(status_code=401)
    return {"user_id": uid}


@pytest.fixture
def geocoder(monkeypatch):
    calls = []

    async def locate(city):
        calls.append(city)
        if city == "Nullepart":
            raise LookupError("Ville introuvable.")
        if city == "Limite":
            raise weather_bulletin.WeatherRateLimitedError("429")
        if city == "Panne":
            raise httpx.ConnectError("refus")
        return ("Lyon", "France", 45.75, 4.85)

    monkeypatch.setattr(weather_bulletin, "locate_city", locate)
    return calls


@pytest.fixture
def veille_client(tmp_path):
    db = LocalDocStore(tmp_path / "veille.db")
    app = FastAPI()
    app.include_router(make_veille_router(db, require_user), prefix="/api")
    with TestClient(app) as client:
        yield client, db


def test_veille_settings_are_private_validated_and_geocoded_once(veille_client, geocoder):
    client, db = veille_client
    assert client.get("/api/veille/settings").status_code == 401
    default = client.get("/api/veille/settings", headers=OWNER).json()
    assert default["configured"] is False and default["enabled"] is False and default["location"] is None
    assert client.put("/api/veille/settings", headers=OWNER, json={"enabled": True, "city": ""}).status_code == 422
    assert client.put("/api/veille/settings", headers=OWNER, json={"enabled": "oui", "city": "Lyon"}).status_code == 422
    assert client.put("/api/veille/settings", headers=OWNER, json={"enabled": True, "city": "Lyon", "lat": 1}).status_code == 422
    assert client.put("/api/veille/settings", headers=OWNER, json={
        "enabled": True, "city": "Lyon", "meteo_locale": False, "evenements": False, "marches": False,
    }).status_code == 422
    saved = client.put("/api/veille/settings", headers=OWNER, json={"enabled": True, "city": "  Lyon "})
    assert saved.status_code == 200
    body = saved.json()
    assert body["enabled"] is True and body["city"] == "Lyon"
    assert body["location"] == {"name": "Lyon", "country": "France"}
    assert "latitude" not in str(body)
    stored = asyncio.run(db.sirius_veille_settings.find_one({"user_id": "u1"}))
    assert stored["location"]["latitude"] == 45.75
    client.put("/api/veille/settings", headers=OWNER, json={"enabled": True, "city": "Lyon", "marches": False})
    assert geocoder == ["Lyon"]
    assert client.get("/api/veille/settings", headers=OWNER).json()["marches"] is False
    assert client.get("/api/veille/settings", headers=OTHER).json()["configured"] is False
    disabled = client.put("/api/veille/settings", headers=OWNER, json={"enabled": False, "city": ""}).json()
    assert disabled["enabled"] is False and disabled["location"] is None


@pytest.mark.parametrize("city, status, detail", [
    ("Nullepart", 422, "Ville introuvable"),
    ("Limite", 503, "limitée par Open-Meteo"),
    ("Panne", 503, "Open-Meteo indisponible"),
])
def test_veille_geocoding_errors_are_explicit(veille_client, geocoder, city, status, detail):
    client, db = veille_client
    response = client.put("/api/veille/settings", headers=OWNER, json={"enabled": True, "city": city})
    assert response.status_code == status and detail in response.json()["detail"]
    assert asyncio.run(db.sirius_veille_settings.find_one({"user_id": "u1"})) is None


def test_veille_preview_uses_only_the_callers_settings(veille_client, geocoder, monkeypatch):
    client, _ = veille_client
    seen = []

    async def fake_watch(settings):
        seen.append(settings)
        return {"status": "disabled", "read_only": True}

    monkeypatch.setattr(osiris_watch, "build_watch", fake_watch)
    client.put("/api/veille/settings", headers=OWNER, json={"enabled": True, "city": "Lyon"})
    assert client.get("/api/veille", headers=OTHER).json() == {"status": "disabled", "read_only": True, "text": ""}
    assert seen[-1] is None
    client.get("/api/veille", headers=OWNER)
    assert seen[-1]["user_id"] == "u1" and seen[-1]["location"]["name"] == "Lyon"


def test_veille_map_requires_login_and_uses_only_the_callers_city(veille_client, geocoder, monkeypatch):
    client, _ = veille_client
    seen = []

    async def fake_map(settings):
        seen.append(settings)
        return {"read_only": True, "events": []}

    monkeypatch.setattr(osiris_watch, "build_map", fake_map)
    assert client.get("/api/veille/carte").status_code == 401
    client.put("/api/veille/settings", headers=OWNER, json={"enabled": False, "city": "Lyon"})
    assert client.get("/api/veille/carte", headers=OTHER).json() == {"read_only": True, "events": []}
    assert seen[-1] is None
    client.get("/api/veille/carte", headers=OWNER)
    assert seen[-1]["user_id"] == "u1" and seen[-1]["location"]["name"] == "Lyon"


def test_map_layers_validate_bounds_and_use_only_the_callers_city(veille_client, geocoder, monkeypatch):
    client, _ = veille_client
    seen = []

    async def fake_layer(settings, kind, bounds, radius_km):
        seen.append((settings, kind, bounds, radius_km))
        return {"source": {"ok": True}, "items": []}

    monkeypatch.setattr(osiris_watch, "build_map_layer", fake_layer)
    params = {"south": 41, "west": -5, "north": 52, "east": 10}
    path = "/api/veille/carte/calques/avion"
    assert client.get(path, params=params).status_code == 401
    client.put("/api/veille/settings", headers=OWNER, json={"enabled": False, "city": "Lyon"})
    assert client.get(path, params={**params, "radius_km": 300}, headers=OWNER).status_code == 200
    settings, kind, bounds, radius = seen[-1]
    assert settings["user_id"] == "u1" and kind == "avion" and radius == 300
    assert bounds == {"south": 41, "west": -5, "north": 52, "east": 10}
    assert client.get(path, params=params, headers=OTHER).status_code == 200
    assert seen[-1][0] is None
    assert client.get(path, params={**params, "radius_km": 300}, headers=OTHER).status_code == 422
    assert client.get(path, params={**params, "radius_km": 25}, headers=OWNER).status_code == 422
    assert client.get(path, params={**params, "south": 60}, headers=OWNER).status_code == 422
    assert client.get(path, params={**params, "west": 20}, headers=OWNER).status_code == 422
    assert client.get(path, params={**params, "east": "nan"}, headers=OWNER).status_code == 422
    maritime_path = "/api/veille/carte/calques/maritime"
    assert client.get(maritime_path, params=params, headers=OWNER).status_code == 200
    assert seen[-1][1] == "maritime"
    camera_path = "/api/veille/carte/calques/camera"
    assert client.get(camera_path, params=params).status_code == 401
    assert client.get(camera_path, params=params, headers=OWNER).status_code == 200
    assert seen[-1][1] == "camera"
    assert client.get("/api/veille/carte/calques/navire", params=params, headers=OWNER).status_code == 422


def test_production_app_exposes_the_map_route_behind_login():
    import server
    client = TestClient(server.app)
    assert client.get("/api/veille/route-absente").status_code == 404
    assert client.get("/api/veille/carte").status_code == 401
    assert client.get(
        "/api/veille/carte/calques/avion?south=41&west=-5&north=52&east=10",
    ).status_code == 401
    assert client.get(
        "/api/veille/carte/calques/maritime?south=41&west=-5&north=52&east=10",
    ).status_code == 401
    assert client.get(
        "/api/veille/carte/vent?south=41&west=-5&north=52&east=10",
    ).status_code == 401
    assert client.get("/api/veille/carte/pluie").status_code == 401


def test_wind_route_validates_authentication_bounds_and_forecast_time(veille_client, monkeypatch):
    client, _ = veille_client
    seen = []

    async def fake_wind(settings, bounds, radius_km, forecast_time):
        seen.append((settings, bounds, radius_km, forecast_time))
        return {"source": {"ok": True}, "points": []}

    monkeypatch.setattr(osiris_watch, "build_map_wind", fake_wind)
    params = {"south": 41, "west": -5, "north": 52, "east": 10, "t": "2026-05-02T09:00:00Z"}
    assert client.get("/api/veille/carte/vent", params=params).status_code == 401
    assert client.get("/api/veille/carte/vent", params=params, headers=OWNER).status_code == 200
    assert seen[-1][1] == {"south": 41, "west": -5, "north": 52, "east": 10}
    assert seen[-1][3].isoformat() == "2026-05-02T09:00:00+00:00"
    assert client.get("/api/veille/carte/vent", params={**params, "south": 60}, headers=OWNER).status_code == 422
    assert client.get("/api/veille/carte/vent", params={**params, "t": "2026-05-02T09:00:00"}, headers=OWNER).status_code == 422
    assert client.get("/api/veille/carte/vent", params={**params, "radius_km": 50}, headers=OTHER).status_code == 422


def test_rain_route_requires_authentication_and_does_not_send_location(veille_client, monkeypatch):
    client, _ = veille_client
    calls = []

    async def fake_rain():
        calls.append(True)
        return {"kind": "pluie", "source": {"ok": True}, "times": []}

    monkeypatch.setattr("gibs_rain.rain_metadata", fake_rain)
    assert client.get("/api/veille/carte/pluie").status_code == 401
    assert not calls
    assert client.get("/api/veille/carte/pluie", headers=OWNER).status_code == 200
    assert calls == [True]


def priority(titre, total, code="dates", niveau="urgent"):
    return SimpleNamespace(code=code, niveau=niveau, titre=titre, total=total)


def closing(day, labels, prints, priorities=()):
    return SimpleNamespace(date=day, etiquettes_enregistrees=labels, impressions_confirmees=prints,
                           priorites=list(priorities))


@pytest.fixture
def briefing_app(tmp_path, monkeypatch):
    db = LocalDocStore(tmp_path / "briefing.db")
    state = {"scope_error": None, "closing_delay": 0, "ms": None, "google": None}

    async def haccp_scope(request):
        if state["scope_error"]:
            raise state["scope_error"]
        return "user:" + request.headers["x-test-user"]

    async def load_closing(scope, day):
        await asyncio.sleep(state["closing_delay"])
        today = datetime.now(PARIS_TZ).date()
        if day == today:
            return closing(day, 12, 9, [priority("Dates limites à contrôler", 2)])
        return closing(day, 30, 28, [priority("Impressions à vérifier", 1, "impressions", "attention")])

    async def ms_connection(_db, uid):
        return {"user_id": uid} if state["ms"] is not None else None

    async def ms_events(_db, _uid):
        if isinstance(state["ms"], BaseException):
            raise state["ms"]
        return state["ms"]

    async def google_events(_db, _uid):
        if isinstance(state["google"], BaseException):
            raise state["google"]
        return state["google"]

    async def fake_watch(settings):
        return {"status": "not_configured", "read_only": True, "enabled": False}

    monkeypatch.setattr(microsoft_graph, "microsoft_connection", ms_connection)
    monkeypatch.setattr(microsoft_graph, "ms_today_events", ms_events)
    monkeypatch.setattr(google_calendar, "google_today_events", google_events)
    monkeypatch.setattr(osiris_watch, "build_watch", fake_watch)
    extras = daily_briefing.make_briefing_extras(db, haccp_scope=haccp_scope, load_closing=load_closing)
    app = FastAPI()
    app.include_router(make_work_dossiers_router(db, require_user, briefing_extras=extras), prefix="/api")
    with TestClient(app) as client:
        yield client, db, state


def test_daily_briefing_combines_haccp_agenda_and_veille_in_order(briefing_app):
    client, db, state = briefing_app
    state["ms"] = [
        {"titre": "Livraison poisson", "debut": "2026-05-02T09:30", "lieu": "Quai", "journee": False},
        {"titre": "Inventaire", "debut": "2026-05-02T00:00", "lieu": "", "journee": True},
    ]
    asyncio.run(db.google_calendar.insert_one({"_id": "u1", "tokens": {"access_token": "x"}}))
    state["google"] = [{"title": "Réunion\nfournisseur", "start": "2026-05-02T12:00:00Z", "all_day": False, "location": ""}]
    response = client.get("/api/work-dossiers/briefing", headers=OWNER)
    assert response.status_code == 200
    report = response.json()
    assert report["kind"] == "work" and report["read_only"] is True and report["executed"] is False
    daily = report["daily"]
    assert daily["haccp"]["today"]["etiquettes"] == 12 and daily["haccp"]["yesterday"]["etiquettes"] == 30
    assert daily["agenda"]["connected"] == ["Outlook", "Google Agenda"]
    text = report["briefing"]
    lines = text.splitlines()
    assert lines[0].startswith("Briefing de travail du ")
    assert "les sources citées dans chaque section" in lines[1]
    assert "HACCP — registre des étiquettes : aujourd'hui 12 étiquette(s) enregistrée(s) et 9 impression(s) confirmée(s)." in text
    assert "- À vérifier aujourd'hui : Dates limites à contrôler (2)." in text
    assert "recalculé maintenant : Impressions à vérifier (1)." in text
    assert "Agenda du jour (Outlook, Google Agenda) : 3 rendez-vous." in text
    assert "- Toute la journée : Inventaire (Outlook)." in text
    assert "- 09 h 30 : Livraison poisson — Quai (Outlook)." in text
    assert "Réunion fournisseur (Google Agenda)" in text
    assert "Veille locale non configurée" in text
    order = [text.index(marker) for marker in (
        "HACCP —", "Agenda du jour", "Dossiers enregistrés", "Veille locale non configurée", "Aucune tâche terminée",
    )]
    assert order == sorted(order)


def test_daily_briefing_degrades_section_by_section(briefing_app, monkeypatch):
    client, _, state = briefing_app
    state["scope_error"] = HTTPException(403, "Permission haccp requise.")
    report = client.get("/api/work-dossiers/briefing", headers=OWNER).json()
    assert report["daily"]["haccp"]["available"] is False
    assert "HACCP : Registre HACCP des étiquettes non accessible : Permission haccp requise." in report["briefing"]
    assert "Agenda : aucun agenda Google ou Outlook connecté." in report["briefing"]

    state["scope_error"] = None
    state["closing_delay"] = 1
    state["ms"] = RuntimeError("boom")
    monkeypatch.setattr(daily_briefing, "SECTION_TIMEOUT", 0.05)
    text = client.get("/api/work-dossiers/briefing", headers=OWNER).json()["briefing"]
    assert "HACCP : Le registre HACCP n'a pas répondu à temps." in text
    assert "- Agenda Outlook indisponible : lecture impossible pour le moment." in text
    assert "aucune action métier exécutée" in text


def test_veille_failure_does_not_break_briefing(briefing_app, monkeypatch):
    client, _, _ = briefing_app

    async def crash(_settings):
        raise RuntimeError("panne")

    monkeypatch.setattr(osiris_watch, "build_watch", crash)
    report = client.get("/api/work-dossiers/briefing", headers=OWNER).json()
    assert report["daily"]["veille"] == {"available": False, "detail": "La veille est indisponible pour le moment."}
    assert "Veille : La veille est indisponible pour le moment." in report["briefing"]


def test_briefing_without_extras_is_unchanged(tmp_path):
    app = FastAPI()
    app.include_router(make_work_dossiers_router(LocalDocStore(tmp_path / "plain.db"), require_user), prefix="/api")
    with TestClient(app) as client:
        report = client.get("/api/work-dossiers/briefing", headers=OWNER).json()
    assert "daily" not in report
    assert report["briefing"].splitlines()[1] == (
        "Sources : vos dossiers privés et les données métier autorisées, vérifiés à cette demande."
    )


def test_google_today_events_reads_only_todays_calendar(tmp_path):
    db = LocalDocStore(tmp_path / "google.db")
    expires = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    asyncio.run(db.google_calendar.insert_one({
        "_id": "u1", "expires_at": expires,
        "tokens": {"access_token": "jeton", "scope": "https://www.googleapis.com/auth/calendar"},
    }))
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"items": [
            {"summary": "Livraison", "start": {"dateTime": "2026-05-02T09:00:00+02:00"}, "location": "Quai"},
            {"summary": "Annulé", "status": "cancelled", "start": {"dateTime": "2026-05-02T10:00:00+02:00"}},
            {"start": {"date": "2026-05-02"}},
        ]})

    events = asyncio.run(google_calendar.google_today_events(db, "u1", transport=httpx.MockTransport(handler)))
    assert events == [
        {"title": "Livraison", "start": "2026-05-02T09:00:00+02:00", "all_day": False, "location": "Quai"},
        {"title": "(sans titre)", "start": "2026-05-02", "all_day": True, "location": ""},
    ]
    request = seen[0]
    assert request.method == "GET" and request.headers["authorization"] == "Bearer jeton"
    start = datetime.fromisoformat(request.url.params["timeMin"])
    assert start.hour == 0 and start.utcoffset() == datetime.now(PARIS_TZ).utcoffset()
    assert datetime.fromisoformat(request.url.params["timeMax"]) - start == timedelta(days=1)
    assert date.fromisoformat(request.url.params["timeMin"][:10]) == datetime.now(PARIS_TZ).date()
