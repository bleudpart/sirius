import os
import re

from fastapi.testclient import TestClient

import desktop_backend
import runtime_paths
import server


def test_desktop_runtime_creates_and_reuses_auth_secret(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("SIRIUS_AUTH_SECRET", raising=False)

    desktop_backend._prepare_runtime()
    first_secret = os.environ["SIRIUS_AUTH_SECRET"]
    monkeypatch.delenv("SIRIUS_AUTH_SECRET")
    desktop_backend._prepare_runtime()

    assert first_secret
    assert os.environ["SIRIUS_AUTH_SECRET"] == first_secret
    assert (tmp_path / "auth-secret").read_text(encoding="ascii") == first_secret


def test_runtime_data_dir_honors_desktop_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))

    assert runtime_paths.data_file("state.db") == tmp_path / "state.db"


def test_health_identifies_sirius_backend():
    response = TestClient(server.app).get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["service"] == "sirius-backend"
    assert body["status"] in {"ok", "degraded"}
    assert "checks" in body and "mongo" in body["checks"]
    assert "keys" in body


def test_packaged_frontend_javascript_is_served_from_static_route():
    client = TestClient(server.app)
    index = client.get("/")
    script_match = re.search(r'src="\.?(/static/js/[^"]+\.js)"', index.text)

    assert index.status_code == 200
    assert script_match
    script = client.get(script_match.group(1))
    assert script.status_code == 200
    assert "javascript" in script.headers["content-type"]
    assert len(script.content) > 100_000


def test_cleanup_stale_sirius_backends_kills_old_processes(monkeypatch):
    killed = []

    monkeypatch.setattr(
        desktop_backend,
        "_windows_sirius_processes",
        lambda: [111, 222],
    )
    monkeypatch.setattr(desktop_backend.os, "getpid", lambda: 222)
    monkeypatch.setattr(
        desktop_backend,
        "_send_terminate",
        lambda pid: killed.append(pid),
    )
    monkeypatch.setattr(
        desktop_backend,
        "_windows_port_owner_pid",
        lambda host, port: None,
    )

    desktop_backend._cleanup_stale_sirius_processes()

    assert killed == [111]


def test_cleanup_stale_sirius_backends_kills_port_owner_even_when_name_is_unknown(monkeypatch):
    killed = []

    monkeypatch.setattr(
        desktop_backend,
        "_windows_sirius_processes",
        lambda: [],
    )
    monkeypatch.setattr(desktop_backend.os, "getpid", lambda: 999)
    monkeypatch.setattr(
        desktop_backend,
        "_windows_port_owner_pid",
        lambda host, port: 333,
    )
    monkeypatch.setattr(
        desktop_backend,
        "_send_terminate",
        lambda pid: killed.append(pid),
    )

    desktop_backend._cleanup_stale_sirius_processes(host="127.0.0.1", port=8001)

    assert killed == [333]
