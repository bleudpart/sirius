from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import local_memory
from auth_api import LEGACY_UID, create_access_token
from media_archive import MediaArchive
from media_intent import parse_media_intent
from media_proxy import MediaProxy
from media_routes import MediaSessionManager, make_media_router
from providers.base import MediaProviderError


@pytest.fixture
def media_client(tmp_path):
    archive = MediaArchive(tmp_path / "media-test.db")
    manager = MediaSessionManager(proxy=MediaProxy(), archive=archive)
    app = FastAPI()
    app.include_router(make_media_router(db=None, manager=manager))
    client = TestClient(app)
    client.cookies.set("access_token", create_access_token(LEGACY_UID, LEGACY_UID))
    return client


def test_media_proxy_resolves_official_youtube_embed():
    descriptor = MediaProxy().resolve(
        "youtube",
        url="https://youtu.be/dQw4w9WgXcQ",
    )

    assert descriptor.embeddable is True
    assert descriptor.controllable is True
    assert descriptor.external_url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert descriptor.embed_url == "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1"


def test_media_proxy_rejects_non_official_or_non_https_urls():
    with pytest.raises(MediaProviderError):
        MediaProxy().resolve("youtube", url="http://youtube.com/watch?v=dQw4w9WgXcQ")

    with pytest.raises(MediaProviderError):
        MediaProxy().resolve("youtube", url="https://example.com/watch?v=dQw4w9WgXcQ")


def test_media_intent_selects_provider_and_control():
    intent = parse_media_intent("Sirius mets une musique lofi sur Spotify")

    assert intent["action"] == "media_control"
    assert intent["media"] == {
        "provider": "spotify",
        "command": "play",
        "query": "musique lofi",
    }


def test_media_routes_archive_and_oracle(media_client):
    resolved = media_client.post(
        "/media/resolve",
        json={"provider": "youtube", "url": "https://youtu.be/dQw4w9WgXcQ"},
    )
    assert resolved.status_code == 200
    assert resolved.json()["state"]["controllable"] is True

    controlled = media_client.post("/media/control", json={"action": "play"})
    assert controlled.status_code == 200
    assert controlled.json()["state"]["status"] == "playing"

    toggled = media_client.post("/media/control", json={"action": "toggle"})
    assert toggled.status_code == 200
    assert toggled.json()["state"]["status"] == "paused"

    archive = media_client.get("/media/archive")
    assert archive.status_code == 200
    assert [event["action"] for event in archive.json()["events"][:3]] == ["toggle", "play", "resolve"]

    oracle = media_client.get("/media/oracle")
    assert oracle.status_code == 200
    assert oracle.json()["status"] == "paused"
    assert oracle.json()["provider"] == "youtube"


def test_media_websocket_acknowledges_control(media_client):
    resolved = media_client.post(
        "/media/resolve",
        json={"provider": "spotify", "url": "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"},
    )
    assert resolved.status_code == 200

    with media_client.websocket_connect("/media/ws") as websocket:
        initial = websocket.receive_json()
        assert initial["type"] == "media_state"
        assert initial["state"]["provider"] == "spotify"

        websocket.send_json(
            {
                "type": "media_control",
                "request_id": "pause-test",
                "control": {"action": "pause"},
            }
        )
        messages = [websocket.receive_json(), websocket.receive_json()]

    acknowledgement = next(message for message in messages if message["type"] == "media_ack")
    assert acknowledgement["request_id"] == "pause-test"
    assert acknowledgement["state"]["status"] == "paused"


def test_media_websocket_heartbeat(media_client):
    with media_client.websocket_connect("/media/ws") as websocket:
        websocket.receive_json()
        websocket.send_json({"type": "ping", "request_id": "heartbeat-test"})
        pong = websocket.receive_json()

    assert pong == {"type": "media_pong", "request_id": "heartbeat-test"}


def test_media_routes_reject_control_for_external_player(media_client):
    resolved = media_client.post(
        "/media/resolve",
        json={"provider": "deezer", "url": "https://www.deezer.com/track/3135556"},
    )
    assert resolved.status_code == 200
    assert resolved.json()["state"]["embeddable"] is True
    assert resolved.json()["state"]["controllable"] is False

    controlled = media_client.post("/media/control", json={"action": "play"})

    assert controlled.status_code == 409
    assert "controles officiels" in controlled.json()["detail"]


def test_user_deletion_removes_media_archive(tmp_path, monkeypatch):
    database = tmp_path / "sirius-local-test.db"
    monkeypatch.setattr(local_memory, "DB_PATH", database)
    local_memory.init_local_db()
    archive = MediaArchive(database)
    archive.record(
        "media-user",
        "resolve",
        {
            "provider": "youtube",
            "status": "ready",
            "title": "Video",
            "query": "",
            "external_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
    )

    local_memory.delete_user_data("media-user")

    assert archive.list("media-user") == []
