from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from test_work_conversation import ask, harness, run
from work_conversation import normalized
from work_invoice_batch import batch_days, batch_report


COMMAND = "Prépare les relances de mes factures en retard de plus de 15 jours"
PATH = "/api/work-dossiers/invoice-followups/preview"


def seed(db, source_id, *, days=16, uid="u1", email="client@example.test", **values):
    today = datetime.now(timezone.utc).astimezone(ZoneInfo("Europe/Paris")).date()
    run(db.themis_clients.insert_one({
        "id": source_id, "user_id": uid, "email": email,
    }))
    run(db.themis_docs.insert_one({
        "id": source_id, "user_id": uid, "kind": "facture", "client_id": source_id,
        "client_name": "Client test", "number": f"FAC-{source_id}", "total_ttc": 120,
        "paid": 20, "due_date": (today - timedelta(days=days)).isoformat(),
        "status": "envoyé", **values,
    }))


@pytest.mark.parametrize("text,expected", [
    (COMMAND, 15),
    ("Prépare les relances des factures en retard de plus de quinze jours.", 15),
    ("Préparer toutes les relances de toutes les factures ayant plus de 30 jours de retard", 30),
    ("Prépare les relances de mes factures en retard de plus de 0 jours", 0),
    (COMMAND + " sauf le client Martin", None),
    (COMMAND + " du dossier Martin", None),
    (COMMAND + " et envoie-les", None),
    (COMMAND.replace("15", "-1"), None),
    (COMMAND.replace("15", "9999"), None),
    (COMMAND.replace("plus de", "au moins"), None),
])
def test_batch_grammar_never_drops_an_extra_condition(text, expected):
    assert batch_days(normalized(text)) == expected


@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_exact_threshold_and_partial_results_with_no_business_writes(harness, endpoint):
    chat, work, db, _ = harness
    seed(db, "ready")
    seed(db, "missing-email", email="")
    seed(db, "exactly-15", days=15)
    seed(db, "not-due", days=-2)
    seed(db, "paid", paid=120)
    seed(db, "refused", status="refusé")
    seed(db, "bad-date", due_date="impossible")
    seed(db, "bad-total", total_ttc=None)
    seed(db, "other-secret", uid="u2")
    before = run(db.themis_docs.find({}).to_list(100))
    result = ask(chat, COMMAND, endpoint=endpoint)
    batch = result["work_batch"]
    assert result["work_state"] == "PREPARED"
    assert batch["counts"] == {"prepared": 1, "blocked": 3, "skipped": 4}
    assert batch["examined"] == 8
    assert batch["comparison"] == "strictly_greater"
    assert batch["scope"] == "own_account"
    assert batch["truncated"] is False
    assert result["persisted"] is False and result["executed"] is False
    assert "other-secret" not in str(result)
    assert "compte entier" in result["answer"]
    assert "1 texte(s) préparé(s)" in result["answer"]
    assert "Aucun message envoyé" in result["answer"]
    by_id = {item["source"]["id"]: item for item in batch["items"]}
    assert by_id["ready"]["content"]["remaining"] == 100
    assert by_id["missing-email"]["state"] == "blocked"
    assert by_id["exactly-15"]["state"] == "skipped"
    assert by_id["ready"]["fingerprint"]
    assert run(db.themis_docs.find({}).to_list(100)) == before
    assert run(db.sirius_work_entries.count_documents({})) == 0
    assert run(db.sirius_work_dossiers.count_documents({})) == 0
    direct = work.post(PATH, headers={"x-test-user": "u1"}, json={})
    assert direct.status_code == 200
    assert direct.json()["items"] == batch["items"]
    reply = ask(chat, "Oui, je confirme !")
    assert reply["work_state"] == "NOT_EXECUTED"
    assert "Aucun message envoyé" in reply["answer"]
    # The batch's session marker must not be mistaken for a dossier selection.
    assert ask(chat, "Résume ce dossier")["work_state"] == "NEEDS_CLARIFICATION"


def test_empty_and_blocked_batches_are_not_reported_as_completed_work(harness):
    chat, _, db, _ = harness
    empty = ask(chat, COMMAND)
    assert empty["work_state"] == "READ_ONLY"
    assert empty["work_batch"]["items"] == []
    seed(db, "missing", email="")
    result = ask(chat, COMMAND)
    assert result["work_state"] == "READ_ONLY"
    assert result["work_batch"]["counts"] == {"prepared": 0, "blocked": 1, "skipped": 0}
    assert "Destinataire manquant" in result["answer"]


def test_batch_does_not_silently_apply_a_dossier_or_client_filter(harness):
    chat, _, db, _ = harness
    seed(db, "one")
    for suffix in (" du dossier Martin", " sauf le client Dupont", " et envoie les messages"):
        result = ask(chat, COMMAND + suffix)
        assert result["work_state"] == "NEEDS_CLARIFICATION"
        assert "work_batch" not in result
    result = ask(chat, COMMAND, environment={"work_dossier_id": "unknown"})
    assert result["work_batch"]["scope"] == "own_account"
    assert "pas uniquement sur le dossier affiché" in result["answer"]


def test_batch_bounds_and_deduplicates_with_explicit_truncation(harness):
    chat, _, db, _ = harness
    for index in range(101):
        seed(db, f"{index:03}")
    # A duplicate reference blocks both copies rather than choosing an arbitrary invoice.
    run(db.themis_docs.insert_one({
        "id": "000", "user_id": "u1", "kind": "facture", "number": "DUPLICATE",
    }))
    result = ask(chat, COMMAND)
    batch = result["work_batch"]
    assert batch["examined"] == 100
    assert batch["limit"] == 100 and batch["truncated"] is True
    assert batch["counts"] == {"prepared": 98, "blocked": 1, "skipped": 0}
    assert len({item["source"]["id"] for item in batch["items"]}) == 99
    assert batch["items"][0]["state"] == "blocked"
    assert "dupliquée" in batch["items"][0]["reason"]
    assert "Lecture partielle" in result["answer"]
    assert "dix premières" in result["answer"]
    assert run(db.sirius_work_entries.count_documents({})) == 0


@pytest.mark.parametrize("body", [
    {"minimum_overdue_days": -1}, {"minimum_overdue_days": True},
    {"minimum_overdue_days": 1.5}, {"minimum_overdue_days": 3651},
    {"timezone": "Invalid/Timezone"}, {"timezone": "/bad"},
    {"unknown": "field"},
])
def test_batch_api_rejects_invalid_filters(harness, body):
    _, work, _, _ = harness
    assert work.post(PATH, headers={"x-test-user": "u1"}, json=body).status_code == 422


def test_batch_api_is_authenticated_and_reauthorizes_each_invoice(harness):
    _, work, db, _ = harness
    seed(db, "owned")
    seed(db, "foreign", uid="u2")
    assert work.post(PATH, json={}).status_code == 401
    result = work.post(PATH, headers={"x-test-user": "u1"}, json={}).json()
    assert [item["source"]["id"] for item in result["items"]] == ["owned"]
    run(db.themis_docs.update_one({"id": "owned"}, {"$set": {"user_id": "u2"}}))
    assert work.post(PATH, headers={"x-test-user": "u1"}, json={}).json()["items"] == []


def test_batch_report_never_claims_sent_even_when_all_prepared(harness):
    _, work, db, _ = harness
    seed(db, "owned")
    batch = work.post(PATH, headers={"x-test-user": "u1"}, json={}).json()
    text = batch_report(batch)
    assert "Préparé ne signifie pas prêt à envoyer" in text
    assert "Brouillons temporaires non enregistrés" in text


def test_batch_uses_requested_timezone_at_midnight_boundary(harness, monkeypatch):
    from routes import work_dossiers

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 4, 20, 23, 30, tzinfo=timezone.utc).astimezone(tz)

    monkeypatch.setattr(work_dossiers, "datetime", Clock)
    _, work, db, _ = harness
    seed(db, "boundary", due_date="2026-04-05")
    utc = work.post(PATH, headers={"x-test-user": "u1"}, json={"timezone": "UTC"}).json()
    paris = work.post(PATH, headers={"x-test-user": "u1"}, json={"timezone": "Europe/Paris"}).json()
    assert utc["on"] == "2026-04-20"
    assert utc["counts"]["skipped"] == 1
    assert paris["on"] == "2026-04-21"
    assert paris["counts"]["prepared"] == 1


@pytest.mark.parametrize("field,value", [
    ("total_ttc", True), ("total_ttc", "NaN"), ("total_ttc", -1),
    ("paid", False), ("paid", "Infinity"), ("paid", -1),
    ("due_date", None), ("due_date", "2026-13-40"),
])
def test_invalid_source_values_block_instead_of_inventing_an_eligibility(harness, field, value):
    _, work, db, _ = harness
    seed(db, "invalid", **{field: value})
    batch = work.post(PATH, headers={"x-test-user": "u1"}, json={}).json()
    assert batch["counts"] == {"prepared": 0, "blocked": 1, "skipped": 0}
    assert "content" not in batch["items"][0]


def test_missing_client_permissions_never_disclose_foreign_contact(harness):
    chat, _, db, _ = harness
    seed(db, "owned")
    run(db.themis_clients.update_one({"id": "owned"}, {
        "$set": {"user_id": "u2", "email": "secret@example.test"},
    }))
    result = ask(chat, COMMAND)
    assert result["work_batch"]["counts"]["blocked"] == 1
    assert "secret@example.test" not in str(result)


def test_batch_reader_failure_is_not_an_empty_success(harness):
    from fastapi import HTTPException

    chat, _, _, service = harness

    async def unavailable(*args):
        raise HTTPException(503, "Stockage temporairement indisponible.")

    service.preview_invoice_batch = unavailable
    result = chat.post("/api/chat", headers={"x-test-user": "u1"},
                       json={"text": COMMAND, "session_id": "main"})
    assert result.status_code == 503
    assert "work_batch" not in result.json()


@pytest.mark.parametrize("reply", ["Oui", "Envoie-les", "Envoie tout", "Envoie les relances", "Annule"])
def test_batch_followups_are_non_executing(harness, reply):
    chat, _, db, _ = harness
    seed(db, "one")
    ask(chat, COMMAND)
    result = ask(chat, reply)
    assert result["work_state"] in ("NOT_EXECUTED", "READ_ONLY")
    assert result["executed"] is False
    assert "work_batch" not in result
    assert run(db.sirius_work_entries.count_documents({})) == 0


@pytest.mark.parametrize("values,expected", [
    ({"paid": 119.999}, "skipped"),
    ({"status": "brouillon"}, "skipped"),
    ({"status": "inconnu"}, "blocked"),
])
def test_unissued_invoices_and_rounded_zero_balances_are_not_reminded(harness, values, expected):
    _, work, db, _ = harness
    seed(db, "one", **values)
    result = work.post(PATH, headers={"x-test-user": "u1"}, json={}).json()
    assert result["items"][0]["state"] == expected
    assert "content" not in result["items"][0]


def test_batch_and_single_preview_share_exact_content_and_fingerprint(harness):
    from test_work_conversation import dossier

    _, work, db, _ = harness
    did = dossier(work)
    seed(db, "one")
    run(db.sirius_work_dossiers.update_one({"id": did}, {
        "$set": {"sources": [{"kind": "facture", "id": "one", "module": "themis"}]},
    }))
    batch = work.post(PATH, headers={"x-test-user": "u1"}, json={}).json()
    single = work.post(f"/api/work-dossiers/{did}/draft-preview", headers={"x-test-user": "u1"},
                       json={"source": {"kind": "facture", "id": "one"}}).json()
    assert batch["items"][0]["content"] == single["content"]
    assert batch["items"][0]["fingerprint"] == single["fingerprint"]
