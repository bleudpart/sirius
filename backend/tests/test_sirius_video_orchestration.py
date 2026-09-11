# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Unit tests for autonomous ΣIRIUS video orchestration."""

import asyncio
import sys
from types import SimpleNamespace

import server
from sirius_brain import detect_autonomous_action, technical_video_comment


def test_video_generation_request_routes_to_the_internal_pipeline():
    action = detect_autonomous_action("Génère-moi un clip vidéo cinématique de Sirius dans une ville futuriste.")

    assert action == {
        "type": "video_generation",
        "prompt": "Génère-moi un clip vidéo cinématique de Sirius dans une ville futuriste.",
        "modules": ["analyse", "generation", "fal.ai", "HUD"],
        "technical_comment": "Analyse de la demande. Module vidéo requis.",
        "display": {"type": "video", "mode": "file"},
    }


def test_existing_video_is_not_mistaken_for_a_generation_request():
    assert detect_autonomous_action("Affiche la vidéo de démonstration archivée.") is None


def test_video_technical_comments_are_short_and_non_payload_bearing():
    for stage in ("detection", "activation", "materialization", "display"):
        comment = technical_video_comment(stage)
        assert comment
        assert "base64" not in comment.lower()


def test_completed_video_is_materialized_as_a_local_file(monkeypatch, tmp_path):
    video_bytes = b"\x00\x00\x00\x18ftypmp42SIRIUS-video-test"

    class FakeHttpError(Exception):
        pass

    class FakeResponse:
        headers = {
            "content-type": "video/mp4",
            "content-length": str(len(video_bytes)),
        }

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        def raise_for_status(self):
            return None

        async def aiter_bytes(self):
            yield video_bytes[:8]
            yield video_bytes[8:]

    class FakeClient:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        def stream(self, method, url):
            assert method == "GET"
            assert url == "https://fal.example/video.mp4"
            return FakeResponse()

    monkeypatch.setattr(server, "_VIDEO_OUTPUT_DIR", tmp_path)
    monkeypatch.setitem(
        sys.modules,
        "httpx",
        SimpleNamespace(AsyncClient=FakeClient, HTTPError=FakeHttpError),
    )

    artifact = asyncio.run(server._materialize_video_result("https://fal.example/video.mp4"))
    output_path = tmp_path / artifact["filename"]

    assert artifact["mime"] == "video/mp4"
    assert output_path.suffix == ".mp4"
    assert output_path.read_bytes() == video_bytes
    assert "base64" not in artifact
