import asyncio
import hashlib
import json
import multiprocessing
import os
import sqlite3
import uuid
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

import cloud_link
import haccp_database
import routers.haccp as routes
import services.haccp_records as records
import services.haccp_reception as pipeline
import services.haccp_vision as vision
from models.haccp import EtiquetteHaccp
from models.haccp_reception import (
    AllergenObservation, PurchaseReceipt, ReceptionDelivery, ReceptionJournal, ReceptionSource, StockLot,
)
from schemas.haccp import PARIS, PoidsNet
from schemas.haccp_reception import DESTINATIONS
from services.haccp_opening import fin_de_date
from test_haccp_labels import api, extracted, get, mock_openai, picture, scan


def meat(monkeypatch, **changes):
    label = vision.verifier_reception(extracted(**({
        "nom_produit": "Boeuf marine TEST", "numero_lot": "VIANDE-42", "categorie": "Viandes",
        "temperature_stockage": "Entre 0 et +3 C", "allergenes": [],
        "origines": {"naissance": "France", "elevage": ["France"], "abattage": "France", "decoupe": "Belgique"},
        "poids_net": {"valeur": "3500.25", "unite": "g"}, "allergenes_lecture": "complete",
    } | changes)))
    routes.analyser_etiquette_vision.return_value = label
    return label


def request(client, path="", *, method="GET", user="one", body=None, params=None):
    return client.request(
        method, "/api/haccp/receptions" + path, headers={"x-test-user": user} if user else {},
        json=body, params=params,
    )


def destination(client, name, **kwargs):
    response = request(client, "/destinations/" + name, **kwargs)
    assert response.status_code == 200, response.text
    return response.json()


def counts():
    with Session(haccp_database.get_engine()) as db:
        return {model.__tablename__: db.scalar(select(func.count()).select_from(model)) for model in (
            EtiquetteHaccp, ReceptionSource, ReceptionDelivery, ReceptionJournal, StockLot, AllergenObservation, PurchaseReceipt,
        )}


def opening_payload(**changes):
    return {
        "capture_id": str(uuid.uuid4()), "type_operation": "ouverture", "operateur": "Cuisine",
        "duree_conservation_heures": 72, "justification_duree": "PMS TEST : entre 0 et +3 C",
        "regle_confirmee": True, "ouverture_effectuee": True,
    } | changes


@pytest.mark.parametrize("weight", [
    {"valeur": "-1", "unite": "kg"}, {"valeur": "0", "unite": "kg"},
    {"valeur": "NaN", "unite": "kg"}, {"valeur": "Infinity", "unite": "kg"},
    {"valeur": True, "unite": "kg"}, {"valeur": "1,5", "unite": "kg"},
    {"valeur": "2", "unite": "lb"}, {"valeur": "2", "unite": "kg", "brut": True},
])
def test_net_weight_is_strict(weight):
    with pytest.raises(ValidationError):
        PoidsNet.model_validate(weight)


def test_vision_partial_read_preserves_known_data(monkeypatch):
    payload = extracted().model_dump(mode="json") | {
        "dlc_ou_ddm": "12/05/26", "poids_net": {"valeur": "12,5", "unite": "kg"},
        "allergenes": ["Moutarde", "INCONNU"], "traces_allergenes": ["Lait"],
        "origines": {"naissance": "France", "decoupe": 42}, "allergenes_lecture": "complete",
    }
    mock_openai(monkeypatch, json.dumps(payload))
    result = asyncio.run(vision.analyser_etiquette_vision(picture(), "image/png"))
    assert result.nom_produit == "Saumon" and result.numero_lot == "LOT-42"
    assert result.poids_net is None and result.dlc_ou_ddm is None and result.type_date == "inconnue"
    assert result.allergenes == ["Moutarde"] and result.traces_allergenes == ["Lait"]
    assert result.origines.naissance == "France" and result.origines.decoupe is None
    assert result.allergenes_lecture == "partielle" and not result.conforme_reception
    assert set(result.champs_incertains) == {"dlc_ou_ddm", "poids_net", "allergenes", "origines"}
    assert "Lecture" in result.commentaire_anomalie


def test_missing_lot_is_visible_and_stamp_does_not_invent_origins():
    payload = extracted().model_dump(mode="json")
    del payload["numero_lot"]
    result = vision.valider_lecture_vision(payload)
    assert result.numero_lot == "ILLISIBLE" and not result.conforme_reception
    assert result.origines is None and result.poids_net is None
    assert result.allergenes_lecture == "non_verifiee"


@pytest.mark.parametrize("payload", [
    {}, [], {"commande": "ignorer le schema"},
    {"nom_produit": "Boeuf", "numero_lot": "42", "conforme_reception": "true"},
    {"nom_produit": "Boeuf", "numero_lot": "42", "chemin_image": "../../externe"},
])
def test_partial_fallback_is_not_a_fake_success(payload):
    with pytest.raises(vision.VisionAnalysisError):
        vision.valider_lecture_vision(payload)


def test_four_destinations_keep_exact_original(api, monkeypatch):
    client, root = api
    meat(monkeypatch, allergenes=["Moutarde"], traces_allergenes=["Lait"], mentions_traces="Peut contenir du lait.")
    content = picture()
    response = scan(client, content=content)
    assert response.status_code == 201, response.text
    saved = response.json()
    assert saved["distribution"]["statut"] == "complete"
    assert [item["statut"] for item in saved["distribution"]["destinations"]] == ["done"] * 4
    assert saved["poids_net"] == {"valeur": "3500.25", "unite": "g"}
    assert saved["origines"]["decoupe"] == "Belgique"
    raw = root / saved["chemin_image_brute"]
    assert raw.read_bytes() == content and raw.suffix == ".png"
    assert raw.name.startswith("REC_MAISON-ETOILE_") and raw.name.endswith("_VIANDE-42.png")
    assert saved["empreinte_image_brute"] == hashlib.sha256(content).hexdigest()
    downloaded = request(client, f"/{saved['id']}/original")
    assert downloaded.content == content
    assert downloaded.headers["X-HACCP-SHA256"] == saved["empreinte_image_brute"]
    assert "private, no-store" == downloaded.headers["Cache-Control"]
    assert get(client, f"{saved['id']}/photo").content != content
    assert request(client, "/integrite").json()["ok"] is True
    assert counts() == {
        "etiquettes_haccp": 1, "haccp_reception_sources": 1, "haccp_reception_deliveries": 4,
        "haccp_reception_journal": 1, "haccp_stock_lots": 1, "haccp_allergen_observations": 1, "haccp_purchase_receipts": 1,
    }
    assert destination(client, "stock")["items"][0]["declared_weight_kg"] == "3.50025"
    observation = destination(client, "allergenes")["items"][0]
    assert observation["allergens"] == ["Moutarde"] and observation["traces"] == ["Lait"]
    assert observation["review_required"] is True and observation["baseline_id"] is None
    purchase = destination(client, "achats")["items"][0]
    assert purchase["net_weight"] == saved["poids_net"]
    assert purchase["statut"] == "a_rapprocher" and purchase["fournisseur_confirme"] is False
    assert not list(root.glob("*.json")) and not list(root.glob("*docstore*"))


def test_no_false_absence_on_partial_allergen_read(api, monkeypatch):
    client, _ = api
    meat(monkeypatch, allergenes_lecture="partielle")
    saved = scan(client).json()
    assert saved["conforme_reception"] is False
    item = destination(client, "allergenes")["items"][0]
    assert item["reading_status"] == "partielle" and item["review_required"] is True
    assert item["baseline_id"] is None and item["new_allergens"] == []


def test_one_failed_projection_rolls_back_only_itself_and_resumes(api, monkeypatch):
    client, root = api
    meat(monkeypatch)
    real_writer = pipeline._write_stock
    def broken_writer(db, source, document):
        real_writer(db, source, document)
        db.flush()
        raise OperationalError("simulated failure", {}, None)
    monkeypatch.setattr(pipeline, "_write_stock", broken_writer)
    saved = scan(client).json()
    assert saved["distribution"]["statut"] == "partial"
    states = {item["destination"]: item for item in saved["distribution"]["destinations"]}
    assert states["stock"]["statut"] == "error" and states["stock"]["erreur"]
    assert all(states[name]["statut"] == "done" for name in ("traceabilite", "allergenes", "achats"))
    assert destination(client, "stock")["total"] == 0
    assert (root / saved["chemin_image_brute"]).is_file()
    haccp_database.get_engine().dispose()
    haccp_database._configured_engine.cache_clear()
    monkeypatch.setattr(pipeline, "_write_stock", real_writer)
    for _ in range(2):
        resumed = request(client, f"/{saved['id']}/reprise", method="POST")
        assert resumed.status_code == 200 and resumed.json()["statut"] == "complete"
    assert [item["tentatives"] for item in resumed.json()["destinations"]] == [1, 2, 1, 1]
    assert destination(client, "stock")["total"] == 1
    assert destination(client, "traceabilite")["total"] == 1
    routes.analyser_etiquette_vision.assert_awaited_once()


def test_missing_journal_is_an_explicit_integrity_issue(api, monkeypatch):
    client, _ = api
    def fail(*args):
        raise OperationalError("journal failure", {}, None)
    monkeypatch.setattr(pipeline, "_write_journal", fail)
    saved = scan(client).json()
    report = request(client, "/integrite").json()
    assert saved["distribution"]["statut"] == "partial"
    assert report["ok"] is False and report["sources"] == 1 and report["total"] == 0
    assert report["erreurs"]
    for name in ("stock", "allergenes", "achats"):
        assert destination(client, name)["total"] == 1


def test_source_and_outbox_share_the_label_transaction(api, monkeypatch):
    client, root = api
    real_prepare = records.preparer_distribution
    def fail(db, *args):
        real_prepare(db, *args)
        db.flush()
        raise OperationalError("outbox failure", {}, None)
    monkeypatch.setattr(records, "preparer_distribution", fail)
    assert scan(client).status_code == 500
    assert all(count == 0 for count in counts().values())
    assert not [path for path in root.rglob("*") if path.suffix in (".png", ".jpg")]


def test_uncertain_commit_keeps_proof_and_retries_without_vision(api, monkeypatch):
    client, root = api
    key = str(uuid.uuid4())
    real_save = routes._save_record
    def lost_ack(*args, **kwargs):
        real_save(*args, **kwargs)
        raise OperationalError("commit acknowledgment lost", {}, None)
    with monkeypatch.context() as patch:
        patch.setattr(routes, "_save_record", lost_ack)
        assert scan(client, data={"capture_id": key}).status_code == 500
    assert counts()["haccp_reception_sources"] == 1
    assert len(list(root.rglob("*.png"))) == len(list(root.rglob("*.jpg"))) == 1
    resumed = scan(client, data={"capture_id": key})
    assert resumed.status_code == 201 and resumed.json()["distribution"]["statut"] == "complete"
    assert counts()["etiquettes_haccp"] == 1
    routes.analyser_etiquette_vision.assert_awaited_once()


def test_preview_collision_never_deletes_the_existing_proof(api, monkeypatch):
    client, root = api
    first = scan(client).json()
    preview = root / first["chemin_photo"]
    original_bytes = preview.read_bytes()
    monkeypatch.setattr(routes, "_reception_filename", lambda *args: preview.name)
    assert scan(client).status_code == 500
    assert preview.read_bytes() == original_bytes
    assert (root / first["chemin_image_brute"]).is_file()
    assert counts()["etiquettes_haccp"] == 1


def test_raw_names_are_safe_and_preserve_jpeg_bytes(api, monkeypatch):
    client, root = api
    meat(monkeypatch, fournisseur_ou_marque="../../CON: fournisseur", numero_lot="../../LOT:42")
    content = picture("JPEG")
    saved = scan(client, content=content, mime="image/jpeg").json()
    raw = root / saved["chemin_image_brute"]
    assert raw.is_relative_to(root / "receptions") and raw.read_bytes() == content
    assert ".." not in raw.name and ":" not in raw.name
    assert raw.name.startswith("REC_CON-FOURNISSEUR_") and raw.name.endswith("_LOT-42.jpg")


def test_raw_archive_resolves_only_existing_directories(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    real_resolve = Path.resolve

    def resolve_existing(path, *args, **kwargs):
        assert path.exists(), "A missing parent can change Windows resolve() prefixes during creation."
        return real_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", resolve_existing)
    content = picture()
    image = pipeline.archiver_image_brute(
        content, "image/png", "user:one", extracted(), datetime.now(timezone.utc),
    )
    assert (tmp_path / image.chemin).read_bytes() == content
    assert pipeline.lire_image_verifiee(image, "user:one") == content


@pytest.mark.parametrize("parent", ["receptions", "scope"])
def test_raw_archive_rejects_redirected_parents(tmp_path, monkeypatch, parent):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    scope_directory = pipeline._archive_directory("user:one")
    redirected = scope_directory.parent if parent == "receptions" else scope_directory
    real_resolve = Path.resolve

    def resolve_redirected(path, *args, **kwargs):
        return tmp_path / "outside" if path == redirected else real_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", resolve_redirected)
    with pytest.raises(pipeline.ReceptionIntegrityError, match="redirige"):
        pipeline.archiver_image_brute(
            picture(), "image/png", "user:one", extracted(), datetime.now(timezone.utc),
        )
    assert not list(tmp_path.rglob("*.png"))
    assert not (tmp_path / "outside").exists()


@pytest.mark.parametrize("table", ["haccp_reception_sources", "haccp_reception_journal"])
@pytest.mark.parametrize("operation", ["update", "delete", "replace"])
def test_append_only_blocks_all_replacement_paths(api, table, operation):
    client, _ = api
    scan(client)
    statement = {
        "update": f"UPDATE {table} SET payload_json = '{{}}' WHERE reception_id = 1",
        "delete": f"DELETE FROM {table} WHERE reception_id = 1",
        "replace": f"INSERT OR REPLACE INTO {table} SELECT * FROM {table} WHERE reception_id = 1",
    }[operation]
    with pytest.raises(IntegrityError, match="append-only"):
        with haccp_database.get_engine().begin() as connection:
            connection.exec_driver_sql(statement)
    assert request(client, "/integrite").json()["ok"] is True


def test_integrity_detects_modified_original_and_blocks_opening(api, monkeypatch):
    client, root = api
    meat(monkeypatch)
    saved = scan(client).json()
    (root / saved["chemin_image_brute"]).write_bytes(b"changed")
    report = request(client, "/integrite").json()
    assert report["ok"] is False and report["erreurs"]
    assert request(client, f"/{saved['id']}/original").status_code == 409
    assert request(client, f"/{saved['id']}/ouverture", method="POST", body=opening_payload()).status_code == 409


def test_privileged_journal_tampering_is_detected(api):
    client, _ = api
    scan(client)
    with haccp_database.get_engine().begin() as connection:
        connection.exec_driver_sql("DROP TRIGGER immutable_haccp_reception_journal_update")
        connection.exec_driver_sql("UPDATE haccp_reception_journal SET entry_hash = ?", ("f" * 64,))
    report = request(client, "/integrite").json()
    assert report["ok"] is False and any("Chaine" in issue for issue in report["erreurs"])


def test_stock_is_fefo_then_fifo_and_uses_48_real_hours(api, monkeypatch):
    client, _ = api
    ids = []
    for lot, deadline in [("LATE", "2099-12-31"), ("FIRST", "2099-12-01"), ("SECOND", "2099-12-01"), ("UNKNOWN", None)]:
        meat(monkeypatch, numero_lot=lot, dlc_ou_ddm=deadline, type_date="DLC" if deadline else "inconnue")
        ids.append(scan(client).json()["id"])
    rows = destination(client, "stock")["items"]
    assert [row["reception_id"] for row in rows] == [ids[1], ids[2], ids[0], ids[3]]
    for row in rows[:3]:
        assert datetime.fromisoformat(row["deadline"]) - datetime.fromisoformat(row["alert_at"]) == timedelta(hours=48)
        assert row["controle_physique"] == "a_effectuer" and not row["quantite_receptionnee_confirmee"]
    assert rows[-1]["deadline"] is None and rows[-1]["alerte"] is True


@pytest.mark.parametrize("kind", ["DLC", "DDM"])
def test_expiry_flags_do_not_turn_ddm_into_dlc(api, monkeypatch, kind):
    client, _ = api
    meat(monkeypatch, dlc_ou_ddm="2000-01-01", type_date=kind)
    scan(client)
    row = destination(client, "stock")["items"][0]
    assert row["date_type"] == kind and row["date_depassee"] and row["alerte"]
    assert row["label_compliant"] is (kind == "DDM")
    assert row["alert_at"] == row["received_at"]


def test_allergen_alerts_compare_sources_even_when_retried_out_of_order(api, monkeypatch):
    client, _ = api
    with monkeypatch.context() as patch:
        patch.setattr(routes, "_distribute_saved", lambda db, scope, saved: saved)
        meat(monkeypatch, traces_allergenes=["Lait"])
        first = scan(client).json()
        meat(monkeypatch, allergenes=["Lait", "Moutarde"], traces_allergenes=["Soja"])
        second = scan(client).json()
    for saved in (second, first):
        assert request(client, f"/{saved['id']}/reprise", method="POST").status_code == 200
    state = request(client, f"/{second['id']}/distribution").json()
    assert state["observation_allergenes"]["nouveaux_allergenes"] == ["Lait", "Moutarde"]
    assert state["observation_allergenes"]["verification_requise"] is True
    rows = destination(client, "allergenes")["items"]
    assert rows[0]["baseline_id"] == first["id"]
    assert rows[0]["new_allergens"] == ["Lait", "Moutarde"] and rows[0]["new_traces"] == ["Soja"]
    assert rows[0]["review_required"] is True
    assert rows[1]["baseline_id"] is None
    meat(monkeypatch, allergenes=["Lait", "Moutarde"], traces_allergenes=["Soja"])
    scan(client)
    assert destination(client, "allergenes")["items"][0]["review_required"] is False
    scan(client, data={"restaurant_name": "Autre site"})
    assert destination(client, "allergenes")["items"][0]["baseline_id"] is None


def test_unknown_supplier_and_partial_reference_are_not_comparable(api, monkeypatch):
    client, _ = api
    for changes in [
        {"fournisseur_ou_marque": None}, {"fournisseur_ou_marque": None},
        {"allergenes_lecture": "partielle"}, {"allergenes": ["Moutarde"]},
    ]:
        meat(monkeypatch, **changes)
        scan(client)
    for row in destination(client, "allergenes")["items"]:
        assert row["baseline_id"] is None and row["review_required"] is True


@pytest.mark.parametrize("uncertain", ["nom_produit", "fournisseur_ou_marque", "mentions_traces"])
def test_uncertain_identity_or_trace_mention_is_not_a_reference(api, monkeypatch, uncertain):
    client, _ = api
    meat(monkeypatch, champs_incertains=[uncertain])
    scan(client)
    meat(monkeypatch, allergenes=["Moutarde"])
    scan(client)
    assert destination(client, "allergenes")["items"][0]["baseline_id"] is None


@pytest.mark.parametrize("delta,expected", [(-1, False), (0, True), (1, True)])
def test_rotation_alert_triggers_at_the_exact_threshold(api, monkeypatch, delta, expected):
    client, _ = api
    meat(monkeypatch, dlc_ou_ddm="2030-03-31")
    scan(client)
    alert = datetime.fromisoformat(destination(client, "stock")["items"][0]["alert_at"])
    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return (alert + timedelta(microseconds=delta)).astimezone(tz)
    monkeypatch.setattr(pipeline, "datetime", Frozen)
    assert destination(client, "stock")["items"][0]["alerte"] is expected


def _dispatch_in_process(root, ids):
    os.environ["SIRIUS_DATA_DIR"] = root
    haccp_database._configured_engine.cache_clear()
    engine = haccp_database.get_engine()
    try:
        return [pipeline.ReceptionDispatcher(engine).distribuer("user:one", id).statut for id in ids]
    finally:
        engine.dispose()


def test_process_concurrency_never_duplicates_deliveries_or_chain(api, monkeypatch):
    client, root = api
    with monkeypatch.context() as patch:
        patch.setattr(routes, "_distribute_saved", lambda db, scope, saved: saved)
        ids = [scan(client).json()["id"] for _ in range(4)]
    with ProcessPoolExecutor(max_workers=2, mp_context=multiprocessing.get_context("spawn")) as pool:
        futures = [pool.submit(_dispatch_in_process, str(root), order) for order in (ids, ids[::-1])]
        assert all(value == "complete" for future in futures for value in future.result(timeout=60))
    with Session(haccp_database.get_engine()) as db:
        assert [row.sequence for row in db.scalars(select(ReceptionJournal).order_by(ReceptionJournal.sequence))] == [1, 2, 3, 4]
        assert [row.attempts for row in db.scalars(select(ReceptionDelivery))] == [1] * 16
    assert request(client, "/integrite").json()["ok"] is True
    for name in DESTINATIONS:
        assert destination(client, name)["total"] == 4


@pytest.mark.parametrize("path,method", [
    ("", "GET"), ("/destinations/stock", "GET"), ("/destinations/traceabilite", "GET"),
    ("/destinations/allergenes", "GET"), ("/destinations/achats", "GET"), ("/integrite", "GET"),
    ("/1/distribution", "GET"), ("/1/original", "GET"), ("/1/reprise", "POST"), ("/1/ouverture", "POST"),
])
def test_all_reception_surfaces_require_authentication(api, path, method):
    client, _ = api
    assert request(client, path, method=method, user=None, body=opening_payload() if method == "POST" else None).status_code == 401


def test_scope_and_establishment_filters_are_preserved(api):
    client, _ = api
    first = scan(client, data={"restaurant_name": "Site Un"}).json()
    scan(client, data={"restaurant_name": "Site Deux"})
    assert request(client, user="other").json()["total"] == 0
    assert request(client, "/integrite", user="other").json()["total"] == 0
    for name in DESTINATIONS:
        assert destination(client, name, user="other")["total"] == 0
        filtered = destination(client, name, params={"restaurant_name": "site un"})
        assert filtered["total"] == 1 and filtered["items"][0]["reception_id"] == first["id"]
    for action, method in [("distribution", "GET"), ("original", "GET"), ("reprise", "POST"), ("ouverture", "POST")]:
        denied = request(client, f"/{first['id']}/{action}", user="other", method=method, body=opening_payload())
        assert denied.status_code == 404, denied.text


def test_company_receipts_are_shared_only_inside_the_authorized_company(api):
    client, _ = api
    saved = client.post("/api/haccp/etiquettes/scan", files={"file": ("label.png", picture(), "image/png")},
                        headers={"x-test-user": "one", "x-test-company": "kitchen"}).json()
    for user in ("one", "two"):
        headers = {"x-test-user": user, "x-test-company": "kitchen"}
        response = client.get(f"/api/haccp/receptions/{saved['id']}/original", headers=headers)
        assert response.status_code == 200 and response.content == picture()
    assert client.get(f"/api/haccp/receptions/{saved['id']}/original",
                      headers={"x-test-user": "two", "x-test-company": "other"}).status_code == 404
    assert client.get("/api/haccp/receptions", headers={"x-test-company": "kitchen"}).status_code == 401


@pytest.mark.parametrize("path", ["/destinations/recettes", "?limit=0", "?limit=101", "/integrite?offset=-1"])
def test_invalid_destination_and_pagination_are_explicit(api, path):
    assert request(api[0], path).status_code == 422


def test_integrity_pagination_covers_all_originals(api):
    client, _ = api
    for _ in range(3):
        scan(client)
    first = request(client, "/integrite", params={"limit": 2}).json()
    second = request(client, "/integrite", params={"limit": 2, "offset": 2}).json()
    assert first["ok"] and second["ok"]
    assert first["verifiees"] == 2 and first["prochain_offset"] == 2
    assert second["verifiees"] == 1 and second["prochain_offset"] is None
    assert second["archivage_certifie"] is False


def test_opening_is_explicit_idempotent_capped_and_does_not_restock(api, monkeypatch):
    client, root = api
    tomorrow = datetime.now(PARIS).date() + timedelta(days=1)
    meat(monkeypatch, dlc_ou_ddm=tomorrow)
    source = scan(client).json()
    payload = opening_payload()
    response = request(client, f"/{source['id']}/ouverture", method="POST", body=payload)
    assert response.status_code == 201, response.text
    opened = response.json()
    assert opened["type_operation"] == "ouverture" and opened["reception_source_id"] == source["id"]
    assert datetime.fromisoformat(opened["dlc_secondaire"].replace("Z", "+00:00")) == fin_de_date(tomorrow)
    assert opened["chemin_image_brute"] == source["chemin_image_brute"]
    assert request(client, f"/{source['id']}/ouverture", method="POST", body=payload).json() == opened
    assert get(client, f"{opened['id']}/etiquette").status_code == 200
    assert counts()["etiquettes_haccp"] == 2 and counts()["haccp_stock_lots"] == 1
    assert len(list(root.rglob("*.png"))) == 1
    routes.analyser_etiquette_vision.assert_awaited_once()
    assert request(client, f"/{source['id']}/ouverture", method="POST",
                   body=payload | {"duree_conservation_heures": 24}).status_code == 409


@pytest.mark.parametrize("changes", [
    {"ouverture_effectuee": False}, {"regle_confirmee": False}, {"justification_duree": ""},
    {"duree_conservation_heures": None}, {"type_operation": "reception"},
    {"duree_conservation_heures": True}, {"duree_conservation_heures": 10**100},
])
def test_opening_never_applies_an_unconfirmed_j_plus_three(api, monkeypatch, changes):
    client, _ = api
    meat(monkeypatch)
    source = scan(client).json()
    response = request(client, f"/{source['id']}/ouverture", method="POST", body=opening_payload(**changes))
    assert response.status_code == 422, response.text
    assert counts()["etiquettes_haccp"] == 1


@pytest.mark.parametrize("changes", [
    {"numero_lot": "ILLISIBLE"}, {"dlc_ou_ddm": None}, {"dlc_ou_ddm": "2000-01-01"},
    {"allergenes_lecture": "partielle"},
])
def test_uncertain_or_expired_labels_cannot_generate_an_opening(api, monkeypatch, changes):
    client, _ = api
    meat(monkeypatch, **changes)
    source = scan(client).json()
    response = request(client, f"/{source['id']}/ouverture", method="POST", body=opening_payload())
    assert response.status_code == 422 and counts()["etiquettes_haccp"] == 1


def test_new_fields_migrate_without_reclassifying_legacy_allergens(api):
    client, root = api
    with Session(haccp_database.get_engine()) as db:
        db.add(EtiquetteHaccp(
            **extracted(allergenes=["Lait", "Moutarde"]).model_dump(),
            scope_key="user:one", image_path="historique.jpg",
        ))
        db.commit()
    haccp_database.get_engine().dispose()
    haccp_database._configured_engine.cache_clear()
    with sqlite3.connect(root / "haccp.sqlite3") as connection:
        for column in (
            "origines", "poids_net", "traces_allergenes", "mentions_traces", "allergenes_lecture", "champs_incertains",
            "raw_image_path", "raw_image_sha256", "reception_source_id",
        ):
            connection.execute(f"ALTER TABLE etiquettes_haccp DROP COLUMN {column}")
    old = get(client, "recherche").json()[0]
    assert old["allergenes"] == ["Lait", "Moutarde"]
    assert old["allergenes_lecture"] == "non_verifiee" and old["traces_allergenes"] == []
    assert old["origines"] is None and old["poids_net"] is None and old["image_brute_url"] is None
    assert request(client).json()["total"] == 0


@pytest.mark.parametrize("path,method", [
    ("", "GET"), ("/destinations/stock", "GET"), ("/integrite", "GET"),
    ("/1/distribution", "GET"), ("/1/reprise", "POST"), ("/1/original", "GET"), ("/1/ouverture", "POST"),
])
def test_cloud_failures_never_fall_back_to_local_data(api, monkeypatch, path, method):
    client, root = api
    scan(client)
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "1")
    relay = AsyncMock(side_effect=HTTPException(502, "Cloud indisponible"))
    monkeypatch.setattr(cloud_link, "relay_haccp_registry", relay)
    response = request(client, path, method=method, body=opening_payload())
    assert response.status_code == 502 and response.json()["detail"] == "Cloud indisponible"
    assert relay.call_args.args == (method, "/receptions" + path)
    assert counts()["etiquettes_haccp"] == 1 and len(list(root.rglob("*.png"))) == 1


def test_original_download_is_relayed_without_losing_proof_headers(api, monkeypatch):
    client, _ = api
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "1")
    content = picture()
    relay = AsyncMock(return_value=httpx.Response(200, content=content, headers={
        "Content-Type": "image/png", "Content-Disposition": 'attachment; filename="REC_TEST.png"',
        "X-HACCP-SHA256": hashlib.sha256(content).hexdigest(),
    }))
    monkeypatch.setattr(cloud_link, "relay_haccp_registry", relay)
    response = request(client, "/42/original")
    assert response.status_code == 200 and response.content == content
    assert response.headers["X-HACCP-SHA256"] == hashlib.sha256(content).hexdigest()
    assert response.headers["Content-Disposition"] == 'attachment; filename="REC_TEST.png"'


def test_example_runs_offline_and_exports_four_independent_destinations(tmp_path):
    from haccp_reception_demo import run_demo
    output = tmp_path / "demo"
    report = run_demo(output)
    assert report["simulation_uniquement"] and report["panne_stock_reprise_sans_doublon"]
    assert report["lectures_vision_simulees"] == 2 and report["impression_reelle"] is False
    assert report["integrite"]["ok"] and report["nouvel_allergene"] == "Moutarde"
    journal = [json.loads(line) for line in (output / "A-traceabilite.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(journal) == 2
    for row in journal:
        computed = pipeline.fingerprint(pipeline.canonical_json([
            row["empreinte_perimetre"], row["sequence"], row["previous_hash"], row["recorded_at"],
            pipeline.canonical_json(row["document"]),
        ]))
        assert computed == row["entry_hash"]
    for filename in ("B-stock.json", "C-observations-allergenes.json", "D-achats.json"):
        assert json.loads((output / filename).read_text(encoding="utf-8"))["total"] == 2
    assert "NE PAS CONSOMMER" in (output / "etiquette-ouverture-TEST.html").read_text(encoding="utf-8")
    with pytest.raises(FileExistsError):
        run_demo(output)
