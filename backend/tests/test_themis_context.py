"""Contexte THÉMIS injecté dans le prompt de l'assistant."""
import asyncio
from datetime import date

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_docstore import LocalDocStore
from sirius_brain import build_system_prompt
from themis_context import themis_context, themis_prompt_section, wants_business_context


def run(coro):
    return asyncio.run(coro)


def _seed(store):
    run(store.themis_clients.insert_one({"id": "c1", "user_id": "u1", "name": "Karim Saint-Ambroise"}))
    run(store.themis_clients.insert_one({"id": "c2", "user_id": "u2", "name": "Client d'un autre compte"}))
    run(store.themis_docs.insert_one({
        "id": "d1", "user_id": "u1", "kind": "facture", "number": "FAC-2026-0002",
        "client_name": "Karim Saint-Ambroise", "total_ttc": 240.0, "paid": 40.0,
        "status": "envoyé", "due_date": "2026-09-30", "created_at": "2026-09-01",
    }))
    run(store.themis_docs.insert_one({
        "id": "d2", "user_id": "u1", "kind": "facture", "number": "FAC-2026-0001",
        "client_name": "Karim Saint-Ambroise", "total_ttc": 100.0, "paid": 100.0,
        "status": "payé", "created_at": "2026-08-01",
    }))
    run(store.themis_items.insert_one({"id": "i1", "user_id": "u1", "name": "Lait demi-écrémé", "stock": 3, "alert": 10}))
    run(store.themis_items.insert_one({"id": "i2", "user_id": "u1", "name": "Pâtes", "stock": 50, "alert": 10}))
    run(store.themis_payments.insert_one({"id": "p1", "user_id": "u1", "doc_id": "d2", "amount": 100.0}))


def test_context_summarizes_unpaid_invoices_and_low_stock(tmp_path):
    store = LocalDocStore(tmp_path / "docstore.db")
    _seed(store)

    context = run(themis_context(store, "u1", today=date(2026, 10, 15)))

    assert "FAC-2026-0002" in context and "reste 200,00 €" in context and "EN RETARD" in context
    assert "FAC-2026-0001" not in context
    assert "Lait demi-écrémé : 3 en stock" in context and "Pâtes" not in context
    assert "Encaissé : 100,00 €" in context
    assert "autre compte" not in context


def test_context_is_empty_without_data(tmp_path):
    store = LocalDocStore(tmp_path / "docstore.db")
    assert run(themis_context(store, "absent")) == ""
    assert themis_prompt_section("") == ""


def test_database_failure_is_not_reported_as_an_empty_account(tmp_path, monkeypatch, caplog):
    store = LocalDocStore(tmp_path / "failed.db")

    def unavailable(*args):
        raise OSError("lecture impossible")

    monkeypatch.setattr(store, "_scan", unavailable)
    context = run(themis_context(store, "u1"))
    assert "lecture a échoué" in context
    assert "aucune donnée" not in context and "0,00" not in context
    assert "themis_context indisponible" in caplog.text


def test_business_questions_are_detected():
    assert wants_business_context("Quelles factures sont impayées ?")
    assert wants_business_context("Qu'est-ce qui est en rupture de stock ?")
    assert wants_business_context("Comment booster mes ventes ?")
    assert not wants_business_context("Quel temps fait-il à Paris ?")
    assert wants_business_context("et la suivante ?", [{"role": "user", "content": "mes devis en cours"}])


def test_system_prompt_includes_themis_data():
    prompt = build_system_prompt(environment={"themis_context": "Factures non payées :\n- FAC-2026-0002"})
    assert "DONNÉES RÉELLES DE GESTION" in prompt and "FAC-2026-0002" in prompt
    assert "DONNÉES RÉELLES DE GESTION" not in build_system_prompt(environment={"timezone": "Europe/Paris"})


@pytest.fixture
def chat_api(tmp_path, monkeypatch):
    import server
    import sirius_brain

    store = LocalDocStore(tmp_path / "chat.db")
    _seed(store)
    seen = []

    async def user(request, db):
        return {"user_id": "u1"}

    async def memory(*args):
        return []

    async def answer(**kwargs):
        seen.append(kwargs)
        return {"reponse": "Réponse de validation.", "memoire": [], "popups": []}

    async def stream(**kwargs):
        seen.append(kwargs)
        yield "Réponse de validation."

    monkeypatch.setattr(server, "db", store)
    monkeypatch.setattr(server, "require_user", user)
    monkeypatch.setattr(server, "_rate_ok", lambda uid: True)
    monkeypatch.setattr(server, "_gather_memory_context", memory)
    monkeypatch.setattr(server, "should_extract_memory", lambda *args: False)
    monkeypatch.setattr(server, "ask_sirius", answer)
    monkeypatch.setattr(sirius_brain, "ask_sirius_stream", stream)
    monkeypatch.setattr(server.cloud_link, "should_relay_chat", lambda keys: False)
    app = FastAPI()
    app.include_router(server.api_router)
    return TestClient(app), store, seen


@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_chat_routes_inject_real_data_and_follow_up(chat_api, endpoint):
    client, store, seen = chat_api
    body = {"text": "Quelles factures sont impayées ?", "session_id": "themis-test",
            "keys": {"groq_key": "test-not-a-real-key"}}
    response = client.post(endpoint, json=body)
    assert response.status_code == 200
    assert "Réponse de validation." in response.text
    context = seen[-1]["environment"]["themis_context"]
    assert "FAC-2026-0002" in context and "reste 200,00 €" in context
    assert "autre compte" not in context

    # La réponse suivante doit relire la base, pas réutiliser des chiffres périmés.
    run(store.themis_docs.update_one({"id": "d1"}, {"$set": {"paid": 90.0}}))
    body["text"] = "Et combien reste-t-il pour celle-ci ?"
    response = client.post(endpoint, json=body)
    assert response.status_code == 200
    assert "reste 150,00 €" in seen[-1]["environment"]["themis_context"]


@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_empty_account_is_explicit_in_chat_context(chat_api, endpoint):
    client, store, seen = chat_api
    run(store.themis_docs.delete_many({"user_id": "u1"}))
    run(store.themis_clients.delete_many({"user_id": "u1"}))
    run(store.themis_items.delete_many({"user_id": "u1"}))
    run(store.themis_payments.delete_many({"user_id": "u1"}))
    response = client.post(endpoint, json={
        "text": "Mes factures impayées ?", "keys": {"groq_key": "test-not-a-real-key"},
    })
    assert response.status_code == 200
    assert "aucune donnée" in seen[-1]["environment"]["themis_context"]
