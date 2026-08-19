"""Iteration 42: Web Agent, protected vision, intent, Neural2-F TTS, and media persistence tests."""
import base64
import os
import re
from pathlib import Path

import pytest
import requests
from dotenv import dotenv_values

FRONTEND_ENV = dotenv_values("/app/frontend/.env")
BASE_URL = (
    os.environ.get("REACT_APP_BACKEND_URL")
    or FRONTEND_ENV.get("REACT_APP_BACKEND_URL", "")
).rstrip("/")
if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL is missing")

CREDENTIALS_PATH = Path("/app/memory/test_credentials.md")


def _normal_user_credentials():
    if not CREDENTIALS_PATH.exists():
        pytest.skip("Missing /app/memory/test_credentials.md")
    text = CREDENTIALS_PATH.read_text(encoding="utf-8")
    section = re.search(
        r"## Compte test utilisateur normal(?P<body>.*?)(?:\n## |\Z)",
        text,
        flags=re.S,
    )
    if not section:
        pytest.skip("Normal test-user section missing from test_credentials.md")
    body = section.group("body")
    email = re.search(r"(?im)^- Email\s*:\s*(\S+)", body)
    password = re.search(r"(?im)^- Mot de passe\s*:\s*(\S+)", body)
    if not email or not password:
        pytest.skip("Normal test-user email/password missing from test_credentials.md")
    return email.group(1), password.group(1)


@pytest.fixture(scope="module")
def authenticated_session():
    email, password = _normal_user_credentials()
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    response = session.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    if response.status_code != 200:
        pytest.fail(f"Authentication failed ({response.status_code}): {response.text[:500]}")
    data = response.json()
    assert data["email"] == email
    assert data["role"] == "user"
    assert session.cookies.get("access_token")
    assert session.cookies.get("refresh_token")
    assert response.headers.get("set-cookie", "").lower().count("httponly") >= 2
    yield session
    session.close()


@pytest.fixture(scope="module")
def webagent_result(authenticated_session):
    response = authenticated_session.post(
        f"{BASE_URL}/api/webagent/run",
        json={"query": "météo Paris demain"},
        timeout=60,
    )
    if response.status_code != 200:
        pytest.fail(f"Web Agent failed ({response.status_code}): {response.text[:1000]}")
    data = response.json()
    yield data
    record = data.get("file") or {}
    if record.get("id"):
        cleanup = authenticated_session.delete(
            f"{BASE_URL}/api/files/{record['id']}",
            timeout=30,
        )
        assert cleanup.status_code in {200, 404}, cleanup.text


# Web Agent authentication, validation, real screenshot, and media persistence.
class TestWebAgent:
    def test_rejects_unauthenticated_request(self):
        response = requests.post(
            f"{BASE_URL}/api/webagent/run",
            json={"query": "météo Paris demain"},
            timeout=30,
        )
        assert response.status_code in {401, 403}, response.text
        assert isinstance(response.json().get("detail"), str)

    def test_rejects_empty_authenticated_body_with_french_detail(self, authenticated_session):
        response = authenticated_session.post(
            f"{BASE_URL}/api/webagent/run",
            json={},
            timeout=30,
        )
        assert response.status_code == 400, response.text
        detail = response.json().get("detail", "")
        assert isinstance(detail, str) and "manquante" in detail.lower()

    def test_run_returns_real_screenshot_and_file_record(self, webagent_result):
        data = webagent_result
        assert data.get("succes") is True
        assert isinstance(data.get("titre"), str) and data["titre"].strip()
        assert isinstance(data.get("image_b64"), str) and len(data["image_b64"]) > 10000
        image = base64.b64decode(data["image_b64"], validate=True)
        assert image.startswith(b"\xff\xd8\xff"), "Web Agent result is not a JPEG screenshot"
        assert len(image) > 7500
        assert isinstance(data.get("extraits"), list) and data["extraits"]
        assert all(isinstance(item, str) and item.strip() for item in data["extraits"])
        record = data.get("file")
        assert isinstance(record, dict)
        assert isinstance(record.get("id"), str) and record["id"]
        assert record.get("original_filename", "").startswith("web-")
        assert record.get("original_filename", "").endswith(".jpg")
        assert record.get("content_type") == "image/jpeg"
        assert record.get("dossier") == "Photos"
        assert isinstance(record.get("size"), int) and record["size"] == len(image)
        assert "_id" not in record

    def test_created_record_appears_in_authenticated_media_list(self, authenticated_session, webagent_result):
        record = webagent_result["file"]
        response = authenticated_session.get(f"{BASE_URL}/api/files", timeout=30)
        assert response.status_code == 200, response.text
        files = response.json()
        assert isinstance(files, list)
        saved = next((item for item in files if item.get("id") == record["id"]), None)
        assert saved is not None
        assert saved["original_filename"] == record["original_filename"]
        assert saved["dossier"] == "Photos"
        assert saved["content_type"] == "image/jpeg"

    def test_media_list_rejects_unauthenticated_access(self, webagent_result):
        response = requests.get(f"{BASE_URL}/api/files", timeout=30)
        assert response.status_code in {401, 403}, (
            "Médiathèque records, including Web Agent screenshots, are exposed without authentication"
        )


# LLM intent router recognizes an explicit internet shopping search.
def test_web_agent_intent_contains_requested_subject(authenticated_session):
    response = authenticated_session.post(
        f"{BASE_URL}/api/intent",
        json={"text": "trouve-moi le prix des pneus Continental sur internet"},
        timeout=30,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data.get("action") == "web_agent", data
    assert "continental" in (data.get("target") or "").lower(), data


# Protected vision rejects anonymous use and validates corrupt base64 locally.
class TestProtectedVision:
    def test_vision_rejects_unauthenticated_request(self):
        response = requests.post(
            f"{BASE_URL}/api/vision/analyze",
            json={"image": "data:image/jpeg;base64,%%%BAD%%%"},
            timeout=30,
        )
        assert response.status_code in {401, 403}, response.text
        assert "application/json" in response.headers.get("content-type", "").lower()

    def test_invalid_base64_returns_400_french_json(self, authenticated_session):
        response = authenticated_session.post(
            f"{BASE_URL}/api/vision/analyze",
            json={"image": "data:image/jpeg;base64,%%%BAD%%%"},
            timeout=30,
        )
        assert response.status_code == 400, response.text
        assert "application/json" in response.headers.get("content-type", "").lower()
        detail = response.json().get("detail", "")
        assert isinstance(detail, str) and detail.startswith("Image invalide")
        assert "base64" in detail.lower()


# Neural2-F premium voice produces a non-empty MP3 payload with requested controls.
def test_neural2f_tts_returns_audio():
    response = requests.post(
        f"{BASE_URL}/api/tts/google",
        json={
            "text": "Bonjour monsieur",
            "voice": "fr-FR-Neural2-F",
            "rate": 1.0,
            "pitch": 2,
        },
        timeout=30,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data.get("format") == "mp3"
    assert isinstance(data.get("audio"), str) and len(data["audio"]) > 1000
    audio = base64.b64decode(data["audio"], validate=True)
    assert len(audio) > 500
    assert audio.startswith((b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"))
