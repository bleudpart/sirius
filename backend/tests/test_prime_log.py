from fastapi import FastAPI
from fastapi.testclient import TestClient

import routes.memory_routes as memory_routes


def _client(monkeypatch, logged):
    monkeypatch.setattr(memory_routes, "log_event", lambda text, intent, user_id: logged.append((text, intent, user_id)))

    async def resolve_user_id(request, db):
        return "u1"

    app = FastAPI()
    app.include_router(memory_routes.make_memory_router(None, None, resolve_user_id), prefix="/api")
    return TestClient(app)


def test_prime_log_accepte_une_intention_nulle(monkeypatch):
    logged = []
    response = _client(monkeypatch, logged).post("/api/prime/log", json={"text": "quelle heure est-il", "intent": None})
    assert response.status_code == 200
    assert logged == [("quelle heure est-il", "", "u1")]


def test_prime_log_conserve_l_intention(monkeypatch):
    logged = []
    _client(monkeypatch, logged).post("/api/prime/log", json={"text": "météo", "intent": "météo"})
    assert logged == [("météo", "météo", "u1")]
