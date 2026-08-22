"""Contrat du registre et de la route des modules multimedia."""

import asyncio
import sys
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from media.media_registry import list_media_modules
from routes.media_modules import get_media_modules


EXPECTED_PROVIDER_IDS = ("youtube", "netflix", "spotify", "deezer", "twitch", "tiktok")


def test_media_registry_exposes_the_six_supported_providers():
    modules = list_media_modules()

    assert tuple(module["id"] for module in modules) == EXPECTED_PROVIDER_IDS
    assert all(module["available"] is True for module in modules)
    assert all(module["launch_mode"] == "external" for module in modules)
    assert all(module["url"].startswith("https://") for module in modules)
    assert {module["media_type"] for module in modules} == {"audio", "video"}


def test_media_modules_endpoint_returns_registry_payload():
    payload = asyncio.run(get_media_modules())

    assert payload == {"modules": list_media_modules()}
