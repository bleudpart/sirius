# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Restored SIRIUS module API regression tests: galleries, tools, settings, packages, and memory."""
import os
import time
import uuid
from pathlib import Path

import pytest
import requests
from dotenv import dotenv_values

frontend_env = dotenv_values("/app/frontend/.env")
base_url = os.environ.get("REACT_APP_BACKEND_URL") or frontend_env.get("REACT_APP_BACKEND_URL")
if not base_url:
    raise RuntimeError("REACT_APP_BACKEND_URL is missing")
BASE_URL = base_url.rstrip("/")


@pytest.fixture(scope="module")
def api():
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    authenticated = session.post(f"{BASE_URL}/api/auth/local-session", timeout=20)
    assert authenticated.status_code == 200, authenticated.text
    yield session
    session.close()


def assert_nonempty_string(value):
    assert isinstance(value, str) and value.strip()


class TestStaticRestoredModules:
    def test_mythos_characters_and_image(self, api):
        response = api.get(f"{BASE_URL}/api/mythos/characters", timeout=20)
        assert response.status_code == 200, response.text
        characters = response.json().get("characters")
        assert isinstance(characters, list) and len(characters) == 13
        for character in characters:
            assert_nonempty_string(character.get("image"))
            assert_nonempty_string(character.get("voiceIntro"))
            assert isinstance(character.get("style"), dict) and character["style"]

        image = api.get(f"{BASE_URL}/api/mythos/img/argus.jpg", timeout=20)
        assert image.status_code == 200
        assert image.headers.get("content-type", "").startswith("image/jpeg")
        assert len(image.content) > 1_000

    def test_trailer_shots_image_and_download(self, api):
        response = api.get(f"{BASE_URL}/api/trailer/shots", timeout=20)
        assert response.status_code == 200, response.text
        data = response.json()
        assert data.get("downloadUrl") == "/api/trailer/download"
        assert isinstance(data.get("shots"), list) and len(data["shots"]) == 7
        assert [shot["id"] for shot in data["shots"]] == list(range(1, 8))

        image = api.get(f"{BASE_URL}/api/trailer/img/shot1.jpg", timeout=20)
        assert image.status_code == 200
        assert image.headers.get("content-type", "").startswith("image/jpeg")
        assert len(image.content) > 1_000

        archive = api.get(f"{BASE_URL}/api/trailer/download", timeout=30)
        assert archive.status_code == 200
        assert archive.headers.get("content-type", "").startswith("application/zip")
        assert archive.content.startswith(b"PK")

    def test_wahou_activation(self, api):
        response = api.post(f"{BASE_URL}/api/wahou/activate", timeout=20)
        assert response.status_code == 200, response.text
        assert response.json() == {"ok": True}


class TestLocusHeracles:
    def test_locus_geocode_lyon_with_weather_contract(self, api):
        response = api.post(
            f"{BASE_URL}/api/locus/geocode",
            json={"address": "Lyon"},
            timeout=30,
        )
        assert response.status_code == 200, response.text
        result = response.json().get("result")
        assert isinstance(result, dict)
        assert_nonempty_string(result.get("formatted"))
        assert isinstance(result.get("lat"), (int, float))
        assert isinstance(result.get("lng"), (int, float))
        assert 45.6 < result["lat"] < 45.9
        assert 4.6 < result["lng"] < 5.1
        weather = result.get("weather")
        assert isinstance(weather, dict)
        assert isinstance(weather.get("temp"), (int, float))
        assert isinstance(weather.get("wind_kmh"), (int, float))
        assert isinstance(weather.get("humidity"), (int, float))
        assert_nonempty_string(weather.get("condition"))

    def test_locus_route_paris_lyon(self, api):
        response = api.post(
            f"{BASE_URL}/api/locus/route",
            json={"from_address": "Paris", "to_address": "Lyon"},
            timeout=45,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert isinstance(data.get("distance_km"), (int, float))
        assert 430 <= data["distance_km"] <= 500
        assert_nonempty_string(data.get("duration_text"))
        parameters = data.get("parameters")
        assert isinstance(parameters, dict)
        assert_nonempty_string(parameters.get("from"))
        assert_nonempty_string(parameters.get("to"))
        assert "Paris" in parameters["from"]
        assert "Lyon" in parameters["to"]
        for point_name in ("from_point", "to_point"):
            point = data.get(point_name)
            assert isinstance(point, dict)
            assert_nonempty_string(point.get("formatted"))
            assert isinstance(point.get("lat"), (int, float))
            assert isinstance(point.get("lng"), (int, float))
        weather = data["to_point"].get("weather")
        assert isinstance(weather, dict)
        assert isinstance(weather.get("temp"), (int, float))
        assert_nonempty_string(weather.get("condition"))

    def test_heracles_email_username_contract_and_pdf(self, api):
        input_value = "contact@gmail.com"
        response = api.post(
            f"{BASE_URL}/api/heracles/check",
            json={"input": input_value},
            timeout=60,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert_nonempty_string(data.get("responseText"))
        assert data.get("parameters") == {"input": input_value, "inputType": "email"}
        result = data.get("result")
        assert isinstance(result, dict)
        assert result.get("type") == "email"
        assert result.get("validFormat") is True
        assert result.get("domain") == "gmail.com"
        assert result.get("hasMX") is True
        assert result.get("disposable") is False
        assert isinstance(result.get("mxRecords"), list) and result["mxRecords"]
        assert all(isinstance(record, str) and record for record in result["mxRecords"])
        assert_nonempty_string(result.get("summary"))
        assert data.get("requiresConfirmation") is False

        pdf = api.post(
            f"{BASE_URL}/api/heracles/pdf",
            json={"payload": data},
            timeout=30,
        )
        assert pdf.status_code == 200, pdf.text[:300]
        assert pdf.headers.get("content-type", "").startswith("application/pdf")
        assert pdf.content.startswith(b"%PDF")

        username = api.post(
            f"{BASE_URL}/api/heracles/check",
            json={"input": "johndoe"},
            timeout=60,
        )
        assert username.status_code == 200, username.text
        username_result = username.json().get("result")
        assert isinstance(username_result, dict)
        assert username_result.get("type") == "username"
        assert isinstance(username_result.get("links"), list) and username_result["links"]
        assert isinstance(username_result.get("results"), list)
        for link in username_result["links"]:
            assert_nonempty_string(link.get("platform"))
            assert_nonempty_string(link.get("url"))


class TestArgusAndScripts:
    def test_argus_scan_and_report(self, api):
        scan = api.post(f"{BASE_URL}/api/argus/scan", timeout=30)
        assert scan.status_code == 200, scan.text
        scan_data = scan.json()
        assert isinstance(scan_data.get("errors"), list)
        assert isinstance(scan_data.get("history"), list)

        report = api.post(
            f"{BASE_URL}/api/argus/report",
            json={"source": "hud", "message": "TEST_restored_modules error"},
            timeout=20,
        )
        assert report.status_code == 200, report.text
        report_data = report.json()
        assert report_data.get("severity") == "severe"
        assert report_data.get("ok") is True

        cleanup = api.post(
            f"{BASE_URL}/api/argus/fix",
            json={"fixId": "retest_backend", "errorType": "hud", "confirmed": True},
            timeout=20,
        )
        assert cleanup.status_code == 200, cleanup.text
        assert cleanup.json().get("ok") is True

    def test_script_analyze_install_list_delete(self, api):
        analyze = api.post(
            f"{BASE_URL}/api/scripts/analyze",
            json={"script": "echo hello", "name": "t"},
            timeout=60,
        )
        assert analyze.status_code == 200, analyze.text
        analysis = analyze.json()
        parameters = analysis.get("parameters")
        assert isinstance(parameters, dict)
        assert parameters.get("riskLevel") in {"auto", "severe", "critical"}
        assert_nonempty_string(parameters.get("scriptType"))
        assert parameters.get("script") == "echo hello"
        assert_nonempty_string(parameters.get("summary"))
        assert isinstance(parameters.get("dangers"), list)
        assert_nonempty_string(analysis.get("responseText"))

        test_name = f"TEST_restored_{uuid.uuid4().hex[:8]}"
        install = api.post(
            f"{BASE_URL}/api/scripts/install",
            json={"script": "echo hello", "name": test_name},
            timeout=20,
        )
        assert install.status_code == 200, install.text
        installed = install.json()
        assert installed.get("ok") is True
        script_id = installed.get("id")
        assert_nonempty_string(script_id)
        try:
            listing = api.get(f"{BASE_URL}/api/scripts", timeout=20)
            assert listing.status_code == 200, listing.text
            scripts = listing.json().get("scripts")
            assert isinstance(scripts, list)
            assert any(item.get("id") == script_id and item.get("name") == test_name for item in scripts)
        finally:
            deleted = api.delete(f"{BASE_URL}/api/scripts/{script_id}", timeout=20)
            assert deleted.status_code == 200, deleted.text
            assert deleted.json().get("ok") is True

        listing_after = api.get(f"{BASE_URL}/api/scripts", timeout=20)
        assert listing_after.status_code == 200
        assert all(item.get("id") != script_id for item in listing_after.json().get("scripts", []))


class TestSuggestionsSystemAndInstall:
    def test_suggestions_contract_and_settings_restore(self, api):
        try:
            proactive = api.post(
                f"{BASE_URL}/api/suggestions/settings",
                json={"settings": {"mode": "proactif"}},
                timeout=20,
            )
            assert proactive.status_code == 200, proactive.text
            assert proactive.json().get("mode") == "proactif"

            evaluation = api.post(
                f"{BASE_URL}/api/suggestions/evaluate",
                json={"trigger": "app_open"},
                timeout=20,
            )
            assert evaluation.status_code == 200, evaluation.text
            data = evaluation.json()
            assert data.get("settings", {}).get("mode") == "proactif"
            suggestions = data.get("suggestions")
            assert isinstance(suggestions, list) and suggestions
            for suggestion in suggestions:
                assert_nonempty_string(suggestion.get("urgency"))
                assert_nonempty_string(suggestion.get("risk_level"))
                assert_nonempty_string(suggestion.get("description"))
        finally:
            restored = api.post(
                f"{BASE_URL}/api/suggestions/settings",
                json={"settings": {"mode": "equilibre"}},
                timeout=20,
            )
            assert restored.status_code == 200, restored.text
            assert restored.json().get("mode") == "equilibre"

    def test_system_diagnostic_and_mode_restore(self, api):
        diagnostic = api.get(f"{BASE_URL}/api/system/diagnostic", timeout=30)
        assert diagnostic.status_code == 200, diagnostic.text
        data = diagnostic.json()
        assert_nonempty_string(data.get("responseText"))
        assert isinstance(data.get("cpu"), (int, float))
        assert isinstance(data.get("ram"), (int, float))

        frugal = api.post(f"{BASE_URL}/api/system/mode", json={"mode": "frugal"}, timeout=20)
        assert frugal.status_code == 200, frugal.text
        assert frugal.json().get("mode") == "frugal"
        normal = api.post(f"{BASE_URL}/api/system/mode", json={"mode": "normal"}, timeout=20)
        assert normal.status_code == 200, normal.text
        assert normal.json().get("mode") == "normal"

    def test_install_environment_step_contract(self, api):
        install = api.post(
            f"{BASE_URL}/api/install/step",
            json={"step": "environment"},
            timeout=20,
        )
        assert install.status_code == 200, install.text
        data = install.json()
        assert data.get("status") == "ok"
        assert data.get("next") == "micro"
        assert isinstance(data.get("items"), list) and data["items"]
        for item in data["items"]:
            assert_nonempty_string(item.get("label"))
            assert item.get("state") == "ok"

        keys = api.post(f"{BASE_URL}/api/keys/check", json={"keys": {}}, timeout=20)
        assert keys.status_code == 200, keys.text
        key_data = keys.json()
        assert key_data.get("ok") is True
        assert key_data.get("statuses", {}).get("groq") == "ok"


class TestPackagerAndMemory:
    def test_packager_build_and_download(self, api):
        build = api.post(f"{BASE_URL}/api/packager/build", timeout=60)
        assert build.status_code == 200, build.text
        data = build.json()
        assert data.get("ok") is True
        parameters = data.get("parameters")
        assert isinstance(parameters, dict)
        assert isinstance(parameters.get("sizeBytes"), int) and parameters["sizeBytes"] > 0
        assert_nonempty_string(parameters.get("generatedAt"))
        assert_nonempty_string(parameters.get("icon"))
        platforms = parameters.get("platforms")
        assert isinstance(platforms, dict)
        assert set(platforms) == {"windows", "android", "iphone", "docs"}
        assert all(value == "prêt" for value in platforms.values())
        tree = parameters.get("tree")
        assert isinstance(tree, dict) and len(tree) == 4
        assert set(tree) == {
            "SIRIUS_INSTALLER/windows/",
            "SIRIUS_INSTALLER/android/",
            "SIRIUS_INSTALLER/iphone/",
            "SIRIUS_INSTALLER/docs/",
        }
        assert all(isinstance(files, list) and files for files in tree.values())

        assert_nonempty_string(parameters.get("note"))
        assert parameters.get("downloadUrl") == "/api/packager/download"

        archive = api.get(f"{BASE_URL}{parameters['downloadUrl']}", timeout=60)
        assert archive.status_code == 200
        assert archive.headers.get("content-type", "").startswith("application/zip")
        assert archive.content.startswith(b"PK")

        installer = api.get(f"{BASE_URL}/api/packager/installer", timeout=60)
        assert installer.status_code == 200
        assert installer.headers.get("content-type", "").startswith("application/zip")
        assert installer.content.startswith(b"PK")

    def test_memory_list_and_export(self, api):
        listing = api.get(f"{BASE_URL}/api/memory/list", timeout=20)
        assert listing.status_code == 200, listing.text
        data = listing.json()
        assert isinstance(data.get("memories"), list)
        assert isinstance(data.get("stats"), dict)
        assert isinstance(data["stats"].get("total"), int)

        exported = api.get(f"{BASE_URL}/api/memory/export", timeout=20)
        assert exported.status_code == 200, exported.text[:300]
        assert exported.headers.get("content-type", "").startswith("application/json")
        assert isinstance(exported.json(), list)



# ATLAS route and LOCUS geocoding contracts used by map/navigation UI.
class TestAtlasNavigation:
    def _post_with_single_retry(self, api, endpoint, payload, timeout=60):
        response = api.post(f"{BASE_URL}{endpoint}", json=payload, timeout=timeout)
        if response.status_code in {429, 500, 502, 503, 504}:
            time.sleep(2)
            response = api.post(f"{BASE_URL}{endpoint}", json=payload, timeout=timeout)
        return response

    @staticmethod
    def _assert_point(point):
        assert isinstance(point, dict)
        assert_nonempty_string(point.get("formatted"))
        assert isinstance(point.get("lat"), (int, float))
        assert isinstance(point.get("lng"), (int, float))

    @staticmethod
    def _assert_path(path):
        assert isinstance(path, list) and len(path) > 100
        for point in path:
            assert set(point) == {"lat", "lng"}
            assert isinstance(point["lat"], (int, float))
            assert isinstance(point["lng"], (int, float))
            assert -90 <= point["lat"] <= 90
            assert -180 <= point["lng"] <= 180

    def test_route_from_address_lyon_to_marseille(self, api):
        response = self._post_with_single_retry(
            api,
            "/api/atlas/route",
            {"from_address": "Lyon", "to_address": "Marseille"},
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert isinstance(data.get("distance_km"), (int, float))
        assert 290 <= data["distance_km"] <= 340
        assert_nonempty_string(data.get("duration_text"))
        self._assert_point(data.get("from_point"))
        self._assert_point(data.get("to_point"))
        assert "Lyon" in data["from_point"]["formatted"]
        assert "Marseille" in data["to_point"]["formatted"]
        self._assert_path(data.get("path"))

    def test_route_from_gps_coordinates_to_versailles(self, api):
        response = self._post_with_single_retry(
            api,
            "/api/atlas/route",
            {
                "from_lat": 48.85,
                "from_lng": 2.35,
                "to_address": "Versailles",
            },
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data.get("from_point") == {
            "lat": 48.85,
            "lng": 2.35,
            "formatted": "Ma position",
        }
        self._assert_point(data.get("to_point"))
        assert "Versailles" in data["to_point"]["formatted"]
        assert isinstance(data.get("distance_km"), (int, float)) and data["distance_km"] > 0
        assert_nonempty_string(data.get("duration_text"))
        self._assert_path(data.get("path"))

    def test_route_unknown_destination_returns_french_404(self, api):
        response = self._post_with_single_retry(
            api,
            "/api/atlas/route",
            {"from_address": "Lyon", "to_address": "zzzzqqqqxxxx"},
        )
        assert response.status_code == 404, response.text
        detail = response.json().get("detail")
        assert_nonempty_string(detail)
        assert "introuvable" in detail.lower()

    def test_locus_tour_eiffel_regression_with_empty_keys(self, api):
        response = self._post_with_single_retry(
            api,
            "/api/locus/geocode",
            {"address": "Tour Eiffel", "keys": {}},
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data.get("intent") == "locus.geocode"
        assert_nonempty_string(data.get("responseText"))
        result = data.get("result")
        self._assert_point(result)
        assert "Eiffel" in result["formatted"]
        assert 48.84 <= result["lat"] <= 48.87
        assert 2.28 <= result["lng"] <= 2.31



# Complete audit contracts for HÉPHAÏSTOS, PROMO, MYTHOS, trailer, and contextual DISPLAY.
class TestSiriusCompleteAudit:
    @staticmethod
    def _get_stream(api, endpoint, expected_content_type, magic):
        with api.get(f"{BASE_URL}{endpoint}", timeout=90, stream=True) as response:
            assert response.status_code == 200, response.text[:300]
            assert response.headers.get("content-type", "").startswith(expected_content_type)
            first_chunk = next(response.iter_content(chunk_size=4096))
            assert first_chunk.startswith(magic)

    def test_hephaistos_diagnostic_is_19_of_19(self, api):
        response = api.get(f"{BASE_URL}/api/hephaistos/diagnostic?source=pytest_iteration_25", timeout=120)
        assert response.status_code == 200, response.text
        data = response.json()
        summary = data.get("summary")
        assert isinstance(summary, dict)
        assert summary.get("total") == 19
        assert summary.get("passed") == 19
        assert summary.get("failed") == 0
        assert summary.get("rate") == 100
        assert summary.get("state") == "OK"
        assert summary.get("failed_modules") == []
        groups = data.get("groups")
        assert isinstance(groups, dict) and set(groups) == {"endpoints", "system", "integrations"}
        assert sum(len(items) for items in groups.values()) == 19
        assert all(item.get("status") == "OK" for items in groups.values() for item in items)

    def test_promo_shots_images_zip_and_ready_video(self, api):
        response = api.get(f"{BASE_URL}/api/promo/shots", timeout=30)
        assert response.status_code == 200, response.text
        data = response.json()
        assert data.get("downloadUrl") == "/api/promo/download"
        shots = data.get("shots")
        assert isinstance(shots, list) and len(shots) == 10
        assert [shot.get("id") for shot in shots] == list(range(1, 11))
        assert all(shot.get("image") == f"/api/promo/img/shot{shot['id']}.jpg" for shot in shots)

        image = api.get(f"{BASE_URL}/api/promo/img/shot1.jpg", timeout=30)
        assert image.status_code == 200
        assert image.headers.get("content-type", "").startswith("image/jpeg")
        assert image.content.startswith(b"\xff\xd8") and len(image.content) > 1_000

        self._get_stream(api, "/api/promo/download", "application/zip", b"PK")
        status = api.get(f"{BASE_URL}/api/promo/export/status", timeout=30)
        assert status.status_code == 200, status.text
        status_data = status.json()
        assert status_data.get("ready") is True
        assert status_data.get("state") != "running"
        self._get_stream(api, "/api/promo/export/video", "video/mp4", b"\x00\x00")

    def test_mythos_thirteen_characters_and_new_images(self, api):
        response = api.get(f"{BASE_URL}/api/mythos/characters", timeout=30)
        assert response.status_code == 200, response.text
        characters = response.json().get("characters")
        assert isinstance(characters, list) and len(characters) == 13
        by_module = {item.get("module"): item for item in characters}
        assert by_module["ATLAS#"]["character"] == "Atlas"
        assert by_module["ATLAS#"]["image"] == "/api/mythos/img/atlas.jpg"
        assert by_module["SIRIUS DISPLAY#"]["character"] == "Iris"
        assert by_module["SIRIUS DISPLAY#"]["image"] == "/api/mythos/img/iris.jpg"
        assert all(isinstance(item.get("style"), dict) and item["style"] for item in characters)
        for filename in ("atlas.jpg", "iris.jpg"):
            image = api.get(f"{BASE_URL}/api/mythos/img/{filename}", timeout=30)
            assert image.status_code == 200
            assert image.headers.get("content-type", "").startswith("image/jpeg")
            assert image.content.startswith(b"\xff\xd8") and len(image.content) > 1_000

    def test_display_ask_initial_and_contextual_follow_up(self, api):
        initial = api.post(
            f"{BASE_URL}/api/display/ask",
            json={
                "question": "Quels ingrédients ?",
                "context": {
                    "name": "r.txt",
                    "kind": "text",
                    "analysis": "recette tarte",
                    "text": "Ingredients: pommes, sucre",
                },
                "keys": {},
                "history": [],
            },
            timeout=90,
        )
        assert initial.status_code == 200, initial.text
        initial_data = initial.json()
        assert initial_data.get("ok") is True
        answer = initial_data.get("answer")
        assert_nonempty_string(answer)
        folded = answer.lower()
        assert "pomme" in folded and "sucre" in folded
        assert not any(term in folded for term in ("l'utilisateur", "daniel il", "daniel elle"))

        follow_up = api.post(
            f"{BASE_URL}/api/display/ask",
            json={
                "question": "Et combien de temps de cuisson ?",
                "context": {
                    "name": "r.txt",
                    "kind": "text",
                    "analysis": "recette tarte",
                    "text": "Ingredients: pommes, sucre. Cuisson 40 minutes.",
                },
                "keys": {},
                "history": [
                    {"role": "user", "content": "Quels ingrédients ?"},
                    {"role": "assistant", "content": "Des pommes et du sucre."},
                ],
            },
            timeout=90,
        )
        assert follow_up.status_code == 200, follow_up.text
        follow_data = follow_up.json()
        assert follow_data.get("ok") is True
        follow_answer = follow_data.get("answer")
        assert_nonempty_string(follow_answer)
        follow_folded = follow_answer.lower()
        assert ("40" in follow_answer or "quarante" in follow_folded) and "minute" in follow_folded

    def test_trailer_shots_contract(self, api):
        response = api.get(f"{BASE_URL}/api/trailer/shots", timeout=30)
        assert response.status_code == 200, response.text
        data = response.json()
        assert data.get("downloadUrl") == "/api/trailer/download"
        assert isinstance(data.get("shots"), list) and len(data["shots"]) == 7
        assert [shot.get("id") for shot in data["shots"]] == list(range(1, 8))
