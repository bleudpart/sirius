import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import URL, func, select
from sqlalchemy.orm import Session

from finance_database import create_finance_engine, get_db
from models.finance import (
    CashMovement, CompanyProfile, FinanceAuditEvent, FinanceIngestionItem, TransactionRevenue,
)
from routers.finance import make_company_finance_router
from schemas.finance import SectorEnum

MEMBERS = {("u1", "a"): "manager", ("u1", "c"): "admin", ("u2", "b"): "admin", ("viewer", "a"): "viewer"}
USER = {"x-test-user": "u1"}
JSON = {"Content-Type": "application/json"}
REVENUES = "/api/finance/a/entries/revenues"
REVENUE = {"date": "2026-01-15", "amount_ht": "1000.10", "vat_rate": "20", "payment_method": "CARD"}


def _raw(payload):
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def post(client, kind, payload, *, company="a", user="u1"):
    return client.post(
        f"/api/finance/{company}/entries/{kind}", content=_raw(payload), headers=JSON | {"x-test-user": user},
    )


@pytest.fixture
def engine(tmp_path):
    engine = create_finance_engine(URL.create("sqlite", database=str(tmp_path / "finance.sqlite3")))
    with Session(engine) as session:
        session.add_all([
            CompanyProfile(id="a", name="Entreprise A", sector=SectorEnum.SERVICES, currency="EUR"),
            CompanyProfile(id="b", name="Entreprise B", sector=SectorEnum.RETAIL, currency="EUR"),
        ])
        session.commit()
    yield engine
    engine.dispose()


@pytest.fixture
def client(engine):
    def member(query):
        role = MEMBERS.get((query["user_id"], query["company_id"]))
        return {"role": role} if role else None

    database = SimpleNamespace(enterprise_members=SimpleNamespace(find_one=AsyncMock(side_effect=member)))

    async def require_user(request, _database):
        user = request.headers.get("x-test-user")
        if not user:
            raise HTTPException(401, "Authentification requise.")
        return {"user_id": user}

    def session_dependency():
        with Session(engine) as session:
            yield session

    app = FastAPI()
    app.include_router(make_company_finance_router(database, require_user), prefix="/api")
    app.dependency_overrides[get_db] = session_dependency
    with TestClient(app) as test_client:
        yield test_client


def test_revenue_ttc_is_computed_by_the_server_and_listed_as_manual(client):
    response = post(client, "revenues", REVENUE)
    assert response.status_code == 201
    entry = response.json()
    assert entry["kind"] == "revenues" and entry["origin"] == "manual"
    assert entry["values"]["amount_ht"] == "1000.10"
    assert entry["values"]["amount_ttc"] == "1200.12"
    assert entry["values"]["vat_rate"] == "20.0000"
    assert "company_id" not in entry["values"]
    assert client.get(REVENUES, headers=USER).json() == {"kind": "revenues", "truncated": False, "entries": [entry]}


def test_json_numbers_are_read_as_exact_decimals_never_floats(client):
    raw = b'{"date":"2026-01-15","amount_ht":1234567890.12,"vat_rate":5.5,"payment_method":"CASH"}'
    response = client.post(REVENUES, content=raw, headers=JSON | USER)
    assert response.status_code == 201
    assert response.json()["values"]["amount_ht"] == "1234567890.12"
    assert response.json()["values"]["amount_ttc"] == "1302469124.08"


def test_expense_vat_comes_from_rate_or_amount_and_may_be_non_deductible(client):
    by_rate = post(client, "expenses", {
        "date": "2026-01-10", "supplier": "Metro", "amount_ht": "100.00", "vat_rate": "5.5",
        "category": "MATIERE_PREMIERE", "allocation": "FOOD",
    })
    assert by_rate.status_code == 201
    assert {k: by_rate.json()["values"][k] for k in ("amount_vat", "amount_ttc", "deductible_vat")} == {
        "amount_vat": "5.50", "amount_ttc": "105.50", "deductible_vat": "5.50",
    }
    by_amount = post(client, "expenses", {
        "date": "2026-01-11", "supplier": "Restaurant", "amount_ht": "50.00", "amount_vat": "5.00",
        "vat_deductible": False, "category": "FRAIS_GENERAUX",
    })
    assert by_amount.status_code == 201
    assert by_amount.json()["values"]["amount_ttc"] == "55.00"
    assert by_amount.json()["values"]["deductible_vat"] == "0.00"
    both = post(client, "expenses", {
        "date": "2026-01-11", "supplier": "X", "amount_ht": "1.00", "vat_rate": "20", "amount_vat": "0.20",
        "category": "FOURNITURES",
    })
    assert both.status_code == 422
    assert both.json()["detail"] == "Renseigner soit le taux de TVA, soit le montant de TVA, pas les deux."


@pytest.mark.parametrize(("payload", "message"), [
    (REVENUE | {"amount_ttc": "1200.12"}, "Montant TTC : champ non autorisé"),
    (REVENUE | {"company_id": "b"}, "Entreprise : champ non autorisé"),
    ({key: value for key, value in REVENUE.items() if key != "date"}, "Date : champ obligatoire"),
    (REVENUE | {"amount_ht": "1.001"}, "Montant HT : 2 décimales au maximum"),
    (REVENUE | {"vat_rate": "120"}, "Taux de TVA : doit être inférieur ou égal à 100"),
    (REVENUE | {"payment_method": "BITCOIN"}, "Moyen de paiement : valeur non autorisée"),
    (REVENUE | {"date": "2026-02-30"}, "Date : Date calendaire ISO"),
], ids=["ttc", "company", "missing-date", "cents", "vat-rate", "payment", "calendar"])
def test_validation_errors_are_explicit_and_in_french(client, payload, message):
    response = post(client, "revenues", payload)
    assert response.status_code == 422
    assert response.json()["detail"].startswith(message)


@pytest.mark.parametrize(("content", "headers", "status", "detail"), [
    (b"date=2026-01-15", {"Content-Type": "text/plain"}, 415, "Content-Type requis : application/json."),
    (b"[]", JSON, 422, "Un objet JSON est attendu."),
    (b'{"amount_ht": NaN}', JSON, 400, "Valeur JSON non finie interdite : NaN."),
    (b'{"date": "2026-01-15", "date": "2026-01-16"}', JSON, 400, "Clé JSON en double."),
    (b"[" * 5000, JSON, 400, "JSON invalide : imbrication de plus de 64 niveaux."),
    (b'{"label": ' + b"[" * 64 + b"]" * 64 + b"}", JSON, 400, "JSON invalide : imbrication de plus de 64 niveaux."),
    (b'{"amount_ht": ' + b"9" * 5000 + b"}", JSON, 400, "JSON invalide : nombre hors limites."),
    (b"\xff", JSON, 400, "Encodage UTF-8 requis."),
    (b'{"date": ', JSON, 400, "JSON invalide (ligne 1, colonne 10)."),
    (b'{"label": "' + b"x" * (64 * 1024) + b'"}', JSON, 413, "Charge utile supérieure à 64 Kio."),
], ids=[
    "content-type", "array", "nan", "duplicate-key", "nesting", "deep-balanced", "huge-int", "utf8", "syntax",
    "too-large",
])
def test_json_transport_errors_never_reach_the_ledger(client, engine, content, headers, status, detail):
    response = client.post(REVENUES, content=content, headers=headers | USER)
    assert (response.status_code, response.json()["detail"]) == (status, detail)
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(TransactionRevenue)) == 0


def test_duplicate_snapshots_conflict_without_partial_writes(client, engine):
    inventory = {"date": "2026-01-01", "allocation": "MERCHANDISE", "value": "12.00"}
    assert post(client, "inventories", inventory).status_code == 201
    conflict = post(client, "inventories", inventory | {"value": "13.00"})
    assert conflict.status_code == 409 and conflict.json()["detail"].startswith("Un inventaire existe déjà")
    sheet = {"date": "2025-12-31", "equity": "-1500.00", "financial_debt": "20000.00", "cash": "3000.00"}
    assert post(client, "balance_sheets", sheet).status_code == 201
    assert post(client, "balance_sheets", sheet | {"equity": "10.00"}).status_code == 409
    balance = {"date": "2026-01-01", "amount": "-250.00"}
    assert post(client, "cash_balances", balance).status_code == 201
    assert post(client, "cash_balances", balance).status_code == 409
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(FinanceAuditEvent)) == 3


def test_companies_are_isolated_and_roles_are_enforced(client, engine):
    created = post(client, "revenues", REVENUE).json()
    own_url = f"/api/finance/a/entries/revenues/{created['id']}"
    assert client.delete(own_url).status_code == 401
    assert client.delete(own_url, headers={"x-test-user": "u2"}).status_code == 404
    other = client.delete(f"/api/finance/b/entries/revenues/{created['id']}", headers={"x-test-user": "u2"})
    assert other.status_code == 404 and other.json()["detail"] == "Écriture introuvable pour cette entreprise."
    assert client.get("/api/finance/b/entries/revenues", headers={"x-test-user": "u2"}).json()["entries"] == []
    viewer = {"x-test-user": "viewer"}
    for path in (REVENUES, "/api/finance/a/audit", "/api/finance/a/profile"):
        assert client.get(path, headers=viewer).status_code == 403
    # Les droits sont vérifiés avant même la lecture du corps.
    assert client.post(REVENUES, content=b"not json", headers={"Content-Type": "text/plain"} | viewer).status_code == 403
    assert client.delete(own_url, headers=viewer).status_code == 403
    with Session(engine) as session:
        assert session.get(TransactionRevenue, created["id"]) is not None


def test_deleting_an_imported_entry_removes_its_link_and_is_audited(client, engine):
    statement = "Date;Libellé;Débit;Crédit\n2026-01-10;Fournisseur Durand;60,00;\n".encode("utf-8")
    imported = client.post(
        "/api/finance/a/ingestions/bank_statement_csv", content=statement,
        headers={"Content-Type": "text/csv"} | USER,
    )
    assert imported.status_code == 200
    listed = client.get("/api/finance/a/entries/cash_movements", headers=USER).json()["entries"]
    assert [(entry["origin"], entry["values"]["amount"]) for entry in listed] == [("bank_statement_csv", "-60.00")]
    assert client.delete(f"/api/finance/a/entries/cash_movements/{listed[0]['id']}", headers=USER).status_code == 204
    with Session(engine) as session:
        assert session.scalars(select(FinanceIngestionItem)).all() == []
        assert session.scalars(select(CashMovement)).all() == []
    # SQLite peut réattribuer l'identifiant supprimé : aucun lien d'import périmé ne doit requalifier la saisie manuelle.
    manual = post(client, "cash_movements", {"date": "2026-01-11", "amount": "-5.00", "label": "Frais"})
    assert manual.json()["origin"] == "manual"
    events = client.get("/api/finance/a/audit", headers=USER).json()["events"]
    assert [(event["action"], event["entry_kind"], event["actor"]) for event in events] == [
        ("create", "cash_movements", "u1"), ("delete", "cash_movements", "u1"), ("import", "bank_statement_csv", "u1"),
    ]
    assert "Fournisseur Durand" in events[1]["summary"]
    assert events[2]["entry_id"] == imported.json()["batch_id"]
    assert all(event["created_at"].endswith("Z") for event in events)


def test_profile_lifecycle_and_currency_lock(client):
    url = "/api/finance/c/profile"
    assert client.get(url, headers=USER).json() == {"profile": None}
    missing = post(client, "revenues", REVENUE, company="c")
    assert missing.status_code == 404 and "créez-le" in missing.json()["detail"]
    created = client.put(url, content=_raw({"name": "Bistrot du Port", "sector": "HOSPITALITY"}), headers=JSON | USER)
    assert created.status_code == 200
    assert created.json() == {"id": "c", "name": "Bistrot du Port", "sector": "HOSPITALITY", "currency": "EUR"}
    swiss = {"name": "Bistrot du Port", "sector": "HOSPITALITY", "currency": "CHF"}
    assert client.put(url, content=_raw(swiss), headers=JSON | USER).status_code == 200
    assert post(client, "revenues", REVENUE, company="c").status_code == 201
    locked = client.put(url, content=_raw(swiss | {"currency": "EUR"}), headers=JSON | USER)
    assert locked.status_code == 409 and locked.json()["detail"].startswith("Devise verrouillée")
    invalid = client.put(url, content=_raw(swiss | {"sector": "BANQUE"}), headers=JSON | USER)
    assert invalid.status_code == 422 and invalid.json()["detail"].startswith("Secteur : valeur non autorisée")
    assert client.get(url, headers=USER).json()["profile"]["currency"] == "CHF"
    events = client.get("/api/finance/c/audit", headers=USER).json()["events"]
    assert [event["action"] for event in events] == ["create", "profile", "profile"]


def test_entry_lists_filter_dates_overlap_overheads_and_truncate(client):
    for day in ("2026-01-05", "2026-01-20", "2026-02-03"):
        assert post(client, "revenues", REVENUE | {"date": day}).status_code == 201
    january = client.get(REVENUES + "?start_date=2026-01-01&end_date=2026-01-31", headers=USER).json()
    assert [entry["values"]["date"] for entry in january["entries"]] == ["2026-01-20", "2026-01-05"]
    limited = client.get(REVENUES + "?limit=2", headers=USER).json()
    assert limited["truncated"] is True and len(limited["entries"]) == 2
    for query in ("?limit=0", "?limit=501", "?start_date=2026-02-30", "?start_date=2026-02-01&end_date=2026-01-01"):
        assert client.get(REVENUES + query, headers=USER).status_code == 422
    assert post(client, "overheads", {
        "label": "Ancien loyer", "category": "RENT", "monthly_amount_ht": "800.00",
        "active_from": "2025-01-01", "active_to": "2025-12-31",
    }).status_code == 201
    assert post(client, "overheads", {
        "label": "Loyer", "category": "RENT", "monthly_amount_ht": "900.00", "active_from": "2026-01-01",
    }).status_code == 201
    current = client.get("/api/finance/a/entries/overheads?start_date=2026-01-01", headers=USER).json()
    assert [entry["values"]["label"] for entry in current["entries"]] == ["Loyer"]


def test_manual_entries_feed_the_dashboard_and_its_comparison(client):
    assert post(client, "revenues", REVENUE).status_code == 201
    assert post(client, "revenues", REVENUE | {"date": "2025-01-10", "amount_ht": "500.00"}).status_code == 201
    response = client.get(
        "/api/finance/a/dashboard?start_date=2026-01-01&end_date=2026-01-31&comparison=year_ago", headers=USER,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["common"]["revenue_ht"] == "1000.10"
    assert body["comparison"]["mode"] == "year_ago"
    assert body["comparison"]["period"] == {"start_date": "2025-01-01", "end_date": "2025-01-31"}
    revenue = next(item for item in body["comparison"]["variations"] if item["key"] == "revenue_ht")
    assert revenue == {
        "key": "revenue_ht", "current": "1000.10", "previous": "500.00", "change": "500.10", "change_pct": "100.02",
    }
    none = client.get(
        "/api/finance/a/dashboard?start_date=2026-01-01&end_date=2026-01-31&comparison=none", headers=USER,
    )
    assert none.status_code == 200 and none.json()["comparison"] is None


@pytest.mark.parametrize(("query", "status"), [
    ("start_date=2016-01-02&end_date=2026-01-01", 200),
    ("start_date=2016-01-01&end_date=2026-01-01", 422),
    ("start_date=2026-01-01&end_date=2026-01-31&comparison=bogus", 422),
])
def test_dashboard_period_is_limited_to_ten_years(client, query, status):
    assert client.get("/api/finance/a/dashboard?" + query, headers=USER).status_code == status
