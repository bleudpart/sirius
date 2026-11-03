import asyncio
import json
import sqlite3
import uuid
from datetime import date, datetime, time, timedelta, timezone
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

import cloud_link
import haccp_activity as activity
import haccp_database
from local_docstore import LocalDocStore
from models.haccp import EtiquetteHaccp
from models.haccp_printing import HaccpPrintJob
from routers.haccp import make_haccp_router
from schemas.haccp import PARIS


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "0")
    haccp_database._configured_engine.cache_clear()
    haccp_database.get_engine()
    yield tmp_path
    haccp_database.get_engine().dispose()
    haccp_database._configured_engine.cache_clear()


def label(created_at, scope="user:one", **changes):
    with Session(haccp_database.get_engine()) as db:
        row = EtiquetteHaccp(
            scope_key=scope, created_at=created_at, nom_produit="Produit TEST",
            numero_lot=str(uuid.uuid4()), image_path="", **changes,
        )
        db.add(row)
        db.commit()
        return row.id


def printed(accepted_at, status="accepted", scope="user:one"):
    before_period = datetime(2026, 1, 1)
    label_id = label(before_period, scope)
    with Session(haccp_database.get_engine()) as db:
        job = HaccpPrintJob(
            id=str(uuid.uuid4()), scope_key=scope, label_id=label_id,
            relay_id=str(uuid.uuid4()), created_at=before_period,
            claimed_at=before_period + timedelta(minutes=1),
            status=status, accepted_at=accepted_at,
        )
        db.add(job)
        db.commit()
        return job.id


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


def get(client, start="2026-11-03", end="2026-11-03", user="one"):
    return client.get("/api/haccp/registre/activite",
                      params={"date_debut": start, "date_fin": end},
                      headers={"x-user": user} if user else {})


def test_counts_use_registration_and_confirmation_dates_not_queue_or_fabrication(store):
    stamps = [datetime(2026, 11, 2, 22, 59, 59), datetime(2026, 11, 2, 23),
              datetime(2026, 11, 3, 22, 59, 59), datetime(2026, 11, 3, 23)]
    for stamp in stamps:
        label(stamp, type_operation="preparation", date_fabrication=datetime(2026, 11, 1))
        printed(stamp)
    for status in ("pending", "claimed", "uncertain", "cancelled"):
        printed(None, status)
    printed(None)
    label(stamps[1], "user:two")
    printed(stamps[1], scope="user:two")
    printed(None, scope="user:two")
    report = activity.read_activity("user:one", date(2026, 11, 2), date(2026, 11, 4))
    assert [day.etiquettes_enregistrees for day in report.jours] == [1, 2, 1]
    assert [day.impressions_confirmees for day in report.jours] == [1, 2, 1]
    assert report.etiquettes_enregistrees == report.impressions_confirmees == 4
    assert report.impressions_sans_date == 1
    assert report.fuseau == "Europe/Paris"
    assert report.genere_le.tzinfo is not None
    answer = activity.activity_answer(report)
    assert "02/11/2026 : 1 / 1" in answer
    assert "03/11/2026 : 2 / 2" in answer
    assert "1 ancien(s)" in answer and "exclus de ce bilan" in answer
    assert "ne garantit pas la sortie papier" in answer


@pytest.mark.parametrize("day,hours", [(date(2026, 3, 29), 23), (date(2026, 10, 25), 25), (date(1900, 1, 1), 24)])
def test_day_boundaries_follow_paris_including_clock_changes(store, day, hours):
    first = datetime.combine(day, time.min, PARIS).astimezone(timezone.utc).replace(tzinfo=None)
    end = datetime.combine(day + timedelta(days=1), time.min, PARIS).astimezone(timezone.utc).replace(tzinfo=None)
    assert (end - first).total_seconds() == hours * 3600
    for stamp in (first - timedelta(microseconds=1), first, first + timedelta(hours=2),
                  end - timedelta(microseconds=1), end):
        label(stamp)
    report = activity.read_activity("user:one", day, day)
    assert report.etiquettes_enregistrees == 3
    assert report.impressions_confirmees == 0


def test_counts_are_not_limited_to_registry_or_queue_pagination(store):
    with Session(haccp_database.get_engine()) as db:
        db.add_all([
            EtiquetteHaccp(scope_key="user:one", created_at=datetime(2026, 11, 3, 12),
                           nom_produit="TEST", numero_lot=str(i), image_path="")
            for i in range(1205)
        ])
        db.commit()
    report = activity.read_activity("user:one", date(2026, 11, 2), date(2026, 11, 3))
    assert [day.etiquettes_enregistrees for day in report.jours] == [0, 1205]
    assert report.etiquettes_enregistrees == 1205


def test_api_is_scoped_read_only_and_returns_real_zeroes(api):
    label(datetime(2026, 11, 3, 12))
    printed(datetime(2026, 11, 3, 12))
    assert get(api, user=None).status_code == 401
    first = get(api)
    assert first.status_code == 200
    assert first.json()["etiquettes_enregistrees"] == first.json()["impressions_confirmees"] == 1
    other = get(api, user="two").json()
    assert other["jours"] == [{"date": "2026-11-03", "etiquettes_enregistrees": 0, "impressions_confirmees": 0}]
    assert other["impressions_sans_date"] == 0
    assert get(api).json()["jours"] == first.json()["jours"]
    with Session(haccp_database.get_engine()) as db:
        assert db.scalar(select(func.count()).select_from(EtiquetteHaccp)) == 2
        assert db.scalar(select(func.count()).select_from(HaccpPrintJob)) == 1


@pytest.mark.parametrize("start,end", [
    ("2026-11-04", "2026-11-03"), ("2026-02-30", "2026-03-01"),
    ("2024-01-01", "2025-01-01"), ("0001-01-01", "0001-01-02"),
    ("9999-12-30", "9999-12-31"),
])
def test_api_rejects_invalid_or_unbounded_periods(api, start, end):
    assert get(api, start, end).status_code == 422


def test_storage_failure_is_not_reported_as_zero(api, monkeypatch, caplog):
    def broken():
        raise OperationalError("read", {}, RuntimeError("unavailable"))
    monkeypatch.setattr(activity, "get_engine", broken)
    response = get(api)
    assert response.status_code == 503
    assert "Aucun chiffre" in response.json()["detail"]
    assert "HACCP-ACTIVITY" in caplog.text


def test_migration_preserves_undated_legacy_prints(store):
    job_id = printed(None)
    engine = haccp_database.get_engine()
    engine.dispose()
    haccp_database._configured_engine.cache_clear()
    with sqlite3.connect(store / "haccp.sqlite3") as connection:
        connection.execute("DROP INDEX ix_haccp_print_activity")
        connection.execute("ALTER TABLE haccp_print_jobs DROP COLUMN accepted_at")
    report = activity.read_activity("user:one", date(2026, 11, 3), date(2026, 11, 3))
    assert report.impressions_confirmees == 0 and report.impressions_sans_date == 1
    with Session(haccp_database.get_engine()) as db:
        job = db.get(HaccpPrintJob, job_id)
        assert job.status == "accepted" and job.accepted_at is None
        assert job.created_at == datetime(2026, 1, 1)


def test_cloud_scope_is_used_instead_of_local_counts(api, monkeypatch):
    label(datetime(2026, 11, 3, 12), "company:cloud")
    report = activity.read_activity("company:cloud", date(2026, 11, 3), date(2026, 11, 3))
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "1")
    relay = AsyncMock(return_value=httpx.Response(200, json=report.model_dump(mode="json")))
    monkeypatch.setattr(cloud_link, "relay_haccp_registry", relay)
    def no_local(*args):
        pytest.fail("A Cloud report must never use local rows")
    monkeypatch.setattr(activity, "read_activity", no_local)
    result = get(api)
    assert result.status_code == 200 and result.json()["etiquettes_enregistrees"] == 1
    assert relay.call_args.args == ("GET", "/registre/activite")
    assert relay.call_args.kwargs["params"] == {"date_debut": "2026-11-03", "date_fin": "2026-11-03"}


@pytest.mark.parametrize("bad", ["failure", "html", "missing", "total", "period", "negative", "timezone"])
def test_cloud_failures_and_invalid_reports_never_fall_back_locally(api, monkeypatch, bad):
    report = activity.read_activity("user:one", date(2026, 11, 3), date(2026, 11, 3)).model_dump(mode="json")
    if bad == "total":
        report["etiquettes_enregistrees"] = 42
    elif bad == "period":
        report.update(date_debut="2026-11-02", date_fin="2026-11-02")
        report["jours"][0]["date"] = "2026-11-02"
    elif bad == "negative":
        report["impressions_sans_date"] = -1
    elif bad == "timezone":
        report["fuseau"] = "UTC"
    elif bad == "missing":
        report.pop("impressions_sans_date")
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "1")
    relay = AsyncMock(
        side_effect=HTTPException(503, "Cloud indisponible") if bad == "failure" else None,
        return_value=httpx.Response(200, text="<html>") if bad == "html" else httpx.Response(200, json=report),
    )
    monkeypatch.setattr(cloud_link, "relay_haccp_registry", relay)
    def no_local(*args):
        pytest.fail("No silent local fallback")
    monkeypatch.setattr(activity, "read_activity", no_local)
    response = get(api)
    assert response.status_code == (503 if bad == "failure" else 502)
    assert "etiquettes_enregistrees" not in response.json()


@pytest.mark.parametrize("text,start,end", [
    ("ΣIRIUS, combien d’étiquettes ont été éditées aujourd’hui ?", "2026-11-03", "2026-11-03"),
    ("Combien d'etiquettes on a imprime hier ?", "2026-11-02", "2026-11-02"),
    ("Donne-moi le nombre d'étiquettes avant-hier", "2026-11-01", "2026-11-01"),
    ("Affiche les statistiques HACCP des étiquettes par jour cette semaine", "2026-11-02", "2026-11-03"),
    ("Bilan des étiquettes de la semaine dernière", "2026-10-26", "2026-11-01"),
    ("Nombre d'étiquettes ce mois-ci", "2026-11-01", "2026-11-03"),
    ("Nombre d'étiquettes le mois dernier", "2026-10-01", "2026-10-31"),
    ("Nombre d'étiquettes sur les sept derniers jours", "2026-10-28", "2026-11-03"),
    ("Compte toutes les étiquettes sur les 30 derniers jours", "2026-10-05", "2026-11-03"),
    ("Nombre d'étiquettes le 01/11/2026", "2026-11-01", "2026-11-01"),
    ("Bilan des étiquettes du 1/11/2026 au 3/11/2026", "2026-11-01", "2026-11-03"),
    ("Bilan des étiquettes du 2026-11-01 au 2026-11-03", "2026-11-01", "2026-11-03"),
    ("Combien avons-nous imprimé d'étiquettes aujourd'hui", "2026-11-03", "2026-11-03"),
])
def test_supported_questions_resolve_period_without_a_model(text, start, end):
    assert activity.is_haccp_activity_request(text)
    assert activity.activity_period(text, date(2026, 11, 3)) == (date.fromisoformat(start), date.fromisoformat(end))


@pytest.mark.parametrize("text", [
    "Nombre d'étiquettes par jour", "Nombre d'étiquettes demain",
    "Nombre d'étiquettes aujourd'hui et hier", "Nombre d'étiquettes du 03/11/2026 au 01/11/2026",
    "Nombre d'étiquettes le 30/02/2026", "Nombre d'étiquettes du 01/11/2026 au",
    "Nombre d'étiquettes ces 0 derniers jours", "Nombre d'étiquettes ces 367 derniers jours",
    "Nombre d'étiquettes ces -7 derniers jours", "Nombre d'étiquettes de saumon aujourd'hui",
    "Nombre d'étiquettes uniquement pour le restaurant A aujourd'hui",
    "Nombre d'étiquettes après 14h aujourd'hui", "Nombre d'étiquettes de préparation aujourd'hui",
])
def test_missing_ambiguous_dates_and_unsupported_filters_require_clarification(text):
    assert activity.is_haccp_activity_request(text)
    with pytest.raises(ValueError):
        activity.activity_period(text, date(2026, 11, 3))


@pytest.mark.parametrize("text", [
    "Ouvre HACCP", "Imprime une étiquette", "Crée une étiquette de préparation",
    "Combien de jours peut-on conserver le produit de cette étiquette ?",
    "Combien coûte une imprimante à étiquettes ?", "Nombre de calories sur cette étiquette",
    "Quels allergènes sur cette étiquette ?", "Combien de factures aujourd'hui ?",
])
def test_unrelated_label_questions_are_not_reclassified(text):
    assert not activity.is_haccp_activity_request(text)


def test_label_statistics_intent_never_calls_an_ai_provider(monkeypatch):
    import sirius_brain
    def no_provider(*args, **kwargs):
        pytest.fail("Label statistics intent must be resolved locally")
    monkeypatch.setattr(sirius_brain, "fast_provider", no_provider)
    text = "Affiche le nombre d'étiquettes aujourd'hui"
    assert asyncio.run(sirius_brain.parse_intent(text)) == {"action": "general", "query": text}


def test_period_reply_preserves_filters_and_does_not_hijack_other_questions():
    question = "Nombre d'étiquettes de saumon par jour"
    clarification = asyncio.run(activity.answer_activity_question(question, "user:one"))
    assert clarification["haccp_activity_pending"] == question
    history = [{"role": "user", "content": question}, {"role": "assistant", "content": clarification["answer"]}]
    resolved = activity.activity_question("hier", history)
    assert resolved == question + " hier"
    result = asyncio.run(activity.answer_activity_question(resolved, "user:one"))
    assert result["state"] == "CLARIFICATION_REQUIRED" and "sans filtre produit" in result["answer"]
    assert "haccp_activity" not in result and "haccp_activity_pending" not in result
    for text in ("Ouvre HACCP", "Imprime une étiquette aujourd'hui", "Quel temps demain ?", "hier pour le restaurant A"):
        assert activity.activity_question(text, history) is None
    assert activity.activity_question("hier", []) is None
    assert activity.activity_question("hier", history + [{"role": "user", "content": "Autre sujet"}]) is None


@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_real_chat_and_sse_use_scoped_counts_without_ai(store, monkeypatch, endpoint):
    import server
    db = LocalDocStore(store / "chat.sqlite3")
    async def user(request, _db):
        uid = request.headers.get("x-user")
        if not uid:
            raise HTTPException(401)
        return {"user_id": uid, **({"company_id": "kitchen"} if uid == "member" else {})}
    async def no_model(*args, **kwargs):
        pytest.fail("Stored counts must not call a model or a quota")
    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server, "require_user", user)
    monkeypatch.setattr(server, "_rate_ok", lambda *args, **kwargs: True)
    monkeypatch.setattr(server, "ask_sirius", no_model)
    monkeypatch.setattr(server, "require_personal", no_model)
    monkeypatch.setattr(server, "repondre_analyse", no_model)
    monkeypatch.setattr(server.usage_quota, "consume", no_model)
    monkeypatch.setattr(server.cloud_link, "should_relay_chat", lambda keys: True)
    monkeypatch.setattr(server.cloud_link, "relay_json", no_model)
    label(datetime(2026, 11, 3, 12))
    printed(datetime(2026, 11, 3, 12))
    label(datetime(2026, 11, 3, 12), "company:kitchen")
    label(datetime(2026, 11, 3, 13), "company:kitchen")
    app = FastAPI()
    app.include_router(server.api_router)
    body = {"text": "Combien d'étiquettes le 03/11/2026 ?", "session_id": "labels"}
    with TestClient(app) as client:
        assert client.post(endpoint, json=body).status_code == 401
        def result(uid, text=body["text"]):
            response = client.post(endpoint, json={**body, "text": text}, headers={"x-user": uid})
            assert response.status_code == 200, response.text
            if endpoint.endswith("/stream"):
                events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
                assert events[0]["text"] == events[-1]["answer"]
                return events[-1]
            return response.json()
        data = result("one")
        assert data["haccp_activity"]["etiquettes_enregistrees"] == 1
        assert data["haccp_activity"]["impressions_confirmees"] == 1
        assert data["work_state"] == "READ_ONLY" and data["used_search"] is False
        assert result("two")["haccp_activity"]["etiquettes_enregistrees"] == 0
        clarification = result("one", "Bilan des étiquettes par jour")
        assert clarification["work_state"] == "CLARIFICATION_REQUIRED"
        assert clarification["haccp_activity_pending"] == "Bilan des étiquettes par jour"
        assert result("one", "le 03/11/2026")["haccp_activity"]["etiquettes_enregistrees"] == 1
        assert client.post(endpoint, json=body, headers={"x-user": "member"}).status_code == 403
        asyncio.run(db.enterprise_members.insert_one({
            "company_id": "kitchen", "user_id": "member", "permissions": ["haccp"],
        }))
        assert result("member")["haccp_activity"]["etiquettes_enregistrees"] == 2
        intent = client.post("/api/intent", json={"text": body["text"]}, headers={"x-user": "one"})
        assert intent.status_code == 200 and intent.json()["action"] == "general"
    saved = asyncio.run(db.sirius_chats.find_one({"session_id": "one:labels"}))
    assert saved["user_id"] == "one" and "Étiquettes enregistrées : 1" in saved["history"][1]["content"]
