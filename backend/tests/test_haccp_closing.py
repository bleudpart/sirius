import asyncio
import json
import uuid
from datetime import date, datetime, timedelta
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

import cloud_link
import haccp_closing as closing
import haccp_database
from local_docstore import LocalDocStore
from models.haccp import EtiquetteHaccp
from models.haccp_printing import HaccpPrintJob
from routers.haccp import make_haccp_router

DAY = date(2026, 11, 3)
NOW = datetime(2026, 11, 3, 12)


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "0")
    haccp_database._configured_engine.cache_clear()
    haccp_database.get_engine()
    yield tmp_path
    haccp_database.get_engine().dispose()
    haccp_database._configured_engine.cache_clear()


def label(scope="user:one", **changes):
    data = {
        "scope_key": scope, "created_at": NOW, "nom_produit": "Produit TEST",
        "numero_lot": str(uuid.uuid4()), "image_path": "",
        "type_date": "DLC", "dlc_ou_ddm": DAY + timedelta(days=30),
        "allergenes_lecture": "complete", "champs_incertains": [],
    }
    data.update(changes)
    with Session(haccp_database.get_engine()) as db:
        row = EtiquetteHaccp(**data)
        db.add(row)
        db.commit()
        return row.id


def print_job(label_id, status, scope="user:one"):
    with Session(haccp_database.get_engine()) as db:
        db.add(HaccpPrintJob(
            id=str(uuid.uuid4()), scope_key=scope, label_id=label_id,
            relay_id=str(uuid.uuid4()), created_at=NOW,
            claimed_at=NOW if status in {"claimed", "uncertain", "accepted"} else None,
            accepted_at=NOW if status == "accepted" else None, status=status,
        ))
        db.commit()


@pytest.fixture
def api(store):
    async def scope(request: Request):
        user = request.headers.get("x-user")
        if not user:
            raise HTTPException(401, "Connexion requise.")
        return "user:" + user

    app = FastAPI()
    app.include_router(make_haccp_router(scope), prefix="/api")
    with TestClient(app) as client:
        yield client


def get_report(client, day=DAY, user="one"):
    return client.get("/api/haccp/registre/cloture", params={"date": day.isoformat()},
                      headers={"x-user": user} if user else {})


def test_closing_report_is_scoped_daily_and_contains_bounded_actionable_priorities(api):
    flagged = label(conforme_reception=False, commentaire_anomalie="Lot mal identifié.")
    due = label(nom_produit="Yaourt TEST", numero_lot="LOT-DUE", dlc_ou_ddm=DAY + timedelta(days=2))
    unread = label(nom_produit="Sauce TEST", numero_lot="LOT-UNKNOWN", allergenes_lecture="partielle")
    old = label(created_at=NOW - timedelta(days=1), conforme_reception=False)
    pending = label(nom_produit="Pain TEST", numero_lot="LOT-PRINT")
    print_job(pending, "uncertain")
    accepted = label(nom_produit="Riz TEST", numero_lot="LOT-ACCEPTED")
    print_job(accepted, "accepted")
    label("user:two", conforme_reception=False)
    response = get_report(api)
    assert response.status_code == 200
    report = response.json()
    assert report["date"] == "2026-11-03" and report["fuseau"] == "Europe/Paris"
    assert report["etiquettes_enregistrees"] == 5
    assert report["impressions_confirmees"] == 1
    assert report["statut"] == "attention"
    assert [item["code"] for item in report["priorites"]] == [
        "non_conformites", "impressions", "dates", "lectures",
    ]
    assert report["priorites"][0]["fiches"][0]["etiquette_id"] == flagged
    assert report["priorites"][0]["fiches"][0]["motif"] == "Lot mal identifié."
    assert report["priorites"][1]["fiches"][0]["statut_impression"] == "uncertain"
    assert report["priorites"][2]["fiches"][0]["etiquette_id"] == due
    assert report["priorites"][3]["fiches"][0]["etiquette_id"] == unread
    assert all(old != item["etiquette_id"] for priority in report["priorites"] for item in priority["fiches"])
    assert any("ne prouve pas" in limit for limit in report["limites"])
    other = get_report(api, user="two").json()
    assert other["etiquettes_enregistrees"] == 1
    assert other["priorites"][0]["fiches"][0]["etiquette_id"] != flagged


def test_closing_report_does_not_infer_compliance_when_no_alerts_are_recorded(api):
    label()
    report = get_report(api).json()
    assert report["statut"] == "aucune_alerte_enregistree"
    assert report["priorites"] == []
    assert report["etiquettes_enregistrees"] == 1
    assert "Les contrôles physiques" in closing.closing_answer(closing.ClosingReport.model_validate(report))


def test_expiration_is_evaluated_in_paris_time_and_only_for_today_created_labels(store):
    label(dlc_secondaire=datetime(2026, 11, 3, 22, 59, 59))
    label(nom_produit="Demain TEST", numero_lot="TOMORROW", dlc_secondaire=datetime(2026, 11, 3, 23))
    report = closing.read_closing_report("user:one", DAY)
    date_priority = next(item for item in report.priorites if item.code == "dates")
    assert date_priority.total == 2
    assert sorted(item.date_cible for item in date_priority.fiches) == [DAY, DAY + timedelta(days=1)]


@pytest.mark.parametrize("text,expected", [
    ("Fais le point avant la fermeture", DAY),
    ("Bilan de fin de service", DAY),
    ("Rapport de clôture HACCP hier", DAY - timedelta(days=1)),
    ("Bilan HACCP du jour", DAY),
    ("Bilan de clôture le 02/11/2026", DAY - timedelta(days=1)),
])
def test_daily_closing_voice_periods_are_deterministic(text, expected):
    assert closing.is_haccp_closing_request(text)
    assert closing.closing_report_day(text, DAY) == expected


@pytest.mark.parametrize("text", [
    "Bilan de clôture demain", "Rapport de clôture cette semaine",
    "Bilan de fin de service du 01/11/2026 au 03/11/2026",
    "Bilan de clôture le 31/02/2026",
])
def test_closing_report_refuses_unsupported_or_invalid_periods(text):
    with pytest.raises(ValueError):
        closing.closing_report_day(text, DAY)


def test_pdf_requires_a_named_human_confirmation_and_a_current_report_revision(api):
    label(conforme_reception=False, commentaire_anomalie="Contrôle TEST.")
    report = get_report(api).json()
    route = "/api/haccp/registre/cloture/pdf"
    base = {"date": report["date"], "revision": report["revision"], "nom_responsable": "Responsable Test"}
    assert api.post(route, json={**base, "confirme_verification_humaine": False},
                    headers={"x-user": "one"}).status_code == 422
    assert api.post(route, json={**base, "nom_responsable": "X", "confirme_verification_humaine": True},
                    headers={"x-user": "one"}).status_code == 422
    stale = api.post(route, json={**base, "revision": "0" * 64, "confirme_verification_humaine": True},
                     headers={"x-user": "one"})
    assert stale.status_code == 409 and "Rechargez-le" in stale.json()["detail"]
    response = api.post(route, json={**base, "confirme_verification_humaine": True},
                        headers={"x-user": "one"})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"].endswith("bilan-cloture-haccp-2026-11-03.pdf\"")
    assert response.content.startswith(b"%PDF-")
    assert response.headers["cache-control"] == "private, no-store"
    assert get_report(api, user=None).status_code == 401
    assert api.post(route, json={**base, "confirme_verification_humaine": True},
                    headers={"x-user": "two"}).status_code == 409


def test_invalid_closing_cloud_report_and_pdf_are_explicit_errors(api, monkeypatch):
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "1")
    monkeypatch.setattr(cloud_link, "relay_haccp_registry", AsyncMock(
        return_value=httpx.Response(200, json={"date": "2026-11-02"}),
    ))
    response = get_report(api)
    assert response.status_code == 502
    assert "invalide" in response.json()["detail"]
    body = {
        "date": "2026-11-03", "revision": "a" * 64, "nom_responsable": "Responsable Test",
        "confirme_verification_humaine": True,
    }
    monkeypatch.setattr(cloud_link, "relay_haccp_registry", AsyncMock(
        return_value=httpx.Response(200, content=b"not a pdf", headers={"content-type": "text/plain"}),
    ))
    response = api.post("/api/haccp/registre/cloture/pdf", json=body, headers={"x-user": "one"})
    assert response.status_code == 502 and "PDF" in response.json()["detail"]


@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_real_chat_and_sse_closing_report_bypass_models_and_quotas(store, monkeypatch, endpoint):
    import server
    db = LocalDocStore(store / "chat.sqlite3")

    async def user(request, _db):
        uid = request.headers.get("x-user")
        if not uid:
            raise HTTPException(401)
        return {"user_id": uid}

    async def no_model(*args, **kwargs):
        pytest.fail("A closing report must use stored data, not an AI model or quota")

    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server, "require_user", user)
    monkeypatch.setattr(server, "_haccp_labels_scope", AsyncMock(return_value="user:one"))
    monkeypatch.setattr(server, "_rate_ok", lambda *args, **kwargs: True)
    monkeypatch.setattr(server, "ask_sirius", no_model)
    monkeypatch.setattr(server, "require_personal", no_model)
    monkeypatch.setattr(server, "repondre_analyse", no_model)
    monkeypatch.setattr(server.usage_quota, "consume", no_model)
    monkeypatch.setattr(server.cloud_link, "should_relay_chat", lambda keys: True)
    monkeypatch.setattr(server.cloud_link, "relay_json", no_model)
    label(conforme_reception=False, commentaire_anomalie="Vérifier le lot.")
    app = FastAPI()
    app.include_router(server.api_router)
    with TestClient(app) as client:
        assert client.post(endpoint, json={"text": "Bilan de fin de service"}).status_code == 401
        response = client.post(endpoint, json={
            "text": "Fais le point avant la fermeture", "session_id": "closing",
        }, headers={"x-user": "one"})
        assert response.status_code == 200, response.text
        if endpoint.endswith("/stream"):
            events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
            data = events[-1]
            assert events[0]["text"] == data["answer"]
        else:
            data = response.json()
        assert data["haccp_closing_report"]["etiquettes_enregistrees"] == 1
        assert data["haccp_closing_report"]["priorites"][0]["code"] == "non_conformites"
        assert data["work_state"] == "READ_ONLY" and data["used_search"] is False
        intent = client.post("/api/intent", json={"text": "Bilan de fin de service"},
                             headers={"x-user": "one"})
        assert intent.status_code == 200 and intent.json()["action"] == "general"
    saved = asyncio.run(db.sirius_chats.find_one({"session_id": "one:closing"}))
    assert saved["user_id"] == "one" and "Bilan HACCP de fin de service" in saved["history"][1]["content"]
