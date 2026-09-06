from fastapi.testclient import TestClient

import server


def authenticated_client():
    client = TestClient(server.app)
    response = client.post("/api/auth/local-session")
    assert response.status_code == 200
    return client


def test_omega_skills_registry_exposes_twelve_active_skills():
    response = authenticated_client().get("/api/omega/skills")

    assert response.status_code == 200
    assert response.json()["state"] == "active"
    assert len(response.json()["skills"]) == 12


def test_self_patch_and_reload_are_disabled_by_default(monkeypatch):
    monkeypatch.setattr(server, "SELF_PATCH_ENABLED", False)
    client = authenticated_client()

    patch = client.post(
        "/api/self/patch",
        headers={"x-admin-token": "anything"},
        json={"file_path": "server.py", "content": "x = 1"},
    )
    reload_response = client.post(
        "/api/self/reload",
        headers={"x-admin-token": "anything"},
    )

    assert patch.status_code == 503
    assert reload_response.status_code == 503


def test_self_patch_rejects_invalid_token_and_path_traversal(monkeypatch):
    monkeypatch.setattr(server, "SELF_PATCH_ENABLED", True)
    monkeypatch.setattr(server, "ADMIN_TOKEN", "configured-secret")
    client = authenticated_client()

    invalid_token = client.post(
        "/api/self/patch",
        headers={"x-admin-token": "wrong"},
        json={"file_path": "server.py", "content": "x = 1"},
    )
    traversal = client.post(
        "/api/self/patch",
        headers={"x-admin-token": "configured-secret"},
        json={"file_path": "../server.py", "content": "x = 1"},
    )

    assert invalid_token.status_code == 403
    assert traversal.status_code == 403


def test_self_patch_validates_python_before_writing(monkeypatch):
    monkeypatch.setattr(server, "SELF_PATCH_ENABLED", True)
    monkeypatch.setattr(server, "ADMIN_TOKEN", "configured-secret")
    client = authenticated_client()

    response = client.post(
        "/api/self/patch",
        headers={"x-admin-token": "configured-secret"},
        json={"file_path": "server.py", "content": "def broken("},
    )

    assert response.status_code == 400


def test_runtime_reports_cannot_be_cleared_without_admin_token(monkeypatch):
    monkeypatch.setattr(server, "ADMIN_TOKEN", "configured-secret")
    client = authenticated_client()

    denied = client.post(
        "/api/argus/fix",
        json={"fixId": "clear_runtime_reports", "confirmed": True},
    )
    allowed = client.post(
        "/api/argus/fix",
        headers={"x-admin-token": "configured-secret"},
        json={"fixId": "clear_runtime_reports", "confirmed": True},
    )

    assert denied.status_code == 403
    assert allowed.status_code == 200
    assert allowed.json()["ok"] is True


def test_self_patch_can_be_rolled_back_atomically(tmp_path, monkeypatch):
    target = tmp_path / "server.py"
    target.write_text("value = 'original'\n", encoding="utf-8")
    monkeypatch.setattr(server, "ROOT_DIR", tmp_path)
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(server, "ALLOWED_FILES", {"server.py": target})
    monkeypatch.setattr(server, "SELF_PATCH_ENABLED", True)
    monkeypatch.setattr(server, "ADMIN_TOKEN", "configured-secret")
    client = authenticated_client()

    patched = client.post(
        "/api/self/patch",
        headers={"x-admin-token": "configured-secret"},
        json={"file_path": "server.py", "content": "value = 'patched'\n"},
    )

    assert patched.status_code == 200
    assert target.read_text(encoding="utf-8") == "value = 'patched'\n"

    rolled_back = client.post(
        "/api/self/rollback",
        headers={"x-admin-token": "configured-secret"},
        json={"backup": patched.json()["backup"]},
    )

    assert rolled_back.status_code == 200
    assert rolled_back.json()["status"] == "rolled_back"
    assert rolled_back.json()["frozen_paths"] == []
    assert target.read_text(encoding="utf-8") == "value = 'original'\n"


def test_patch_and_reload_scan_for_new_drift_before_acting(monkeypatch):
    class FrozenOmega:
        def scan(self):
            return {"engine": {"frozen": True}}

    monkeypatch.setattr(server, "omega", FrozenOmega())
    monkeypatch.setattr(server, "SELF_PATCH_ENABLED", True)
    monkeypatch.setattr(server, "ADMIN_TOKEN", "configured-secret")
    client = authenticated_client()

    patch = client.post(
        "/api/self/patch",
        headers={"x-admin-token": "configured-secret"},
        json={"file_path": "server.py", "content": "x = 1"},
    )
    reload_response = client.post(
        "/api/self/reload",
        headers={"x-admin-token": "configured-secret"},
    )

    assert patch.status_code == 409
    assert reload_response.status_code == 409


def test_automatic_reload_remains_disabled_when_patch_mode_is_enabled(monkeypatch):
    monkeypatch.setattr(server, "SELF_PATCH_ENABLED", True)
    monkeypatch.setattr(server, "ADMIN_TOKEN", "configured-secret")
    client = authenticated_client()

    response = client.post(
        "/api/self/reload",
        headers={"x-admin-token": "configured-secret"},
    )

    assert response.status_code == 409
    assert "manuellement" in response.json()["detail"]
