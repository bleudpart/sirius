"""Contexte THÉMIS injecté dans le prompt de l'assistant."""
import asyncio
from datetime import date

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
