from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth_api import create_access_token
from google_calendar import make_gcal_router
from microsoft_graph import make_microsoft_router


class Result:
    deleted_count = 1


class Collection:
    def __init__(self):
        self.documents = []

    async def insert_one(self, document):
        self.documents.append(dict(document))

    async def find_one(self, query, *args, **kwargs):
        for document in self.documents:
            if all(document.get(key) == value for key, value in query.items()):
                return dict(document)
        return None

    async def delete_one(self, query):
        self.documents = [document for document in self.documents if not all(document.get(key) == value for key, value in query.items())]
        return Result()


class Database:
    def __init__(self):
        self.oauth_states = Collection()
        self.google_calendar = Collection()
        self.microsoft_oauth = Collection()
        self.users = Collection()
        self.users.documents.append({
            "user_id": "user-test",
            "email": "user@example.test",
            "name": "Test User",
            "role": "user",
            "provider": "email",
            "preferences": {},
        })


def client_for(router):
    app = FastAPI()
    app.include_router(router, prefix="/api")
    return TestClient(app)


def auth_headers():
    token = create_access_token("user-test", "user@example.test")
    return {"Authorization": f"Bearer {token}"}


def test_google_external_authorization_is_user_bound(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "google-client")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "google-secret")
    monkeypatch.setenv("GOOGLE_REDIRECT_URI", "https://api.example.test/api/oauth/calendar/callback")
    database = Database()
    client = client_for(make_gcal_router(database))

    response = client.get("/api/oauth/calendar/login?external=true", headers=auth_headers())

    assert response.status_code == 200
    assert response.json()["authorization_url"].startswith("https://accounts.google.com/")
    assert database.oauth_states.documents[0]["uid"] == "user-test"
    assert database.oauth_states.documents[0]["external"] is True


def test_microsoft_authorization_returns_external_url(monkeypatch):
    monkeypatch.setenv("MICROSOFT_CLIENT_ID", "microsoft-client")
    monkeypatch.setenv("MICROSOFT_CLIENT_SECRET", "microsoft-secret")
    monkeypatch.setenv("MICROSOFT_REDIRECT_URI", "https://api.example.test/api/auth/callback/microsoft-entra-id")
    database = Database()
    client = client_for(make_microsoft_router(database))

    response = client.get("/api/auth/microsoft/authorize", headers=auth_headers())

    assert response.status_code == 200
    assert response.json()["authorization_url"].startswith("https://login.microsoftonline.com/")
    assert database.oauth_states.documents[0]["uid"] == "user-test"
    assert database.oauth_states.documents[0]["code_verifier"]


def test_google_disconnect_removes_current_users_tokens():
    database = Database()
    database.google_calendar.documents.append({"_id": "user-test", "tokens": {"access_token": "secret"}})
    client = client_for(make_gcal_router(database))

    response = client.post("/api/calendar/disconnect", headers=auth_headers())

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert database.google_calendar.documents == []
