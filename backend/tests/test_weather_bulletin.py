import asyncio
import copy
import json
from datetime import datetime, timezone

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import weather_bulletin as weather
from routes.infos import make_infos_router


class FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 10, 14, 15, 45, tzinfo=timezone.utc).astimezone(tz)


@pytest.fixture(autouse=True)
def empty_weather_cache():
    weather.clear_weather_cache()
    yield
    weather.clear_weather_cache()


@pytest.fixture
def forecast(monkeypatch):
    monkeypatch.setattr(weather, "datetime", FixedDateTime, raising=False)
    return {
        "timezone": "Europe/Paris",
        "utc_offset_seconds": 7200,
        "current_units": {
            "time": "iso8601", "temperature_2m": "°C",
            "apparent_temperature": "°C", "weather_code": "wmo code",
            "wind_speed_10m": "km/h",
        },
        "daily_units": {
            "time": "iso8601", "weather_code": "wmo code",
            "temperature_2m_min": "°C", "temperature_2m_max": "°C",
            "precipitation_probability_max": "%", "wind_speed_10m_max": "km/h",
        },
        "current": {
            "time": "2026-10-14T17:45", "temperature_2m": 16.8,
            "apparent_temperature": 15.2, "weather_code": 3, "wind_speed_10m": 11.4,
        },
        "daily": {
            "time": ["2026-10-14", "2026-10-15"], "weather_code": [3, 61],
            "temperature_2m_min": [10.2, 9.5], "temperature_2m_max": [17.1, 16.4],
            "precipitation_probability_max": [20, 70], "wind_speed_10m_max": [15, 21],
        },
    }


def mock_http(monkeypatch, forecast, locations=None, failure=None):
    requests = []
    if locations is None:
        locations = [{"name": "Rosny-sous-Bois", "country": "France",
                      "latitude": 48.87, "longitude": 2.48}]

    def respond(request):
        requests.append(request)
        if failure:
            raise failure("Timeout", request=request)
        data = {"results": locations} if "geocoding" in request.url.host else forecast
        return httpx.Response(200, json=data)

    client = httpx.AsyncClient
    monkeypatch.setattr(weather.httpx, "AsyncClient", lambda **kwargs: client(
        **kwargs, transport=httpx.MockTransport(respond),
    ))
    return requests


def fetch(city="Rosny-sous-Bois"):
    return asyncio.run(weather.fetch_weather_bulletin(city))


def test_exact_bulletin_and_explicit_metric_request(monkeypatch, forecast):
    requests = mock_http(monkeypatch, forecast)
    result = fetch("  Rosny-sous-Bois  ")
    assert result["city"] == "Rosny-sous-Bois"
    assert result["country"] == "France"
    assert result["timezone"] == "Europe/Paris"
    assert result["source"] == "Open-Meteo"
    assert result["url"] == "https://open-meteo.com/"
    assert result["current"] == forecast["current"]
    assert result["current_units"] == forecast["current_units"]
    assert result["daily_units"] == forecast["daily_units"]
    assert result["days"] == [
        {"date": forecast["daily"]["time"][i],
         **{key: values[i] for key, values in forecast["daily"].items() if key != "time"}}
        for i in range(2)
    ]
    assert requests[0].url.params["name"] == "Rosny-sous-Bois"
    assert requests[1].url.params["temperature_unit"] == "celsius"
    assert requests[1].url.params["wind_speed_unit"] == "kmh"
    assert requests[1].url.params["forecast_days"] == "2"


@pytest.mark.parametrize("city", ["", "   ", "x" * 121, "Rosny\nParis", "---"])
def test_invalid_city_never_requests_or_defaults(monkeypatch, forecast, city):
    requests = mock_http(monkeypatch, forecast)
    with pytest.raises(ValueError):
        fetch(city)
    assert not requests


@pytest.mark.parametrize("locations", [[], [{"name": "Paris", "latitude": 48.8, "longitude": 2.3}]])
def test_unknown_or_fuzzy_city_is_not_substituted(monkeypatch, forecast, locations):
    requests = mock_http(monkeypatch, forecast, locations=locations)
    with pytest.raises(LookupError):
        fetch()
    assert len(requests) == 1


def test_city_name_accepts_accents_and_hyphens(monkeypatch, forecast):
    mock_http(monkeypatch, forecast, locations=[
        {"name": "Saint-Étienne", "latitude": 45.44, "longitude": 4.39},
    ])
    assert fetch("Saint Etienne")["city"] == "Saint-Étienne"


@pytest.mark.parametrize("failure", [httpx.ConnectTimeout, httpx.ReadTimeout])
def test_timeouts_are_explicit(monkeypatch, forecast, failure):
    mock_http(monkeypatch, forecast, failure=failure)
    with pytest.raises(httpx.TimeoutException):
        fetch()


@pytest.mark.parametrize("section,field,value", [
    ("current", "temperature_2m", float("nan")),
    ("current", "apparent_temperature", float("inf")),
    ("current", "wind_speed_10m", True),
    ("current", "temperature_2m", "16"),
    ("current", "wind_speed_10m", -1),
    ("current", "wind_speed_10m", 401),
    ("current", "temperature_2m", -91),
    ("current", "temperature_2m", 61),
    ("current", "apparent_temperature", -101),
    ("current", "apparent_temperature", 71),
    ("current", "weather_code", 4),
    ("current", "weather_code", 3.5),
    ("current", "weather_code", False),
    ("daily", "weather_code", [3, 100]),
    ("daily", "weather_code", [3, 22]),
    ("daily", "temperature_2m_min", [10, float("-inf")]),
    ("daily", "temperature_2m_min", [10, False]),
    ("daily", "temperature_2m_max", [17, None]),
    ("daily", "precipitation_probability_max", [20, 101]),
    ("daily", "precipitation_probability_max", [20, -1]),
    ("daily", "wind_speed_10m_max", [15, -1]),
    ("daily", "wind_speed_10m_max", [15, 401]),
    ("daily", "temperature_2m_min", [-91, 9]),
    ("daily", "temperature_2m_max", [17, 61]),
    ("daily", "temperature_2m_min", [10, 20]),
    ("daily", "weather_code", [3]),
    ("daily", "weather_code", [3, 61, 0]),
    ("daily", "time", ["2026-10-14"]),
    ("daily", "time", ["2026-10-14", "2026-10-14"]),
    ("daily", "time", ["2026-10-15", "2026-10-16"]),
    ("daily", "time", ["2026-10-14", "2026-02-30"]),
    ("daily", "time", ["2026-10-14", "2026-10-15T00:00"]),
    ("current", "time", "2026-10-13T17:45"),
    ("current", "time", "2026-10-14T15:30"),
    ("current", "time", "2026-10-14T18:30"),
    ("current", "time", "2026-02-30T17:45"),
    ("current", "time", "2026-10-14T17:45Z"),
    ("current_units", "temperature_2m", "°F"),
    ("current_units", "wind_speed_10m", "m/s"),
    ("current_units", "weather_code", "other"),
    ("daily_units", "precipitation_probability_max", "mm"),
    ("daily_units", "temperature_2m_min", "°F"),
    ("daily_units", "time", "unixtime"),
])
def test_invalid_forecast_rejected(monkeypatch, forecast, section, field, value):
    # Feed deliberately invalid non-finite JSON values too: HTTPX's JSON encoder rejects them.
    payload = copy.deepcopy(forecast)
    payload[section][field] = value
    client = httpx.AsyncClient

    def respond(request):
        data = {"results": [{"name": "Rosny-sous-Bois", "latitude": 48.87,
                             "longitude": 2.48}]} if "geocoding" in request.url.host else payload
        return httpx.Response(200, content=json.dumps(data), headers={"content-type": "application/json"})

    monkeypatch.setattr(weather.httpx, "AsyncClient", lambda **kwargs: client(
        **kwargs, transport=httpx.MockTransport(respond),
    ))
    with pytest.raises(ValueError):
        fetch()


@pytest.mark.parametrize("field,value", [
    ("timezone", "Not/AZone"), ("timezone", ""), ("utc_offset_seconds", 0),
    ("utc_offset_seconds", True), ("current_units", {}), ("daily_units", {}),
    ("current", []), ("daily", []),
])
def test_invalid_metadata_rejected(monkeypatch, forecast, field, value):
    forecast[field] = value
    mock_http(monkeypatch, forecast)
    with pytest.raises(ValueError):
        fetch()


@pytest.mark.parametrize("field,value", [
    ("latitude", True), ("latitude", 91), ("longitude", 181), ("name", None),
])
def test_invalid_location_rejected(monkeypatch, forecast, field, value):
    location = {"name": "Rosny-sous-Bois", "latitude": 48.87, "longitude": 2.48}
    location[field] = value
    mock_http(monkeypatch, forecast, locations=[location])
    with pytest.raises(ValueError):
        fetch()


def api_client():
    app = FastAPI()
    app.include_router(make_infos_router(), prefix="/api")
    return TestClient(app)


@pytest.mark.parametrize("city", ["", "  ", "x" * 121, "Rosny\nParis", "---"])
def test_route_invalid_city_returns_400(monkeypatch, forecast, city):
    requests = mock_http(monkeypatch, forecast)
    assert api_client().get("/api/weather/bulletin", params={"city": city}).status_code == 400
    assert not requests


def test_route_missing_city_returns_400():
    assert api_client().get("/api/weather/bulletin").status_code == 400


def test_route_no_key_needed_and_success(monkeypatch, forecast):
    monkeypatch.delenv("OPENWEATHER_API_KEY", raising=False)
    mock_http(monkeypatch, forecast)
    response = api_client().get("/api/weather/bulletin", params={"city": "Rosny-sous-Bois"})
    assert response.status_code == 200
    assert response.json()["current"]["temperature_2m"] == 16.8


@pytest.mark.parametrize("failure,status", [
    (LookupError, 404), (ValueError, 502), (KeyError, 502), (IndexError, 502),
    (TypeError, 502), (httpx.ReadTimeout, 502),
])
def test_route_error_mapping(monkeypatch, failure, status):
    async def fail(_city):
        assert _city == "Rosny-sous-Bois"
        raise failure("Source invalide")

    monkeypatch.setattr(weather, "fetch_weather_bulletin", fail)
    response = api_client().get("/api/weather/bulletin", params={"city": "Rosny-sous-Bois"})
    assert response.status_code == status
    assert "Source invalide" not in response.text


def test_forecast_dates_use_city_timezone_not_utc(monkeypatch, forecast):
    forecast.update(timezone="Pacific/Auckland", utc_offset_seconds=46800)
    forecast["current"]["time"] = "2026-10-15T04:45"
    forecast["daily"]["time"] = ["2026-10-15", "2026-10-16"]
    mock_http(monkeypatch, forecast)
    assert [day["date"] for day in fetch()["days"]] == ["2026-10-15", "2026-10-16"]


def test_current_previous_local_day_is_allowed_when_fresh(monkeypatch, forecast):
    forecast.update(timezone="Asia/Tokyo", utc_offset_seconds=32400)
    forecast["current"]["time"] = "2026-10-14T23:45"
    forecast["daily"]["time"] = ["2026-10-15", "2026-10-16"]
    mock_http(monkeypatch, forecast)
    assert fetch()["current"]["time"] == "2026-10-14T23:45"


@pytest.mark.parametrize("code", sorted(weather.WMO_CODES))
def test_all_supported_wmo_codes_remain_exact(monkeypatch, forecast, code):
    forecast["current"]["weather_code"] = code
    forecast["daily"]["weather_code"] = [code, code]
    mock_http(monkeypatch, forecast)
    result = fetch()
    assert result["current"]["weather_code"] == code
    assert all(day["weather_code"] == code for day in result["days"])


@pytest.mark.parametrize("field", ["current", "daily", "current_units", "daily_units", "timezone"])
def test_missing_provider_data_is_502_not_unknown_city(monkeypatch, forecast, field):
    del forecast[field]
    mock_http(monkeypatch, forecast)
    response = api_client().get("/api/weather/bulletin", params={"city": "Rosny-sous-Bois"})
    assert response.status_code == 502


@pytest.mark.parametrize("stage", ["geocoding", "forecast"])
@pytest.mark.parametrize("failure", ["timeout", "http", "json", "shape"])
def test_provider_failures_are_502(monkeypatch, stage, failure):
    client = httpx.AsyncClient
    locations = {"results": [{"name": "Rosny-sous-Bois", "latitude": 48.87, "longitude": 2.48}]}

    def respond(request):
        current_stage = "geocoding" if "geocoding" in request.url.host else "forecast"
        if stage != current_stage:
            return httpx.Response(200, json=locations)
        if failure == "timeout":
            raise httpx.ReadTimeout("Timeout", request=request)
        if failure == "http":
            return httpx.Response(503)
        if failure == "json":
            return httpx.Response(200, content="invalid json")
        return httpx.Response(200, json=[])

    monkeypatch.setattr(weather.httpx, "AsyncClient", lambda **kwargs: client(
        **kwargs, transport=httpx.MockTransport(respond),
    ))
    assert api_client().get("/api/weather/bulletin", params={"city": "Rosny-sous-Bois"}).status_code == 502


def test_huge_numeric_measure_is_rejected_without_overflow(monkeypatch, forecast):
    forecast["current"]["temperature_2m"] = 10 ** 1000
    mock_http(monkeypatch, forecast)
    with pytest.raises(ValueError):
        fetch()


def mock_sequence(monkeypatch, forecast, forecast_responses):
    """Géocodage valide ; le forecast renvoie successivement les statuts donnés."""
    calls = {"geocoding": 0, "forecast": 0}
    statuses = list(forecast_responses)
    locations = {"results": [{"name": "Rosny-sous-Bois", "country": "France",
                              "latitude": 48.87, "longitude": 2.48}]}

    def respond(request):
        if "geocoding" in request.url.host:
            calls["geocoding"] += 1
            return httpx.Response(200, json=locations)
        calls["forecast"] += 1
        status, headers = statuses.pop(0) if statuses else (200, {})
        return httpx.Response(status, headers=headers, json=forecast if status == 200 else {})

    client = httpx.AsyncClient
    monkeypatch.setattr(weather.httpx, "AsyncClient", lambda **kwargs: client(
        **kwargs, transport=httpx.MockTransport(respond),
    ))
    sleeps = []

    async def no_sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr(weather.asyncio, "sleep", no_sleep)
    return calls, sleeps


def test_rate_limit_retries_once_then_succeeds(monkeypatch, forecast):
    calls, sleeps = mock_sequence(monkeypatch, forecast, [(429, {"Retry-After": "1"}), (200, {})])
    assert fetch()["current"]["temperature_2m"] == 16.8
    assert calls["forecast"] == 2 and sleeps == [1.0]


def test_persistent_rate_limit_is_503_with_retry_after(monkeypatch, forecast):
    calls, _ = mock_sequence(monkeypatch, forecast, [(429, {}), (429, {})])
    response = api_client().get("/api/weather/bulletin", params={"city": "Rosny-sous-Bois"})
    assert response.status_code == 503
    assert response.headers["retry-after"] == "60"
    assert calls["forecast"] == 2


def test_long_retry_after_is_not_waited(monkeypatch, forecast):
    calls, sleeps = mock_sequence(monkeypatch, forecast, [(429, {"Retry-After": "3600"})])
    with pytest.raises(weather.WeatherRateLimitedError):
        fetch()
    assert calls["forecast"] == 1 and sleeps == []


def test_cache_avoids_repeated_provider_calls(monkeypatch, forecast):
    calls, _ = mock_sequence(monkeypatch, forecast, [])
    first, second = fetch(), fetch("rosny sous bois")
    assert first == second
    assert calls == {"geocoding": 1, "forecast": 1}


def test_expired_forecast_cache_is_refetched(monkeypatch, forecast):
    calls, _ = mock_sequence(monkeypatch, forecast, [])
    clock = [1000.0]
    monkeypatch.setattr(weather.time, "monotonic", lambda: clock[0])
    fetch()
    clock[0] += weather.FORECAST_TTL + 1
    fetch()
    assert calls == {"geocoding": 1, "forecast": 2}


def test_cached_forecast_that_became_stale_is_refetched(monkeypatch, forecast):
    calls, _ = mock_sequence(monkeypatch, forecast, [])
    fetch()
    cached_key = next(iter(weather._forecast_cache))
    stale = copy.deepcopy(forecast)
    stale["current"]["time"] = "2026-10-14T09:00"
    stamp, ttl, _ = weather._forecast_cache[cached_key]
    weather._forecast_cache[cached_key] = (stamp, ttl, stale)
    assert fetch()["current"]["time"] == "2026-10-14T17:45"
    assert calls["forecast"] == 2
