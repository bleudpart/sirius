import asyncio
from datetime import date, timedelta

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from local_docstore import LocalDocStore
from routes.work_dossiers import make_work_dossiers_router


@pytest.fixture
def app_client(tmp_path):
    db = LocalDocStore(tmp_path / "work.db")

    async def require_user(request, _db):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(status_code=401)
        user = {"user_id": uid}
        if request.headers.get("x-test-name"):
            user["name"] = request.headers["x-test-name"]
        if request.headers.get("x-test-company"):
            user["company_id"] = request.headers["x-test-company"]
        return user

    app = FastAPI()
    app.include_router(make_work_dossiers_router(db, require_user), prefix="/api")
    with TestClient(app) as client:
        yield client, db


def test_dossier_notes_and_ownership(app_client):
    client, _ = app_client
    assert client.get("/api/work-dossiers").status_code == 401
    owner = {"x-test-user": "u1"}
    created = client.post(
        "/api/work-dossiers", headers=owner, json={"title": "  Chantier Martin  ", "category": "chantier"}
    )
    assert created.status_code == 201
    dossier = created.json()["dossier"]
    assert dossier["title"] == "Chantier Martin"
    assert "user_id" not in dossier
    assert client.get("/api/work-dossiers", headers={"x-test-user": "u2"}).json()["dossiers"] == []
    assert client.post(
        f"/api/work-dossiers/{dossier['id']}/notes", headers={"x-test-user": "u2"},
        json={"text": "une note"},
    ).status_code == 404
    assert client.post(
        f"/api/work-dossiers/{dossier['id']}/notes", headers=owner, json={"text": "  Appeler le client  "}
    ).json()["note"]["text"] == "Appeler le client"
    assert client.get("/api/work-dossiers", headers=owner).json()["dossiers"][0]["notes"][0]["text"] == "Appeler le client"
    assert client.post("/api/work-dossiers", headers=owner, json={"title": "  "}).status_code == 422


def test_proposals_are_sourced_scoped_and_return_after_state_change(app_client):
    client, db = app_client
    owner = {"x-test-user": "u1"}
    other = {"x-test-user": "u2"}
    expired = (date.today() - timedelta(days=2)).isoformat()
    future = (date.today() + timedelta(days=2)).isoformat()
    import asyncio
    async def seed():
        await db.themis_items.insert_one({"id": "stock-1", "user_id": "u1", "name": "Papier", "stock": 2, "alert": 3})
        await db.themis_items.insert_one({"id": "stock-2", "user_id": "u2", "name": "Privé", "stock": 0, "alert": 5})
        await db.themis_docs.insert_one({
            "id": "invoice-1", "user_id": "u1", "kind": "facture", "number": "FAC-1",
            "due_date": expired, "total_ttc": 100, "paid": 20, "status": "envoyé",
        })
        await db.themis_docs.insert_one({
            "id": "invoice-2", "user_id": "u1", "kind": "facture", "number": "FAC-2",
            "due_date": future, "total_ttc": 100, "paid": 0, "status": "envoyé",
        })
    asyncio.run(seed())
    proposals = client.get("/api/work-dossiers/proposals", headers=owner).json()["proposals"]
    assert len(proposals) == 2
    assert {p["source"]["kind"] for p in proposals} == {"stock", "facture"}
    assert all("Privé" not in p["title"] for p in proposals)
    assert client.get("/api/work-dossiers/proposals", headers=other).json()["proposals"][0]["title"] == "Stock bas : Privé"

    dossier_id = client.post("/api/work-dossiers", headers=owner, json={"title": "Boutique"}).json()["dossier"]["id"]
    stock = next(p for p in proposals if p["source"]["kind"] == "stock")
    invoice = next(p for p in proposals if p["source"]["kind"] == "facture")
    assert invoice["proposed_action"]["label"] == "Préparer la relance dans THÉMIS"
    assert invoice["confirmation_required"] is True
    assert "aucun e-mail ne sera envoyé" in invoice["reason"]
    url = f"/api/work-dossiers/{dossier_id}/proposals/{stock['id']}"
    assert client.post(url, headers=other).status_code == 404
    assert client.post(url, headers=owner).status_code == 200
    assert client.post(url, headers=owner).status_code == 200
    assert len(client.get("/api/work-dossiers", headers=owner).json()["dossiers"][0]["sources"]) == 1

    assert client.post(
        f"/api/work-dossiers/proposals/{stock['id']}/dismiss", headers=other
    ).status_code == 404
    assert client.post(
        f"/api/work-dossiers/proposals/{stock['id']}/dismiss", headers=owner
    ).json() == {"dismissed": True}
    assert len(client.get("/api/work-dossiers/proposals", headers=owner).json()["proposals"]) == 1
    asyncio.run(db.themis_items.update_one(
        {"id": "stock-1", "user_id": "u1"}, {"$set": {"stock": 1}}
    ))
    assert len(client.get("/api/work-dossiers/proposals", headers=owner).json()["proposals"]) == 2


def test_haccp_proposals_use_authorized_registers_and_never_change_them(app_client):
    client, db = app_client
    owner = {"x-test-user": "u1"}
    today = date.today()

    import asyncio
    async def seed():
        await db.haccp_trace.insert_one({
            "id": "trace-expiring", "user_id": "u1", "produit": "Yaourt", "lot": "L-4",
            "dlc": (today + timedelta(days=1)).isoformat(),
        })
        await db.haccp_trace.insert_one({
            "id": "trace-private", "user_id": "u2", "produit": "Privé", "dlc": today.isoformat(),
        })
        await db.haccp_nc.insert_one({
            "id": "nc-open", "user_id": "u1", "type": "température",
            "description": "Frigo hors plage", "gravite": "majeure", "statut": "ouverte",
        })
        await db.haccp_nc.insert_one({
            "id": "nc-closed", "user_id": "u1", "type": "autre",
            "description": "Déjà traitée", "statut": "cloturee",
        })
        await db.haccp_docs.insert_one({
            "id": "doc-expiring", "user_id": "u1", "nom": "Attestation",
            "date_expiration": (today + timedelta(days=10)).isoformat(),
        })
    asyncio.run(seed())

    response = client.get("/api/work-dossiers/proposals", headers=owner)
    assert response.status_code == 200
    payload = response.json()
    proposals = payload["proposals"]
    haccp_proposals = [item for item in proposals if item["source"]["module"] == "haccp"]
    assert {item["source"]["kind"] for item in haccp_proposals} == {
        "haccp_trace", "haccp_nonconformity", "haccp_document",
    }
    assert all(item["source"]["id"] != "trace-private" for item in haccp_proposals)
    assert all(item["source"]["id"] != "nc-closed" for item in haccp_proposals)
    nc_proposal = next(item for item in haccp_proposals if item["source"]["kind"] == "haccp_nonconformity")
    assert nc_proposal["confirmation_required"] is True
    assert nc_proposal["proposed_action"]["label"] == "Examiner dans HACCP"
    assert payload["integrations"][1]["available"] is True

    dossier_id = client.post(
        "/api/work-dossiers", headers=owner, json={"title": "Contrôle HACCP", "category": "haccp"}
    ).json()["dossier"]["id"]
    assert client.post(
        f"/api/work-dossiers/{dossier_id}/proposals/{nc_proposal['id']}", headers=owner
    ).status_code == 200

    async def stored_sources():
        return (
            await db.haccp_trace.find({"user_id": "u1"}).to_list(20),
            await db.haccp_nc.find({"user_id": "u1"}).to_list(20),
            await db.haccp_docs.find({"user_id": "u1"}).to_list(20),
        )
    traces, nonconformities, documents = asyncio.run(stored_sources())
    assert len(traces) == 1
    assert len(nonconformities) == 2
    assert len(documents) == 1
    assert not any(record.get("action_corrective") for record in nonconformities)


def test_company_haccp_proposals_require_haccp_permission(app_client):
    client, db = app_client

    import asyncio
    async def seed():
        await db.enterprise_members.insert_one({
            "company_id": "co1", "user_id": "u1", "role": "viewer", "permissions": ["documents"],
        })
        await db.haccp_nc.insert_one({
            "id": "company-nc", "company_id": "co1", "type": "hygiène",
            "description": "Donnée entreprise", "statut": "ouverte",
        })
    asyncio.run(seed())

    response = client.get(
        "/api/work-dossiers/proposals", headers={"x-test-user": "u1", "x-test-company": "co1"}
    )
    assert response.status_code == 200
    payload = response.json()
    assert not any(item["source"]["id"] == "company-nc" for item in payload["proposals"])
    haccp = next(item for item in payload["integrations"] if item["module"] == "haccp")
    assert haccp["available"] is False
    assert "permission entreprise" in haccp["detail"]


OWNER = {"x-test-user": "u1"}
OTHER = {"x-test-user": "u2"}


def work_thread(client):
    dossier = client.post("/api/work-dossiers", headers=OWNER, json={"title": "Fil intelligent"})
    return f"/api/work-dossiers/{dossier.json()['dossier']['id']}"


def seed_work_sources(db):
    async def seed():
        await db.themis_items.insert_one({
            "id": "paper", "user_id": "u1", "name": "Papier", "stock": 2, "alert": 5, "price": 12,
        })
        await db.themis_clients.insert_one({
            "id": "client", "user_id": "u1", "name": "Martin", "email": "martin@example.test",
        })
        await db.themis_docs.insert_one({
            "id": "invoice", "user_id": "u1", "kind": "facture", "number": "FAC-42",
            "client_id": "client", "client_name": "Martin", "total_ttc": 120, "paid": 20,
            "due_date": (date.today() - timedelta(days=2)).isoformat(), "status": "envoyé",
        })
        await db.haccp_nc.insert_one({
            "id": "nc", "user_id": "u1", "type": "température",
            "description": "Frigo hors plage", "gravite": "majeure", "statut": "ouverte",
        })
    asyncio.run(seed())


def test_decision_memory_commitment_and_missing_next_steps(app_client):
    client, db = app_client
    base = work_thread(client)
    assert client.get(base + "/thread", headers=OWNER).json()["suggestions"][0]["kind"] == "record_decision"
    decision = client.post(base + "/decisions", headers=OWNER, json={
        "outcome": "deferred", "rationale": "  Attendre la validation du budget  ",
    }).json()["entry"]
    assert decision["content"]["rationale"] == "Attendre la validation du budget"
    assert decision["status"] == "proposed"
    assert decision["content"]["decided_by"] == {
        "name": "Compte connecté", "identity": "authenticated_user",
    }
    assert "user_id" not in decision
    commitment = client.post(base + "/commitments", headers=OWNER, json={
        "text": "Appeler Martin", "owner": "Moi",
        "due_date": (date.today() - timedelta(days=1)).isoformat(),
    }).json()["entry"]
    url = base + "/entries/" + commitment["id"]
    assert client.patch(url, headers=OWNER, json={"status": "completed"}).status_code == 409
    assert client.post(url + "/confirm", headers=OWNER, json={"confirmed": False}).status_code == 422
    assert client.post(url + "/confirm", headers=OWNER, json={"confirmed": "true"}).status_code == 422
    assert client.post(url + "/confirm", headers=OWNER, json={"confirmed": True}).json()["executed"] is False
    assert client.post(url + "/confirm", headers=OWNER, json={"confirmed": True}).status_code == 200
    thread = client.get(base + "/thread", headers=OWNER).json()
    assert {"missing_next_step", "overdue_commitment"} <= {s["kind"] for s in thread["suggestions"]}
    assert client.patch(url, headers=OWNER, json={"status": "completed"}).json()["entry"]["status"] == "completed"
    assert client.patch(url, headers=OWNER, json={"status": "completed"}).status_code == 200
    assert client.patch(url, headers=OWNER, json={"status": "cancelled"}).status_code == 409
    assert client.post(url + "/confirm", headers=OWNER, json={"confirmed": True}).status_code == 409
    assert not any(s["kind"] == "overdue_commitment" for s in client.get(base + "/thread", headers=OWNER).json()["suggestions"])
    stored = asyncio.run(db.sirius_work_entries.find_one({"id": commitment["id"]}))
    assert stored["status"] == "completed"


@pytest.mark.parametrize("kind,source_id,draft_type", [
    ("stock", "paper", "stock_reorder"),
    ("facture", "invoice", "invoice_followup"),
    ("haccp_nonconformity", "nc", "haccp_control"),
])
def test_drafts_link_real_sources_and_confirmation_never_executes(app_client, kind, source_id, draft_type):
    client, db = app_client
    seed_work_sources(db)
    base = work_thread(client)
    async def business_state():
        return {
            name: await getattr(db, name).find({}).to_list(50)
            for name in ("themis_items", "themis_docs", "themis_clients", "themis_orders",
                         "haccp_nc", "haccp_controls")
        }
    before = asyncio.run(business_state())
    response = client.post(base + "/drafts", headers=OWNER, json={"source": {"kind": kind, "id": source_id}})
    assert response.status_code == 201
    entry = response.json()["entry"]
    assert entry["content"]["type"] == draft_type
    assert entry["sources"][0]["id"] == source_id
    assert entry["confirmation_required"] is True
    if kind == "stock":
        assert entry["content"]["lines"][0]["qty"] == 4
        assert entry["content"]["lines"][0]["unit_price"] is None
    elif kind == "facture":
        assert entry["content"]["to"] == "martin@example.test"
        assert entry["content"]["remaining"] == 100
        assert "100.00" in entry["content"]["message"]
    else:
        assert entry["content"]["resultat"] is None
        assert entry["content"]["action_corrective"] == ""
    confirmed = client.post(base + f"/entries/{entry['id']}/confirm", headers=OWNER, json={"confirmed": True})
    assert confirmed.json()["entry"]["status"] == "confirmed"
    assert confirmed.json()["executed"] is False
    assert asyncio.run(business_state()) == before
    assert any(s["kind"] == "manual_execution" for s in client.get(base + "/thread", headers=OWNER).json()["suggestions"])


def test_snapshot_diff_and_stale_draft_confirmation(app_client):
    client, db = app_client
    seed_work_sources(db)
    base = work_thread(client)
    draft = client.post(base + "/drafts", headers=OWNER, json={"source": {"kind": "stock", "id": "paper"}}).json()["entry"]
    checkpoint = client.post(base + "/snapshots", headers=OWNER)
    assert checkpoint.status_code == 201
    assert client.get(base + "/thread", headers=OWNER).json()["what_changed"]["changes"] == []
    asyncio.run(db.themis_items.update_one({"id": "paper", "user_id": "u1"}, {"$set": {"stock": 1}}))
    thread = client.get(base + "/thread", headers=OWNER).json()
    assert thread["what_changed"]["baseline_id"] == checkpoint.json()["snapshot"]["id"]
    assert thread["what_changed"]["changes"][0]["fields"] == {"stock": {"before": 2, "after": 1}}
    assert thread["entries"][0]["source_changed"] is True
    assert any(s["kind"] == "review_changed_source" for s in thread["suggestions"])
    assert client.post(base + f"/entries/{draft['id']}/confirm", headers=OWNER, json={"confirmed": True}).status_code == 409
    fresh = client.post(base + "/drafts", headers=OWNER, json={"source": {"kind": "stock", "id": "paper"}}).json()["entry"]
    assert client.post(base + f"/entries/{fresh['id']}/confirm", headers=OWNER, json={"confirmed": True}).status_code == 200
    client.post(base + "/snapshots", headers=OWNER)
    assert client.get(base + "/thread", headers=OWNER).json()["what_changed"]["changes"] == []


def test_recipient_change_and_foreign_client_are_not_trusted(app_client):
    client, db = app_client
    seed_work_sources(db)
    base = work_thread(client)
    source = {"source": {"kind": "facture", "id": "invoice"}}
    draft = client.post(base + "/drafts", headers=OWNER, json=source).json()["entry"]
    asyncio.run(db.themis_clients.update_one({"id": "client"}, {"$set": {"email": "new@example.test"}}))
    assert client.post(base + f"/entries/{draft['id']}/confirm", headers=OWNER, json={"confirmed": True}).status_code == 409
    asyncio.run(db.themis_clients.update_one({"id": "client"}, {"$set": {"user_id": "u2"}}))
    assert client.post(base + "/drafts", headers=OWNER, json=source).json()["entry"]["content"]["to"] == ""
    asyncio.run(db.themis_docs.update_one({"id": "invoice"}, {"$set": {"paid": 120, "status": "payé"}}))
    assert client.post(base + "/drafts", headers=OWNER, json=source).status_code == 409


def test_meeting_task_proposals_and_private_cross_business_handoff(app_client):
    client, db = app_client
    seed_work_sources(db)
    base = work_thread(client)
    meeting = client.post(base + "/meetings", headers=OWNER, json={
        "title": "Réunion boutique", "notes": "Budget à vérifier",
        "tasks": [{"text": "Vérifier le stock", "owner": "Martin", "source": {"kind": "stock", "id": "paper"}}],
    }).json()["entry"]
    assert meeting["content"]["tasks"][0]["status"] == "proposed"
    result = client.post(base + f"/entries/{meeting['id']}/confirm", headers=OWNER, json={"confirmed": True})
    assert result.json()["entry"]["content"]["tasks"][0]["status"] == "confirmed"
    assert any(s["kind"] == "task_proposal" for s in client.get(base + "/thread", headers=OWNER).json()["suggestions"])
    handoff = client.post(base + "/handoffs", headers=OWNER, json={
        "target": "haccp", "objective": "Coordonner commerce et contrôle",
        "sources": [{"kind": "stock", "id": "paper"}, {"kind": "haccp_nonconformity", "id": "nc"}],
    })
    assert handoff.status_code == 201
    entry = handoff.json()["entry"]
    assert entry["content"]["delivery"] == "manual"
    assert len(entry["source_snapshots"]) == 2
    assert client.get(base + "/thread", headers=OTHER).status_code == 404
    assert asyncio.run(db.sirius_work_entries.find({"user_id": "u2"}).to_list(10)) == []


def test_simulations_use_explicit_assumptions_without_writes(app_client):
    client, db = app_client
    seed_work_sources(db)
    base = work_thread(client)
    stock = client.post(base + "/simulations", headers=OWNER, json={
        "source": {"kind": "stock", "id": "paper"}, "quantity_delta": 4,
    }).json()
    assert stock["result"] == {"stock_before": 2, "stock_after": 6, "below_alert": False}
    assert stock["assumptions"] == {"quantity_delta": 4, "other_movements": 0}
    assert stock["persisted"] is False
    invoice = client.post(base + "/simulations", headers=OWNER, json={
        "source": {"kind": "facture", "id": "invoice"}, "payment": 30,
    }).json()
    assert invoice["result"] == {"remaining_before": 100, "remaining_after": 70}
    for body in (
        {"source": {"kind": "stock", "id": "paper"}, "quantity_delta": -3},
        {"source": {"kind": "facture", "id": "invoice"}, "payment": 101},
        {"source": {"kind": "stock", "id": "paper"}, "quantity_delta": 1, "payment": 2},
        {"source": {"kind": "haccp_nonconformity", "id": "nc"}, "payment": 1},
    ):
        assert client.post(base + "/simulations", headers=OWNER, json=body).status_code == 422
    assert asyncio.run(db.themis_items.find_one({"id": "paper"}))["stock"] == 2
    assert asyncio.run(db.themis_docs.find_one({"id": "invoice"}))["paid"] == 20
    assert client.get(base + "/thread", headers=OWNER).json()["entries"] == []


def test_revoked_company_permission_hides_saved_business_memory(app_client):
    client, db = app_client
    company = {**OWNER, "x-test-company": "co1"}
    async def seed():
        await db.enterprise_members.insert_one({
            "company_id": "co1", "user_id": "u1", "role": "viewer", "permissions": ["haccp"],
        })
        await db.haccp_nc.insert_one({
            "id": "co-nc", "company_id": "co1", "type": "hygiène",
            "description": "Confidentiel entreprise", "statut": "ouverte",
        })
    asyncio.run(seed())
    base = work_thread(client)
    draft = client.post(base + "/drafts", headers=company, json={
        "source": {"kind": "haccp_nonconformity", "id": "co-nc"},
    }).json()["entry"]
    client.post(base + "/snapshots", headers=company)
    assert len(client.get(base + "/thread", headers=company).json()["entries"]) == 1
    asyncio.run(db.enterprise_members.update_one(
        {"company_id": "co1", "user_id": "u1"}, {"$set": {"permissions": ["documents"]}}
    ))
    result = client.get(base + "/thread", headers=company)
    assert result.json()["entries"] == []
    assert result.json()["sources"] == []
    assert result.json()["unavailable_sources"] == 1
    assert result.json()["what_changed"]["changes"] == []
    assert "Confidentiel" not in result.text
    assert client.get("/api/work-dossiers", headers=company).json()["dossiers"][0]["sources"] == []
    assert client.post(base + f"/entries/{draft['id']}/confirm", headers=company, json={"confirmed": True}).status_code == 404
    assert client.post(base + "/snapshots", headers=company).json()["snapshot"]["sources"] == []


@pytest.mark.parametrize("endpoint,body", [
    ("decisions", {"outcome": "accepted", "rationale": "Oui"}),
    ("commitments", {"text": "Appeler", "owner": "Moi"}),
    ("meetings", {"title": "Réunion", "notes": "Notes"}),
    ("drafts", {"source": {"kind": "stock", "id": "paper"}}),
    ("handoffs", {"target": "general", "objective": "Coordonner", "sources": [{"kind": "stock", "id": "paper"}]}),
    ("simulations", {"source": {"kind": "stock", "id": "paper"}, "quantity_delta": 1}),
    ("snapshots", None),
])
def test_new_endpoints_enforce_authentication_and_dossier_ownership(app_client, endpoint, body):
    client, db = app_client
    seed_work_sources(db)
    base = work_thread(client)
    assert client.post(base + "/" + endpoint, json=body).status_code == 401
    assert client.post(base + "/" + endpoint, headers=OTHER, json=body).status_code == 404


def test_foreign_sources_deleted_sources_and_invalid_input(app_client):
    client, db = app_client
    seed_work_sources(db)
    base = work_thread(client)
    foreign = work_thread(client)
    source = {"kind": "stock", "id": "paper"}
    decision = client.post(base + "/decisions", headers=OWNER, json={
        "outcome": "accepted", "rationale": "Oui", "source": source,
    }).json()["entry"]
    assert client.post(foreign + f"/entries/{decision['id']}/confirm", headers=OWNER, json={"confirmed": True}).status_code == 404
    assert client.post(base + f"/entries/{decision['id']}/confirm", headers=OTHER, json={"confirmed": True}).status_code == 404
    asyncio.run(db.themis_items.update_one({"id": "paper"}, {"$set": {"user_id": "u2"}}))
    assert client.post(base + "/drafts", headers=OWNER, json={"source": source}).status_code == 404
    assert client.post(base + "/decisions", headers=OWNER, json={
        "outcome": "accepted", "rationale": "Oui", "source": source,
    }).status_code == 404
    assert client.get(base + "/thread", headers=OWNER).json()["entries"] == []
    asyncio.run(db.themis_items.delete_one({"id": "paper"}))
    assert client.post(base + f"/entries/{decision['id']}/confirm", headers=OWNER, json={"confirmed": True}).status_code == 404
    for endpoint, body in (
        ("decisions", {"outcome": "accepted", "rationale": "  "}),
        ("commitments", {"text": "Appeler", "owner": "Moi", "due_date": "demain"}),
        ("meetings", {"title": "Réunion", "notes": "Notes", "tasks": [{"text": "", "owner": "Moi"}]}),
        ("drafts", {"source": source, "send": True}),
        ("handoffs", {"target": "outlook", "objective": "Envoyer", "sources": [source]}),
    ):
        assert client.post(base + "/" + endpoint, headers=OWNER, json=body).status_code == 422


@pytest.mark.parametrize("kind,collection,data", [
    ("haccp_trace", "haccp_trace", {"produit": "Yaourt", "lot": "L-1", "dlc": date.today().isoformat()}),
    ("haccp_document", "haccp_docs", {"nom": "Attestation", "date_expiration": date.today().isoformat()}),
])
def test_haccp_drafts_for_trace_and_document_and_company_scope(app_client, kind, collection, data):
    client, db = app_client
    asyncio.run(getattr(db, collection).insert_one({"id": "personal", "user_id": "u1", **data}))
    base = work_thread(client)
    response = client.post(base + "/drafts", headers=OWNER, json={"source": {"kind": kind, "id": "personal"}})
    assert response.status_code == 201
    assert response.json()["entry"]["content"]["objet"] == data.get("produit", data.get("nom"))
    assert response.json()["entry"]["content"]["resultat"] is None
    asyncio.run(db.enterprise_members.insert_one({
        "company_id": "co1", "user_id": "u1", "role": "viewer", "permissions": ["haccp"],
    }))
    company = {**OWNER, "x-test-company": "co1"}
    assert client.post(base + "/drafts", headers=company, json={"source": {"kind": kind, "id": "personal"}}).status_code == 404
    assert client.get(base + "/thread", headers=company).json()["entries"] == []


def test_thread_memory_survives_store_reopen(app_client):
    client, db = app_client
    seed_work_sources(db)
    base = work_thread(client)
    decision = client.post(base + "/decisions", headers=OWNER, json={
        "outcome": "accepted", "rationale": "Réapprovisionner après vérification",
        "next_step": "Demander un devis", "source": {"kind": "stock", "id": "paper"},
    }).json()["entry"]
    client.post(base + f"/entries/{decision['id']}/confirm", headers=OWNER, json={"confirmed": True})
    snapshot = client.post(base + "/snapshots", headers=OWNER).json()["snapshot"]
    reopened = LocalDocStore(db._path)
    async def require_user(request, _db):
        return {"user_id": "u1"}
    app = FastAPI()
    app.include_router(make_work_dossiers_router(reopened, require_user), prefix="/api")
    with TestClient(app) as restored:
        payload = restored.get(base + "/thread").json()
    assert payload["entries"][0]["id"] == decision["id"]
    assert payload["entries"][0]["status"] == "confirmed"
    assert payload["entries"][0]["content"]["next_step"] == "Demander un devis"
    assert payload["what_changed"]["baseline_id"] == snapshot["id"]
    assert payload["what_changed"]["changes"] == []


def test_entry_limit_is_explicit_and_invalid_draft_quantity_is_rejected(app_client):
    client, db = app_client
    seed_work_sources(db)
    base = work_thread(client)
    async def seed():
        for index in range(501):
            await db.sirius_work_entries.insert_one({
                "id": str(index), "dossier_id": base.rsplit("/", 1)[-1], "user_id": "u1",
                "kind": "decision", "content": {"next_step": "Appeler"}, "sources": [],
                "source_snapshots": [], "status": "confirmed", "created_at": f"{index:04}",
            })
    asyncio.run(seed())
    thread = client.get(base + "/thread", headers=OWNER).json()
    assert thread["truncated"] is True
    assert len(thread["entries"]) == 500
    assert thread["entries"][0]["id"] == "500"
    assert client.post(base + "/drafts", headers=OWNER, json={
        "source": {"kind": "stock", "id": "paper"}, "quantity": 0,
    }).status_code == 422
    assert client.post(base + "/drafts", headers=OWNER, json={
        "source": {"kind": "facture", "id": "invoice"}, "quantity": 2,
    }).status_code == 422


def test_decision_actor_display_is_authenticated_not_client_supplied(app_client):
    client, _ = app_client
    base = work_thread(client)
    headers = {**OWNER, "x-test-name": "  Martin  "}
    response = client.post(base + "/decisions", headers=headers, json={
        "outcome": "accepted", "rationale": "Budget validé",
    })
    assert response.status_code == 201
    assert response.json()["entry"]["content"]["decided_by"] == {
        "name": "Martin", "identity": "authenticated_user",
    }
    assert "user_id" not in response.json()["entry"]
    assert client.post(base + "/decisions", headers=headers, json={
        "outcome": "accepted", "rationale": "Budget validé", "decided_by": {"name": "Autre"},
    }).status_code == 422
