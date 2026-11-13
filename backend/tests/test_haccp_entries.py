import asyncio
import csv
import io
import uuid
from datetime import datetime
from decimal import Decimal
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session

import haccp_database
import routers.haccp_documents as document_routes
import routers.haccp_entries as entry_routes
from models.haccp import EtiquetteHaccp, HaccpDeliveryDocument
from schemas.haccp_documents import DeliveryLine
from tests.test_haccp_kitchen import CHEF, create_link, kitchen
from tests.test_haccp_labels import picture

API = "/api/haccp/receptions/entrees"


def add_document(
    *, name="Chez Daniel", scope="user:chef", day="2026-11-13",
    created=datetime(2026, 11, 13, 18), lines=None, kind="bon_livraison",
):
    identity = str(uuid.uuid4())
    document = {
        "type_document": kind, "fournisseur": "Fournisseur TEST", "reference": "BL-1",
        "date_document": day, "lignes": lines if lines is not None else [{
            "produit": "Crème", "lot": "L1", "categorie": "Produits Laitiers", "quantite": "3.2500", "unite": "kg",
        }],
        "incertitudes": [],
    }
    with Session(haccp_database.get_engine()) as db:
        db.add(HaccpDeliveryDocument(
            id=identity, scope_key=scope, restaurant_name=name, created_at=created,
            capture_id=str(uuid.uuid4()), capture_hash="a" * 64, image_path=f"uploads/test/{identity}.png",
            image_sha256="b" * 64, document=document,
        ))
        db.commit()
    return identity, document


def add_label(*, created=datetime(2026, 11, 13, 18), operation="reception", name="Chez Daniel"):
    with Session(haccp_database.get_engine()) as db:
        row = EtiquetteHaccp(
            scope_key="user:chef", restaurant_name=name, nom_produit="Saumon", numero_lot="S1",
            categorie="Poissons", image_path="uploads/test/label.png", created_at=created,
            type_operation=operation, poids_net={"valeur": "2.500", "unite": "kg"},
        )
        db.add(row)
        db.commit()
        return row.id


def entries(client, **params):
    return client.get(API, headers=CHEF, params={"restaurant_name": "Chez Daniel", "annee": 2026, **params})


@pytest.mark.parametrize("value,expected", [("2", "2"), ("3.2500", "3.2500"), (2, "2"), ("1E+2", "100")])
def test_received_quantities_remain_exact(value, expected):
    line = DeliveryLine(produit="Produit TEST", quantite=value, unite="kg")
    assert line.quantite == Decimal(expected)
    assert line.model_dump(mode="json")["quantite"] == expected


@pytest.mark.parametrize("value", [1.25, True, "NaN", "Infinity", "-2", "0", "2,5", "1.12345"])
def test_invalid_quantities_are_not_silently_accepted(value):
    with pytest.raises(ValidationError):
        DeliveryLine(quantite=value)


def test_partial_quantity_reading_preserves_the_document_with_an_explicit_warning(monkeypatch, caplog):
    monkeypatch.setattr(document_routes, "demander_document_vision", AsyncMock(return_value={
        "type_document": "facture", "lignes": [
            {"produit": "Crème", "lot": "C1", "quantite": 1.25, "unite": "kg"},
            {"produit": "Lait", "lot": "L1", "quantite": "12", "unite": "bouteilles"},
        ],
    }))
    document = asyncio.run(document_routes.read_delivery_document(picture(), "image/png"))
    assert document.lignes[0].quantite is None
    assert document.lignes[0].lot == "C1"
    assert document.lignes[1].quantite == Decimal("12")
    assert any("non enregistree" in message for message in document.incertitudes)
    assert "invalides" in caplog.text


def test_invalid_unit_stays_unknown_without_discarding_an_exact_read_quantity(monkeypatch):
    monkeypatch.setattr(document_routes, "demander_document_vision", AsyncMock(return_value={
        "type_document": "bon_livraison", "lignes": [{"produit": "Riz", "quantite": "2.50", "unite": 12}],
    }))
    document = asyncio.run(document_routes.read_delivery_document(picture(), "image/png"))
    assert document.lignes[0].quantite == Decimal("2.50")
    assert document.lignes[0].unite is None
    assert any("non enregistree" in message for message in document.incertitudes)


def test_other_invalid_document_fields_are_not_hidden_by_quantity_recovery(monkeypatch):
    monkeypatch.setattr(document_routes, "demander_document_vision", AsyncMock(return_value={
        "type_document": "facture", "reference": 42, "lignes": [{"produit": "Riz", "quantite": -1.5}],
    }))
    with pytest.raises(document_routes.VisionAnalysisError, match="Lecture du document invalide"):
        asyncio.run(document_routes.read_delivery_document(picture(), "image/png"))


def test_document_capture_automatically_records_its_entries_without_rewriting_old_archives(kitchen, monkeypatch):
    client = kitchen.client
    _, headers = create_link(client)
    parsed = {
        "type_document": "facture", "date_document": "2026-10-31", "reference": "F-1",
        "lignes": [{"produit": "Riz", "lot": "R1", "categorie": "Épicerie", "quantite": "12", "unite": "sacs"}],
    }
    reader = AsyncMock(return_value=parsed)
    monkeypatch.setattr(document_routes, "demander_document_vision", reader)
    capture_id = str(uuid.uuid4())
    data = {"capture_id": capture_id, "restaurant_name": "Ailleurs"}
    first = client.post("/api/haccp/receptions/documents", headers=headers, data=data,
                        files={"file": ("invoice.png", picture(), "image/png")})
    second = client.post("/api/haccp/receptions/documents", headers=headers, data=data,
                         files={"file": ("invoice.png", picture(), "image/png")})
    assert first.status_code == second.status_code == 201
    assert first.json()["lignes"][0]["quantite"] == "12"
    assert first.json()["id"] == second.json()["id"]
    assert reader.await_count == 1
    page = entries(client, mois=10).json()
    assert page["total"] == 1
    assert page["items"][0]["unite"] == "sacs"
    assert page["items"][0]["date"] == "2026-10-31"
    identity, original = add_document(day="2026-10-01", lines=[{"produit": "Ancien produit", "lot": None}])
    old_page = entries(client, mois=10).json()
    old_line = next(item for item in old_page["items"] if identity in item["id"])
    assert old_line["quantite"] is None and old_line["unite"] is None
    with Session(haccp_database.get_engine()) as db:
        assert db.get(HaccpDeliveryDocument, identity).document == original


def test_year_month_filters_and_photo_dates_use_paris_without_guessing_delivery_dates(kitchen):
    client = kitchen.client
    add_document(day="2025-12-31", created=datetime(2026, 1, 3, 12))
    add_document(day=None, created=datetime(2025, 12, 31, 23, 30))
    add_label(created=datetime(2026, 1, 31, 23, 30))
    add_label(created=datetime(2026, 2, 1, 12), operation="ouverture")
    add_label(created=datetime(2026, 2, 1, 12), operation="preparation")
    december = entries(client, annee=2025, mois=12).json()
    assert december["total"] == 1
    assert december["items"][0]["origine_date"] == "document"
    january = entries(client, mois=1).json()
    assert january["total"] == 1
    assert january["items"][0]["date"] == "2026-01-01"
    assert january["items"][0]["origine_date"] == "photo"
    february = entries(client, mois=2).json()
    assert february["total"] == 1
    assert february["items"][0]["source"] == "etiquette"
    assert february["items"][0]["date"] == "2026-02-01"
    assert february["items"][0]["quantite"] is None
    assert february["items"][0]["unite"] is None
    annual = entries(client).json()
    assert annual["total"] == 2
    assert 2025 in annual["annees"] and 2026 in annual["annees"]
    assert entries(client, annee=9999, mois=12).json()["total"] == 0


def test_entries_are_scoped_to_the_establishment_and_qr_export_stays_chef_only(kitchen):
    client = kitchen.client
    add_document()
    add_document(name="Autre établissement")
    add_document(scope="user:autre")
    add_document(kind="inconnu")
    _, headers = create_link(client)
    kitchen_page = client.get(API, headers=headers, params={
        "restaurant_name": "Autre établissement", "annee": 2026,
    })
    assert kitchen_page.status_code == 200
    assert kitchen_page.json()["restaurant_name"] == "Chez Daniel"
    assert kitchen_page.json()["total"] == 1
    assert kitchen_page.headers["cache-control"] == "private, no-store"
    assert client.get(API).status_code == 401
    assert client.get(API + "/export-csv", headers=headers,
                      params={"restaurant_name": "Chez Daniel"}).status_code == 403
    other_page = client.get(API, headers={"x-test-user": "autre"}, params={
        "restaurant_name": "Chez Daniel", "annee": 2026,
    }).json()
    assert other_page["total"] == 1
    assert other_page["items"][0]["id"] != kitchen_page.json()["items"][0]["id"]


def test_whole_year_pagination_and_csv_are_complete_beyond_document_list_limit(kitchen):
    client = kitchen.client
    for _ in range(65):
        add_document(lines=[
            {"produit": "Crème", "lot": "C1", "categorie": "Produits Laitiers", "quantite": "3.2500", "unite": "kg"},
            {"produit": "Lait", "lot": None, "categorie": "Produits Laitiers"},
        ])
    first = entries(client).json()
    assert first["total"] == 130 and len(first["items"]) == 25
    seen = {item["id"] for item in first["items"]}
    for offset in range(25, 130, 25):
        page = entries(client, offset=offset).json()
        assert page["total"] == 130
        assert len(page["items"]) == min(25, 130 - offset)
        ids = {item["id"] for item in page["items"]}
        assert not seen.intersection(ids)
        seen.update(ids)
    assert len(seen) == 130
    csv_response = client.get(API + "/export-csv", headers=CHEF, params={
        "restaurant_name": "Chez Daniel", "annee": 2026,
    })
    assert csv_response.status_code == 200
    assert "entrees_chez-daniel_2026.csv" in csv_response.headers["content-disposition"]
    assert csv_response.text.startswith("\ufeff")
    rows = list(csv.reader(io.StringIO(csv_response.text.lstrip("\ufeff")), delimiter=";"))
    assert len(rows) == 131
    assert rows[0][:7] == ["Date", "Établissement", "Famille", "Produit", "Quantité", "Unité", "Lot"]
    assert rows[1][4:6] == ["3,2500", "kg"]
    assert rows[2][4:7] == ["Non lue", "Non lue", "Non lu"]


def test_entry_csv_quotes_spreadsheet_formulas_and_does_not_mix_establishments(kitchen):
    add_document(lines=[{"produit": "=SUM(1;2)", "lot": "@lot", "quantite": "2", "unite": "=unite"}])
    add_document(name="Ailleurs", lines=[{"produit": "Ne pas exporter"}])
    response = kitchen.client.get(API + "/export-csv", headers=CHEF, params={
        "restaurant_name": "Chez Daniel", "annee": 2026, "mois": 11,
    })
    assert response.status_code == 200
    assert "entrees_chez-daniel_2026-11.csv" in response.headers["content-disposition"]
    row = list(csv.reader(io.StringIO(response.text.lstrip("\ufeff")), delimiter=";"))[1]
    assert row[3] == "'=SUM(1;2)" and row[5] == "'=unite" and row[6] == "'@lot"
    assert "Ne pas exporter" not in response.text


@pytest.mark.parametrize("params", [
    {"mois": 0}, {"mois": 13}, {"annee": 0}, {"annee": 10000}, {"offset": -1}, {"limit": 101},
])
def test_invalid_period_or_page_parameters_are_explicitly_refused(kitchen, params):
    assert entries(kitchen.client, **params).status_code == 422


def test_corrupt_archive_failure_is_explicit_and_does_not_become_an_empty_register(kitchen, caplog):
    add_document(lines=[{"produit": "Riz", "quantite": "-1", "unite": "sacs"}])
    response = entries(kitchen.client)
    assert response.status_code == 500
    assert "indisponible" in response.json()["detail"]
    assert "Lecture du registre impossible" in caplog.text


def test_packaged_backend_forwards_entries_and_csv_to_the_same_cloud_scope(kitchen, monkeypatch):
    page = {
        "restaurant_name": "Chez Daniel", "annee": 2026, "mois": None, "annees": [2026],
        "offset": 0, "limit": 25, "total": 0, "items": [],
    }
    relay = AsyncMock(side_effect=[
        httpx.Response(200, json=page),
        httpx.Response(200, content=b"Date;Produit\r\n", headers={"Content-Type": "text/csv; charset=utf-8"}),
    ])
    monkeypatch.setattr(entry_routes.cloud_link, "relay_allowed", lambda: True)
    monkeypatch.setattr(entry_routes.cloud_link, "relay_haccp_registry", relay)
    monkeypatch.setattr(entry_routes, "entry_register", Mock(side_effect=AssertionError("No local stock read")))
    assert entries(kitchen.client).json() == page
    exported = kitchen.client.get(API + "/export-csv", headers=CHEF, params={
        "restaurant_name": "Chez Daniel", "annee": 2026,
    })
    assert exported.content == b"Date;Produit\r\n"
    assert relay.call_args_list[0].kwargs["params"]["restaurant_name"] == "Chez Daniel"
    assert relay.call_args_list[1].args == ("GET", "/receptions/entrees/export-csv")


def test_cloud_html_or_missing_type_cannot_be_disguised_as_a_successful_csv(kitchen, monkeypatch, caplog):
    monkeypatch.setattr(entry_routes.cloud_link, "relay_allowed", lambda: True)
    monkeypatch.setattr(entry_routes.cloud_link, "relay_haccp_registry", AsyncMock(side_effect=[
        httpx.Response(200, content=b"<html>Cloud website</html>", headers={"Content-Type": "text/html"}),
        httpx.Response(200, content=b"Date;Produit\r\n"),
    ]))
    for _ in range(2):
        response = kitchen.client.get(API + "/export-csv", headers=CHEF, params={
            "restaurant_name": "Chez Daniel", "annee": 2026,
        })
        assert response.status_code == 502
        assert "fichier des entrees Cloud est invalide" in response.json()["detail"]
    assert "contenu non CSV" in caplog.text
