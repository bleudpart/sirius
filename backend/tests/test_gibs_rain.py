import asyncio
from datetime import datetime, timezone

import httpx
import pytest

import gibs_rain

NOW = datetime(2026, 11, 4, 3, 0, tzinfo=timezone.utc)
CAPABILITIES = b"""<?xml version="1.0"?>
<WMS_Capabilities xmlns="http://www.opengis.net/wms"><Capability><Layer>
  <Layer><Name>IMERG_Precipitation_Rate_30min</Name>
    <Dimension name="time" default="2026-11-03T15:30:00Z">2026-11-02T00:00:00Z/2026-11-03T15:30:00Z/PT30M</Dimension>
  </Layer>
</Layer></Capability></WMS_Capabilities>"""


@pytest.fixture(autouse=True)
def clear_cache():
    gibs_rain.clear_rain_cache()
    yield
    gibs_rain.clear_rain_cache()


def fetch(content=CAPABILITIES, status=200, hits=None):
    def handler(request):
        assert request.url.host == "gibs.earthdata.nasa.gov"
        assert set(request.url.params) == {"SERVICE", "VERSION", "REQUEST"}
        if hits is not None:
            hits.append(request.url)
        return httpx.Response(status, content=content)

    return asyncio.run(gibs_rain.rain_metadata(now=NOW, transport=httpx.MockTransport(handler)))


def test_rain_publishes_actual_delayed_times_and_caches_metadata():
    hits = []
    report = fetch(hits=hits)
    assert report["source"]["ok"] is True and report["read_only"] is True
    assert report["latest"] == "2026-11-03T15:30:00Z"
    assert len(report["times"]) == 48
    assert report["times"][0] == "2026-11-02T16:00:00Z"
    assert report["times"][-1] == report["latest"]
    assert fetch(hits=hits)["latest"] == report["latest"]
    assert len(hits) == 1


def test_rain_times_respect_gaps_in_the_nasa_availability():
    xml = CAPABILITIES.replace(
        b"2026-11-02T00:00:00Z/2026-11-03T15:30:00Z/PT30M",
        b"2026-11-03T13:00:00Z/2026-11-03T14:00:00Z/PT30M,"
        b"2026-11-03T15:00:00Z/2026-11-03T15:30:00Z/PT30M",
    )
    assert fetch(content=xml)["times"] == [
        "2026-11-03T13:00:00Z", "2026-11-03T13:30:00Z", "2026-11-03T14:00:00Z",
        "2026-11-03T15:00:00Z", "2026-11-03T15:30:00Z",
    ]


@pytest.mark.parametrize("content", [
    b"invalid",
    b'<!DOCTYPE test [<!ENTITY x "x">]><test/>',
    CAPABILITIES.replace(b"2026-11-03T15:30:00Z", b"2026-11-05T15:30:00Z"),
    CAPABILITIES.replace(b"PT30M", b"PT1H"),
])
def test_rain_reports_invalid_metadata_without_guessing_a_date(content):
    result = fetch(content=content)
    assert result["source"]["ok"] is False
    assert result["source"]["detail"] and result["latest"] is None and result["times"] == []


def test_rain_reports_server_errors_and_refuses_oversized_responses(monkeypatch):
    report = fetch(status=503)
    assert report["source"]["ok"] is False and "503" in report["source"]["detail"]
    gibs_rain.clear_rain_cache()
    monkeypatch.setattr(gibs_rain, "MAX_BYTES", 10)
    report = fetch()
    assert report["source"]["ok"] is False and "volumineuse" in report["source"]["detail"]
