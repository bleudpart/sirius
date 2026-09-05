import pytest
from fastapi import HTTPException

import microsoft_graph


class _FakeCollection:
    """Mini-remplaçant en mémoire d'une collection Motor, pour tester le routeur Microsoft
    sans dépendre du client Mongo global de server.py (qui, lié à une boucle asyncio précise,
    casse dès qu'un autre test ferme la sienne — limitation connue de Motor sous Windows)."""

    def __init__(self):
        self._docs = []

    def _match(self, doc, query):
        return all(doc.get(k) == v for k, v in query.items())

    async def insert_one(self, doc):
        self._docs.append(dict(doc))

    async def find_one(self, query):
        for doc in self._docs:
            if self._match(doc, query):
                return dict(doc)
        return None

    async def find_one_and_delete(self, query):
        for i, doc in enumerate(self._docs):
            if self._match(doc, query):
                return self._docs.pop(i)
        return None

    async def update_one(self, query, update, upsert=False):
        for doc in self._docs:
            if self._match(doc, query):
                doc.update(update.get("$set", {}))
                return
        if upsert:
            new_doc = {**query, **update.get("$set", {})}
            self._docs.append(new_doc)

    async def delete_one(self, query):
        for i, doc in enumerate(self._docs):
            if self._match(doc, query):
                self._docs.pop(i)
                return


class _FakeDB:
    def __init__(self):
        self.oauth_states = _FakeCollection()
        self.users = _FakeCollection()
        self.microsoft_oauth = _FakeCollection()


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
    import asyncio
    from starlette.requests import Request

    monkeypatch.setenv("MICROSOFT_CLIENT_ID", "client-id")
    monkeypatch.setenv("MICROSOFT_CLIENT_SECRET", "******")
    monkeypatch.setenv(
        "MICROSOFT_REDIRECT_URI",
        "http://127.0.0.1:8001/api/auth/callback/microsoft-entra-id",
    )

    # On appelle directement la fonction du routeur (plutôt que via TestClient/ASGI), avec une
    # fausse base en mémoire : le test reste ainsi indépendant du client Motor global de
    # server.py, dont la liaison à une boucle asyncio précise casse dès qu'un autre test ferme
    # la sienne (limitation connue de Motor sous Windows avec plusieurs boucles par process).
    async def _run():
        router = microsoft_graph.make_microsoft_router(_FakeDB())
        login = {route.path: route.endpoint for route in router.routes}["/auth/microsoft/login"]
        scope = {
            "type": "http", "method": "GET", "path": "/api/auth/microsoft/login",
            "headers": [], "client": ("127.0.0.1", 51234), "server": ("testserver", 80),
            "scheme": "http", "query_string": b"",
        }
        return await login(Request(scope))

    response = asyncio.run(_run())

    assert response.status_code == 302
    assert response.headers["location"].startswith(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"
    )


def test_callback_links_local_login_to_legacy_user_and_notifies_opener(monkeypatch):
    """Le /login de secours (machine locale, sans session) enregistre l'état OAuth sous
    LEGACY_UID. Le callback doit rattacher le compte Microsoft à ce MÊME identifiant — sinon
    /api/microsoft/mail (qui résout l'utilisateur via le Bearer token du SPA, donc LEGACY_UID)
    ne retrouverait jamais le jeton et répondrait toujours "Compte Microsoft non connecté".

    Le callback doit renvoyer une page qui prévient la fenêtre d'origine (postMessage vers
    FRONTEND_URL) puis se ferme, PAS une redirection classique : connectOutlook() ouvre la
    connexion dans une popup (window.open), et une redirection vers FRONTEND_URL ferait
    démarrer une deuxième instance complète du SPA dans cette popup au lieu de simplement
    revenir à l'onglet original déjà ouvert ("un nouveau SIRIUS qui démarre")."""
    import asyncio
    from urllib.parse import urlparse, parse_qs
    from fastapi import Response as FastAPIResponse
    from starlette.requests import Request
    from cryptography.fernet import Fernet
    from auth_api import LEGACY_UID

    monkeypatch.setenv("MICROSOFT_CLIENT_ID", "client-id")
    monkeypatch.setenv("MICROSOFT_CLIENT_SECRET", "")
    monkeypatch.setenv(
        "MICROSOFT_REDIRECT_URI",
        "http://localhost:8001/api/auth/callback/microsoft-entra-id",
    )
    monkeypatch.setenv("MS_TOKEN_KEY", Fernet.generate_key().decode())
    monkeypatch.setattr(microsoft_graph, "FRONTEND_URL", "http://localhost:3000")

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload
            self.is_error = False

        def json(self):
            return self._payload

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, _url, data=None):
            return FakeResponse({"access_token": "fake-access-token", "expires_in": 3600})

        async def get(self, _url, headers=None, params=None):
            return FakeResponse({
                "id": "ms-object-id-123",
                "mail": "daniel.test@example.com",
                "displayName": "Daniel",
            })

    monkeypatch.setattr(microsoft_graph.httpx, "AsyncClient", lambda timeout=None: FakeClient())

    def _fake_request() -> Request:
        # requête minimale simulant une navigation directe depuis la machine locale
        # (127.0.0.1, sans en-tête Authorization ni cookie de session).
        scope = {
            "type": "http", "method": "GET", "path": "/api/auth/microsoft/login",
            "headers": [], "client": ("127.0.0.1", 51234), "server": ("testserver", 80),
            "scheme": "http", "query_string": b"",
        }
        return Request(scope)

    async def _run():
        db = _FakeDB()
        router = microsoft_graph.make_microsoft_router(db)
        endpoints = {route.path: route.endpoint for route in router.routes}

        login_resp = await endpoints["/auth/microsoft/login"](_fake_request())
        assert login_resp.status_code == 302
        state = parse_qs(urlparse(login_resp.headers["location"]).query)["state"][0]

        callback_resp = await endpoints["/auth/callback/microsoft-entra-id"](
            FastAPIResponse(), code="fake-code", state=state, error="",
        )
        assert callback_resp.status_code == 200
        assert "location" not in callback_resp.headers  # pas de redirection : page popup
        body = callback_resp.body.decode()
        assert "window.opener" in body and "postMessage" in body
        assert "window.close()" in body
        assert '"http://localhost:3000"' in body  # targetOrigin = le SPA, jamais l'API
        assert '"type": "microsoft-auth"' in body or '"type":"microsoft-auth"' in body
        assert '"ok": true' in body or '"ok":true' in body

        doc = await db.microsoft_oauth.find_one({"_id": LEGACY_UID})
        assert doc is not None, "le jeton Microsoft doit être enregistré sous LEGACY_UID"
        user = await db.users.find_one({"user_id": LEGACY_UID})
        assert user is not None
        assert user["microsoft_id"] == "ms-object-id-123"

    asyncio.run(_run())
