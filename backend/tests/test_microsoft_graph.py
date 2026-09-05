import pytest
from fastapi import HTTPException

import microsoft_graph


def test_conf_allows_pkce_public_client(monkeypatch):
    monkeypatch.setenv("MICROSOFT_CLIENT_ID", "client-id")
    monkeypatch.setenv("MICROSOFT_CLIENT_SECRET", "******")
    monkeypatch.setenv(
        "MICROSOFT_REDIRECT_URI",
        "http://127.0.0.1:8001/api/auth/callback/microsoft-entra-id",
    )

    assert microsoft_graph._conf() == (
        "client-id",
        "",
        "http://127.0.0.1:8001/api/auth/callback/microsoft-entra-id",
    )


def test_conf_requires_client_id_and_redirect(monkeypatch):
    monkeypatch.delenv("MICROSOFT_CLIENT_ID", raising=False)
    monkeypatch.delenv("MICROSOFT_REDIRECT_URI", raising=False)

    with pytest.raises(HTTPException) as raised:
        microsoft_graph._conf()

    assert raised.value.status_code == 503


def test_token_request_only_includes_real_secret():
    public_data = microsoft_graph._token_request_data(
        "client-id", "", grant_type="authorization_code"
    )
    confidential_data = microsoft_graph._token_request_data(
        "client-id", "secret", grant_type="authorization_code"
    )

    assert "client_secret" not in public_data
    assert confidential_data["client_secret"] == "secret"


def test_login_from_local_machine_redirects_without_a_session(monkeypatch):
    """La fenêtre de connexion Microsoft est ouverte via window.open() dans un nouvel onglet,
    qui navigue directement vers l'API sans cookie de session ni en-tête Authorization (page
    localhost:3000 -> API 127.0.0.1:8001 = cross-site). Sur la machine locale de confiance,
    la connexion doit malgré tout rediriger vers Microsoft plutôt que de renvoyer 401."""
    from fastapi.testclient import TestClient
    import server

    monkeypatch.setenv("MICROSOFT_CLIENT_ID", "client-id")
    monkeypatch.setenv("MICROSOFT_CLIENT_SECRET", "******")
    monkeypatch.setenv(
        "MICROSOFT_REDIRECT_URI",
        "http://127.0.0.1:8001/api/auth/callback/microsoft-entra-id",
    )

    client = TestClient(server.app)
    response = client.get("/api/auth/microsoft/login", follow_redirects=False)

    assert response.status_code == 302
    assert response.headers["location"].startswith(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"
    )
