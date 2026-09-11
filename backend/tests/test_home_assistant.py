# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""KERAUNOS Home Assistant proxy API integration and persistence tests."""
import os

import pytest
import requests
from dotenv import dotenv_values

frontend_env = dotenv_values("/app/frontend/.env")
base_url = os.environ.get("REACT_APP_BACKEND_URL") or frontend_env.get("REACT_APP_BACKEND_URL")
if not base_url:
    raise RuntimeError("REACT_APP_BACKEND_URL is missing")
BASE_URL = base_url.rstrip("/")
HA_URL = "http://localhost:8199"
TOKEN = "testtoken123"


@pytest.fixture(scope="module")
def api():
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    cleanup = session.delete(f"{BASE_URL}/api/ha/config", timeout=20)
    assert cleanup.status_code == 200, cleanup.text
    yield session
    cleanup = session.delete(f"{BASE_URL}/api/ha/config", timeout=20)
    assert cleanup.status_code == 200, cleanup.text
    session.close()


def test_initial_config_is_empty(api):
    response = api.get(f"{BASE_URL}/api/ha/config", timeout=20)
    assert response.status_code == 200, response.text
    assert response.json() == {"configured": False, "base_url": None}


def test_connection_success_and_invalid_token(api):
    success = api.post(
        f"{BASE_URL}/api/ha/test",
        json={"base_url": HA_URL, "token": TOKEN},
        timeout=20,
    )
    assert success.status_code == 200, success.text
    assert success.json() == {"ok": True, "message": "API running."}

    rejected = api.post(
        f"{BASE_URL}/api/ha/test",
        json={"base_url": HA_URL, "token": "wrong-token"},
        timeout=20,
    )
    assert rejected.status_code == 401, rejected.text
    assert rejected.json() == {"detail": "Token invalide ou expiré."}


def test_save_rejects_invalid_url_then_persists_without_exposing_token(api):
    invalid = api.post(
        f"{BASE_URL}/api/ha/config",
        json={"base_url": "ftp://x", "token": TOKEN},
        timeout=20,
    )
    assert invalid.status_code == 400, invalid.text
    assert invalid.json()["detail"] == "L'URL doit commencer par http:// ou https://"

    saved = api.post(
        f"{BASE_URL}/api/ha/config",
        json={"base_url": HA_URL, "token": TOKEN},
        timeout=20,
    )
    assert saved.status_code == 200, saved.text
    assert saved.json() == {"ok": True, "message": "API running."}

    configured = api.get(f"{BASE_URL}/api/ha/config", timeout=20)
    assert configured.status_code == 200, configured.text
    assert configured.json() == {"configured": True, "base_url": HA_URL}
    assert TOKEN not in configured.text
    assert "token" not in configured.json()


def test_states_contract_and_filtering(api):
    response = api.get(f"{BASE_URL}/api/ha/states", timeout=20)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["count"] == 4
    entities = {item["entity_id"]: item for item in data["entities"]}
    assert set(entities) == {
        "light.salon",
        "switch.prise_tv",
        "sensor.temperature",
        "scene.soiree",
    }
    assert entities["light.salon"] == {
        "entity_id": "light.salon",
        "domain": "light",
        "state": "on",
        "name": "Salon",
        "unit": None,
        "device_class": None,
        "brightness": 180,
        "controllable": True,
    }
    assert entities["switch.prise_tv"]["controllable"] is True
    assert entities["switch.prise_tv"]["state"] == "off"
    assert entities["sensor.temperature"]["controllable"] is False
    assert entities["sensor.temperature"]["unit"] == "°C"
    assert entities["sensor.temperature"]["state"] == "21.5"
    assert entities["scene.soiree"]["controllable"] is True


def test_toggle_scene_and_service_forward_exact_calls(api):
    light = api.post(
        f"{BASE_URL}/api/ha/toggle",
        json={"entity_id": "light.salon"},
        timeout=20,
    )
    assert light.status_code == 200, light.text
    assert light.json() == {"ok": True}

    scene = api.post(
        f"{BASE_URL}/api/ha/toggle",
        json={"entity_id": "scene.soiree"},
        timeout=20,
    )
    assert scene.status_code == 200, scene.text
    assert scene.json() == {"ok": True}

    service_data = {"entity_id": "light.salon", "brightness_pct": 50}
    service = api.post(
        f"{BASE_URL}/api/ha/service",
        json={"domain": "light", "service": "turn_on", "data": service_data},
        timeout=20,
    )
    assert service.status_code == 200, service.text
    assert service.json() == {"ok": True}

    calls_response = requests.get(f"{HA_URL}/__calls", timeout=10)
    assert calls_response.status_code == 200
    calls = calls_response.json()["calls"]
    assert {"method": "POST", "path": "/api/services/homeassistant/toggle", "json": {"entity_id": "light.salon"}} in calls
    assert {"method": "POST", "path": "/api/services/scene/turn_on", "json": {"entity_id": "scene.soiree"}} in calls
    assert {"method": "POST", "path": "/api/services/light/turn_on", "json": service_data} in calls


@pytest.mark.parametrize(
    ("endpoint", "payload"),
    [
        ("toggle", {"entity_id": ""}),
        ("service", {"domain": "", "service": "", "data": {}}),
    ],
)
def test_control_endpoints_reject_blank_commands(api, endpoint, payload):
    response = api.post(f"{BASE_URL}/api/ha/{endpoint}", json=payload, timeout=20)
    assert response.status_code == 422, response.text


def test_delete_resets_config_and_protected_endpoints_fail_cleanly(api):
    deleted = api.delete(f"{BASE_URL}/api/ha/config", timeout=20)
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"ok": True}

    configured = api.get(f"{BASE_URL}/api/ha/config", timeout=20)
    assert configured.status_code == 200
    assert configured.json() == {"configured": False, "base_url": None}

    states = api.get(f"{BASE_URL}/api/ha/states", timeout=20)
    assert states.status_code == 400
    assert states.json() == {"detail": "Home Assistant non configuré."}
