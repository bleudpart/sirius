"""Natural-language UI intent routing and authenticated cookie contract tests."""
import os
import re
from pathlib import Path

import pytest
import requests
from dotenv import dotenv_values
from pymongo import MongoClient

FRONTEND_ENV = dotenv_values("/app/frontend/.env")
BACKEND_ENV = dotenv_values("/app/backend/.env")
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
    cookies = response.headers.get("set-cookie", "").lower()
    assert cookies.count("httponly") >= 2
    yield session
    session.close()


# Local auth storage must retain bcrypt's expected $2b$ hash format.
def test_normal_user_password_hash_uses_bcrypt_2b_prefix():
    email, _ = _normal_user_credentials()
    mongo_url = BACKEND_ENV.get("MONGO_URL")
    db_name = BACKEND_ENV.get("DB_NAME")
    if not mongo_url or not db_name:
        pytest.skip("MONGO_URL/DB_NAME missing from backend environment")
    client = MongoClient(mongo_url, serverSelectionTimeoutMS=3000)
    try:
        user = client[db_name].users.find_one({"email": email}, {"_id": 0, "password_hash": 1})
        assert user and isinstance(user.get("password_hash"), str)
        assert user["password_hash"].startswith("$2b$")
    finally:
        client.close()


def _assert_intent(session, text, action, target=None):
    response = session.post(
        f"{BASE_URL}/api/intent",
        json={"text": text},
        timeout=20,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert isinstance(data, dict)
    assert data.get("action") == action, f"{text!r} routed as {data!r}"
    if target is not None:
        assert data.get("target") == target, f"{text!r} routed as {data!r}"
    if action not in {"none", "stop_reading"}:
        assert isinstance(data.get("say"), str) and data["say"].strip()
    return data


# Authentication boundary and cookie-based access for POST /api/intent.
class TestIntentAuthentication:
    def test_intent_rejects_unauthenticated_request(self):
        response = requests.post(
            f"{BASE_URL}/api/intent",
            json={"text": "je veux voir la bourse"},
            timeout=20,
        )
        assert response.status_code in {401, 403}, response.text
        detail = response.json().get("detail", "")
        assert isinstance(detail, str) and detail

    def test_authenticated_cookie_session_can_call_intent(self, authenticated_session):
        data = _assert_intent(
            authenticated_session,
            "je veux voir la bourse",
            "open_module",
            "nummarius",
        )
        assert "access_token" not in data and "refresh_token" not in data


# Required free-form French command mappings and conversation fallthrough.
class TestNaturalLanguageIntentMappings:
    @pytest.mark.parametrize(
        ("text", "action", "target"),
        [
            ("fais disparaître toutes les fenêtres", "minimize_all", None),
            ("débarrasse-moi de thémis", "close_module", "themis"),
            ("tais-toi", "stop_reading", None),
            ("coupe la musique de fond", "stop_music", None),
            ("montre-moi mon agenda", "open_module", "gcal"),
            ("je voudrais consulter les prédictions", "open_module", "oracle"),
            ("affiche le module juridique", "open_module", "solon"),
        ],
    )
    def test_required_command_mapping(self, authenticated_session, text, action, target):
        _assert_intent(authenticated_session, text, action, target)

    @pytest.mark.parametrize(
        "text",
        [
            "quelle est la capitale de l'Australie",
            "quelle est la capitale du Japon",
            "explique-moi comment fonctionne la bourse",
            "quel est mon prochain rendez-vous dans l'agenda ?",
        ],
    )
    def test_information_requests_do_not_trigger_ui_actions(self, authenticated_session, text):
        _assert_intent(authenticated_session, text, "none")

    def test_empty_text_returns_none(self, authenticated_session):
        _assert_intent(authenticated_session, "   ", "none")

    def test_invalid_payload_is_rejected(self, authenticated_session):
        response = authenticated_session.post(
            f"{BASE_URL}/api/intent",
            json={},
            timeout=20,
        )
        assert response.status_code == 422, response.text
        detail = response.json().get("detail")
        assert isinstance(detail, list) and detail
