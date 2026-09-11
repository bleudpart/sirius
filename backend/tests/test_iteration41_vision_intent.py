"""Iteration 41: authenticated Sirius Voyant and Groq intent fallback regression tests."""
import base64
import io
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pytest
import requests
from dotenv import dotenv_values
from PIL import Image, ImageDraw, ImageFont

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
        pytest.skip("Normal-user credentials missing from test_credentials.md")
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
    assert response.json()["email"] == email
    assert session.cookies.get("access_token")
    assert session.cookies.get("refresh_token")
    assert response.headers.get("set-cookie", "").lower().count("httponly") >= 2
    yield session
    session.close()


def _assert_intent(session, text, action, target=None):
    response = session.post(
        f"{BASE_URL}/api/intent",
        json={"text": text},
        timeout=30,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert isinstance(data, dict)
    assert data.get("action") == action, f"{text!r} routed as {data!r}"
    if target is not None:
        assert data.get("target") == target, f"{text!r} routed as {data!r}"
    return data


def _jpeg_data_url():
    image = Image.new("RGB", (1200, 700), "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 82)
        small = ImageFont.truetype("DejaVuSans.ttf", 46)
    except OSError:
        font = ImageFont.load_default()
        small = font
    draw.rectangle((35, 35, 1165, 665), outline="black", width=8)
    draw.text((90, 150), "ΣIRIUS VISION TEST", fill="black", font=font)
    draw.text((90, 310), "CODE OCR : NEMA 17", fill="navy", font=font)
    draw.text((90, 475), "JUILLET 2026", fill="darkred", font=small)
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=95)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# Vision endpoint validates empty/corrupt payloads and returns structured French multimodal output.
class TestSiriusVoyant:
    def test_analyze_readable_jpeg_returns_structured_ocr(self, authenticated_session):
        response = authenticated_session.post(
            f"{BASE_URL}/api/vision/analyze",
            json={"image": _jpeg_data_url(), "question": "Lis précisément cette affiche."},
            timeout=90,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data.get("type") == "vision"
        assert isinstance(data.get("description"), str) and data["description"].strip()
        assert isinstance(data.get("texte_extrait"), str)
        normalized_ocr = data["texte_extrait"].upper()
        assert "ΣIRIUS" in normalized_ocr
        assert "NEMA 17" in normalized_ocr
        assert isinstance(data.get("synthese"), str) and data["synthese"].strip()
        assert data.get("responseText") == data.get("synthese")
        sentence_parts = [part for part in re.split(r"[.!?]+", data["synthese"]) if part.strip()]
        assert len(sentence_parts) <= 3, data["synthese"]

    def test_empty_image_is_400_with_french_detail(self, authenticated_session):
        response = authenticated_session.post(
            f"{BASE_URL}/api/vision/analyze",
            json={"image": ""},
            timeout=30,
        )
        assert response.status_code == 400, response.text
        detail = response.json().get("detail", "")
        assert isinstance(detail, str) and "image" in detail.lower()

    def test_garbage_base64_is_controlled_client_or_upstream_error(self, authenticated_session):
        response = authenticated_session.post(
            f"{BASE_URL}/api/vision/analyze",
            json={"image": "data:image/jpeg;base64,%%%NOT-BASE64%%%"},
            timeout=90,
        )
        assert response.status_code in {400, 502}, response.text
        content_type = response.headers.get("content-type", "")
        assert "application/json" in content_type.lower(), (
            f"Expected French JSON detail, got status={response.status_code}, "
            f"content-type={content_type!r}, body={response.text[:300]!r}"
        )
        detail = response.json().get("detail", "")
        assert isinstance(detail, str) and detail.strip()
        assert "traceback" not in detail.lower()


# Vision phrasings and established UI commands must remain distinct from information questions.
class TestIntentRegression:
    @pytest.mark.parametrize(
        "text",
        [
            "regarde ce que je te montre",
            "jette un œil à ça",
            "dis-moi ce que tu vois",
        ],
    )
    def test_vision_phrasings(self, authenticated_session, text):
        _assert_intent(authenticated_session, text, "vision_look")

    @pytest.mark.parametrize(
        ("text", "action", "target"),
        [
            ("je veux voir la bourse", "open_module", "nummarius"),
            ("fais disparaître toutes les fenêtres", "minimize_all", None),
            ("tais-toi", "stop_reading", None),
            ("combien font 12 fois 8", "none", None),
        ],
    )
    def test_established_intents(self, authenticated_session, text, action, target):
        _assert_intent(authenticated_session, text, action, target)


# A concurrent command burst may degrade explicitly to unavailable, but never silently to none.
def test_intent_burst_never_silently_returns_none(authenticated_session):
    commands = [
        "ouvre le module bourse",
        "affiche mon agenda",
        "montre le module juridique",
        "ouvre l'oracle",
        "affiche la médiathèque",
        "montre le cortex",
        "ouvre le panthéon",
        "range toutes les fenêtres",
        "coupe la musique de fond",
        "active la musique d'ambiance",
        "ouvre les réglages",
        "jette un œil à ce que je montre",
    ]

    def invoke(command):
        response = authenticated_session.post(
            f"{BASE_URL}/api/intent",
            json={"text": command},
            timeout=30,
        )
        return command, response

    results = []
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = [pool.submit(invoke, command) for command in commands]
        for future in as_completed(futures):
            command, response = future.result()
            assert response.status_code == 200, f"{command!r}: {response.text}"
            data = response.json()
            assert isinstance(data, dict) and isinstance(data.get("action"), str)
            assert data["action"] != "none", f"UI command silently lost: {command!r} -> {data!r}"
            results.append(data["action"])
    assert len(results) == 12
    print(f"Burst actions: {results}")
    assert set(results) <= {
        "open_module", "close_module", "minimize_module", "minimize_all",
        "stop_reading", "stop_music", "play_music", "vision_look", "unavailable",
    }
