from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import local_memory
from productivite.intent_productivite import parse_productivity_intent
from productivite.routes_productivite import make_productivity_router
from productivite.store import ProductivityStore


@pytest.fixture
def productivity_client(tmp_path):
    app = FastAPI()
    store = ProductivityStore(tmp_path / "productivity-test.db")
    app.include_router(make_productivity_router(db=None, store=store))
    return TestClient(app)


def test_document_and_code_analysis_routes(productivity_client):
    document = productivity_client.post(
        "/productivity/documents/analyze",
        json={
            "title": "Plan de lancement",
            "content": "# Objectif\n\nTODO: preparer la demonstration.\n\nLe lancement est prevu mardi. L'equipe valide le contenu.",
        },
    )
    assert document.status_code == 200
    assert document.json()["headings"] == ["Objectif"]
    assert document.json()["action_items"] == ["preparer la demonstration."]

    code = productivity_client.post(
        "/productivity/code/analyze",
        json={"language": "python", "code": "try:\n    eval(source)\nexcept:\n    pass\n"},
    )
    assert code.status_code == 200
    diagnostics = code.json()["diagnostics"]
    assert {item["rule"] for item in diagnostics} >= {"unsafe-eval", "broad-except"}


def test_notes_tasks_reports_and_oracle_routes(productivity_client):
    created_note = productivity_client.post(
        "/productivity/notes",
        json={"title": "Decision client", "content": "Valider la maquette mercredi.", "tags": ["client", "maquette"]},
    )
    assert created_note.status_code == 200
    note_id = created_note.json()["id"]

    notes = productivity_client.get("/productivity/notes?query=client")
    assert notes.status_code == 200
    assert [note["id"] for note in notes.json()["notes"]] == [note_id]

    updated_note = productivity_client.put(f"/productivity/notes/{note_id}", json={"pinned": True})
    assert updated_note.status_code == 200
    assert updated_note.json()["pinned"] is True

    created_task = productivity_client.post(
        "/productivity/tasks",
        json={"title": "Preparer le rapport", "priority": "high", "due_at": "2026-08-22T10:00:00+00:00"},
    )
    assert created_task.status_code == 200
    task_id = created_task.json()["id"]

    updated_task = productivity_client.put(f"/productivity/tasks/{task_id}", json={"status": "in_progress"})
    assert updated_task.status_code == 200
    assert updated_task.json()["status"] == "in_progress"

    report = productivity_client.post(
        "/productivity/reports/build",
        json={"title": "Point hebdomadaire", "report_type": "weekly"},
    )
    assert report.status_code == 200
    assert "# Point hebdomadaire" in report.json()["content"]

    oracle = productivity_client.get("/productivity/oracle")
    assert oracle.status_code == 200
    assert oracle.json()["status"] == "focus"
    assert oracle.json()["tasks"]["in_progress"] == 1


def test_productivity_intent_supports_plural_notes():
    intent = parse_productivity_intent("Sirius ouvre mes notes de travail")

    assert intent["action"] == "productivity_control"
    assert intent["productivity"]["tab"] == "notes"
    assert intent["productivity"]["command"] == "list"


def test_user_deletion_removes_productivity_data(tmp_path, monkeypatch):
    database = tmp_path / "sirius-local-test.db"
    monkeypatch.setattr(local_memory, "DB_PATH", database)
    local_memory.init_local_db()
    store = ProductivityStore(database)
    store.create_note("productivity-user", "Note", "Contenu")
    store.create_task("productivity-user", "Tache")
    store.create_report("productivity-user", "Rapport", "# Rapport")

    local_memory.delete_user_data("productivity-user")

    assert store.list_notes("productivity-user") == []
    assert store.list_tasks("productivity-user") == []
    assert store.list_reports("productivity-user") == []
