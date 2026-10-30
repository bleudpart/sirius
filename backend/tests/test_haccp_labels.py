import asyncio
import csv
import io
import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from openai import APIConnectionError
from PIL import Image
from pydantic import ValidationError
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

import haccp_database
import cloud_link
import routers.haccp as routes
import services.haccp_vision as vision
from models.haccp import EtiquetteHaccp
from schemas.haccp import EtiquetteVisionOutput, OperationCapture
from services.haccp_opening import PARIS, calculer_ouverture


def extracted(**changes):
    values = {
        "nom_produit": "Saumon", "numero_lot": "LOT-42",
        "fournisseur_ou_marque": "Maison ÉTOILE",
        "dlc_ou_ddm": "2099-12-31", "type_date": "DLC",
        "agrement_sanitaire": "FR 75.056.001 CE", "allergenes": ["Poissons"],
    }
    return EtiquetteVisionOutput(**(values | changes))


@pytest.mark.parametrize("value", ["2026-02-29", "01/02/26", "2026-10", 1234, "", "2026-10-27T00:00:00"])
def test_invalid_dates_are_rejected(value):
    with pytest.raises(ValidationError):
        extracted(dlc_ou_ddm=value)


def test_dates_are_converted_without_guessing_and_lists_are_independent():
    assert extracted(dlc_ou_ddm="27/10/2026").model_dump(mode="json")["dlc_ou_ddm"] == "2026-10-27"
    first = extracted(allergenes=[])
    second = extracted(allergenes=[])
    first.allergenes.append("Lait")
    assert second.allergenes == []


@pytest.mark.parametrize("changes", [
    {"nom_produit": " "}, {"numero_lot": ""}, {"conforme_reception": "true"},
    {"allergenes": ["inconnu"]}, {"type_date": "expiration"}, {"numero_lot": "a" * 129},
    {"champ_invente": 1},
])
def test_vision_schema_is_strict(changes):
    with pytest.raises(ValidationError):
        extracted(**changes)


def test_expired_dlc_but_not_ddm_is_non_compliant():
    assert vision.verifier_reception(extracted(dlc_ou_ddm="2000-01-01")).conforme_reception is False
    assert vision.verifier_reception(extracted(dlc_ou_ddm="2000-01-01", type_date="DDM")).conforme_reception is True
    assert vision.verifier_reception(extracted(numero_lot="ILLISIBLE")).conforme_reception is False
    assert vision.verifier_reception(extracted(dlc_ou_ddm=None)).conforme_reception is False


def mock_openai(monkeypatch, content, finish="stop", error=None):
    create = AsyncMock()
    if error:
        create.side_effect = error
    else:
        create.return_value = SimpleNamespace(choices=[
            SimpleNamespace(finish_reason=finish, message=SimpleNamespace(content=content)),
        ])
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    context = AsyncMock()
    context.__aenter__.return_value = client
    factory = lambda **kwargs: context
    monkeypatch.setattr(vision, "AsyncOpenAI", factory)
    monkeypatch.setenv("OPENAI_API_KEY", "test-not-a-real-key")
    return create


def test_vision_uses_requested_model_and_json_and_corrects_expired_dlc(monkeypatch):
    create = mock_openai(monkeypatch, extracted(dlc_ou_ddm="2000-01-01").model_dump_json())
    result = asyncio.run(vision.analyser_etiquette_vision(b"image", "image/png"))
    assert result.conforme_reception is False
    args = create.call_args.kwargs
    assert args["model"] == "gpt-4o-mini"
    assert args["response_format"] == {"type": "json_object"}
    assert args["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")


@pytest.mark.parametrize("content,finish", [
    ("pas du JSON", "stop"), ("{}", "stop"), ("[]", "stop"),
    (None, "stop"), (extracted().model_dump_json(), "length"),
])
def test_bad_vision_responses_fail_explicitly(monkeypatch, content, finish):
    mock_openai(monkeypatch, content, finish)
    with pytest.raises(vision.VisionAnalysisError):
        asyncio.run(vision.analyser_etiquette_vision(b"image", "image/jpeg"))


def test_provider_failure_and_missing_configuration_are_explicit(monkeypatch):
    mock_openai(monkeypatch, None, error=APIConnectionError(request=httpx.Request("POST", "https://example.test")))
    with pytest.raises(vision.VisionServiceError):
        asyncio.run(vision.analyser_etiquette_vision(b"image", "image/png"))
    monkeypatch.delenv("OPENAI_API_KEY")
    with pytest.raises(vision.VisionConfigurationError):
        asyncio.run(vision.analyser_etiquette_vision(b"image", "image/png"))


def picture(fmt="PNG"):
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), "white").save(buffer, format=fmt)
    return buffer.getvalue()


def assert_jpeg(content):
    with Image.open(io.BytesIO(content)) as image:
        assert image.format == "JPEG"
        assert image.mode == "RGB"
        assert min(image.getpixel((0, 0))) >= 245


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "0")
    haccp_database._configured_engine.cache_clear()

    async def scope(request: Request) -> str:
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "Authentification requise.")
        return "user:" + uid

    monkeypatch.setattr(routes, "analyser_etiquette_vision", AsyncMock(return_value=extracted()))
    app = FastAPI()
    app.include_router(routes.make_haccp_router(scope), prefix="/api")
    with TestClient(app) as client:
        yield client, tmp_path
    haccp_database.get_engine().dispose()
    haccp_database._configured_engine.cache_clear()


def scan(client, user="one", content=None, mime="image/png", data=None):
    form = {"restaurant_name": "Restaurant"} | (data or {})
    return client.post(
        "/api/haccp/etiquettes/scan", files={"file": ("../../unsafe.png", content if content is not None else picture(), mime)},
        data=form, headers={"x-test-user": user} if user else {},
    )


def get(client, path, user="one", **kwargs):
    return client.get("/api/haccp/registre/" + path, headers={"x-test-user": user} if user else {}, **kwargs)


def dossier(client, restaurant_name="Restaurant", user="one"):
    return client.get(
        "/api/haccp/receptions/dossier",
        params={"restaurant_name": restaurant_name},
        headers={"x-test-user": user} if user else {},
    )


def test_scan_archives_jpeg_and_persists_metadata(api):
    client, root = api
    response = scan(client, data={"operateur": "Chef"})
    assert response.status_code == 201, response.text
    record = response.json()
    assert record["operateur"] == "Chef"
    assert record["dlc_ou_ddm"] == "2099-12-31"
    assert record["numero_lot"] == "LOT-42"
    assert record["categorie"] == "Non classé"
    assert record["temperature_conforme"] is None
    assert record["fournisseur"] == record["fournisseur_ou_marque"]
    assert record["dlc_dluo"] == record["dlc_ou_ddm"]
    assert record["date_reception"] == record["created_at"]
    assert record["chemin_photo"].startswith("uploads/restaurant/")
    assert re.fullmatch(r"restaurant_reception_\d{8}_\d{6}_[a-f0-9]{8}\.jpg", Path(record["chemin_photo"]).name)
    assert record["chemin_donnees"] == f"haccp.sqlite3#etiquettes_haccp/{record['id']}"
    metadata = client.get(record["donnees_url"], headers={"x-test-user": "one"})
    assert metadata.json() == record
    assert metadata.headers["cache-control"] == "private, no-store"
    assert "image_path" not in record and "scope_key" not in record
    assert record["image_url"].endswith(f"/api/haccp/registre/{record['id']}/photo")
    with Session(haccp_database.get_engine()) as db:
        row = db.get(EtiquetteHaccp, record["id"])
        assert row.scope_key == "user:one"
        assert_jpeg((root / row.image_path).read_bytes())
    photo = client.get(record["image_url"], headers={"x-test-user": "one"})
    assert photo.status_code == 200
    assert_jpeg(photo.content)
    assert photo.headers["content-type"] == "image/jpeg"
    assert get(client, "recherche").json()[0]["id"] == record["id"]


def test_restaurant_dossier_is_created_resumed_and_refreshed_after_scan(api):
    client, root = api
    first = dossier(client, "Le Papillon")
    assert first.status_code == 200
    assert first.json()["restaurant_slug"] == "le-papillon"
    assert first.json()["directory"] == "uploads/le-papillon"
    assert first.json()["directory_existed"] is False
    assert first.json()["items"] == []
    assert (root / "uploads" / "le-papillon").is_dir()

    resumed = dossier(client, "Le Papillon")
    assert resumed.json()["directory_existed"] is True
    scan_response = scan(client, data={"restaurant_name": "Le Papillon"})
    assert scan_response.status_code == 201
    filename = Path(scan_response.json()["chemin_photo"]).name
    assert re.fullmatch(r"le-papillon_reception_\d{8}_\d{6}_[a-f0-9]{8}\.jpg", filename)
    listed = dossier(client, "Le Papillon").json()
    assert listed["directory_existed"] is True
    assert listed["total"] == 1
    assert listed["items"][0]["name"] == filename


def test_restaurant_dossier_slug_is_safe_and_scoped_by_account(api):
    client, root = api
    unsafe_name = dossier(client, "../../Le Papillon")
    assert unsafe_name.status_code == 200
    assert unsafe_name.json()["restaurant_slug"] == "le-papillon"
    assert (root / unsafe_name.json()["directory"]).resolve().is_relative_to((root / "uploads").resolve())
    other_user = dossier(client, "Le Papillon", user="two").json()
    assert other_user["directory_existed"] is False
    assert other_user["total"] == 0
    assert dossier(client, "🔥").status_code == 422


@pytest.mark.parametrize("fmt,mime", [("JPEG", "image/jpeg"), ("WEBP", "image/webp")])
def test_other_supported_formats(api, fmt, mime):
    client, _ = api
    assert scan(client, content=picture(fmt), mime=mime).status_code == 201


def test_isolation_and_authentication_cover_all_endpoints(api):
    client, _ = api
    record = scan(client).json()
    assert scan(client, user=None).status_code == 401
    for path in ["recherche", "export-csv", f"{record['id']}/photo", f"{record['id']}/donnees"]:
        assert get(client, path, user=None).status_code == 401
    assert get(client, "recherche", user="two").json() == []
    assert get(client, f"{record['id']}/photo", user="two").status_code == 404
    assert get(client, f"{record['id']}/donnees", user="two").status_code == 404
    assert "LOT-42" not in get(client, "export-csv", user="two").text


def test_search_case_insensitive_literals_date_range_and_sort(api, monkeypatch):
    client, _ = api
    first = scan(client).json()
    monkeypatch.setattr(routes, "analyser_etiquette_vision", AsyncMock(return_value=extracted(
        numero_lot="LOT%_SPECIAL", conforme_reception=False, commentaire_anomalie="Abime",
    )))
    second = scan(client).json()
    for term in ["lot-42", "saum", "étoile", "75.056"]:
        assert get(client, "recherche", params={"terme": term}).json()
    items = get(client, "recherche").json()
    assert [row["id"] for row in items] == [second["id"], first["id"]]
    assert len(get(client, "recherche", params={"terme": "%_"}).json()) == 1
    assert len(get(client, "recherche", params={"non_conforme_seul": True}).json()) == 1
    with Session(haccp_database.get_engine()) as db:
        db.get(EtiquetteHaccp, first["id"]).created_at = datetime(2026, 1, 1, 0, 0)
        db.get(EtiquetteHaccp, second["id"]).created_at = datetime(2026, 1, 1, 23, 59, 59)
        db.commit()
    assert len(get(client, "recherche", params={"date_debut": "2026-01-01", "date_fin": "2026-01-01"}).json()) == 2
    assert get(client, "recherche", params={"date_fin": "2025-12-31"}).json() == []
    for path in ["recherche", "export-csv"]:
        assert get(client, path, params={"date_debut": "2026-02-01", "date_fin": "2026-01-01"}).status_code == 422
        assert get(client, path, params={"date_debut": "pas-une-date"}).status_code == 422


def test_csv_utf8_all_columns_quoting_and_formula_protection(api, monkeypatch):
    client, _ = api
    monkeypatch.setattr(routes, "analyser_etiquette_vision", AsyncMock(return_value=extracted(
        nom_produit='=FORMULE;"Poisson"\nLigne', allergenes=["Poissons", "Lait"],
    )))
    scan(client)
    response = get(client, "export-csv")
    assert response.status_code == 200
    assert response.content.startswith(b"\xef\xbb\xbf")
    assert "attachment" in response.headers["content-disposition"]
    reader = csv.DictReader(io.StringIO(response.content.decode("utf-8-sig")), delimiter=";")
    row = next(reader)
    assert row["nom_produit"] == '\'=FORMULE;"Poisson"\nLigne'
    assert row["allergenes"] == "Poissons, Lait"
    assert row["conforme_reception"] == "Oui"
    assert "scope_key" not in row and "image_path" not in row
    assert row["image_url"].endswith("/photo")
    assert list(reader) == []


@pytest.mark.parametrize("content,mime,operator,status", [
    (b"", "image/png", "Cuisine", 400),
    (b"not an image", "image/png", "Cuisine", 400),
    (picture(), "image/jpeg", "Cuisine", 400),
    (picture(), "application/pdf", "Cuisine", 400),
    (picture(), "image/png", " ", 422),
    (picture(), "image/png", "x" * 101, 422),
])
def test_invalid_uploads_are_not_archived(api, content, mime, operator, status):
    client, root = api
    assert scan(client, content=content, mime=mime, data={"operateur": operator}).status_code == status
    assert list(root.rglob("*.jpg")) == []
    assert get(client, "recherche").json() == []


def test_oversized_upload(api, monkeypatch):
    client, _ = api
    monkeypatch.setattr(routes, "MAX_IMAGE_BYTES", 10)
    assert scan(client).status_code == 400


@pytest.mark.parametrize("error,status", [
    (vision.VisionAnalysisError("Analyse invalide"), 422),
    (vision.VisionConfigurationError("Configuration absente"), 500),
    (vision.VisionServiceError("Fournisseur indisponible"), 500),
])
def test_vision_failure_removes_photo_and_does_not_insert(api, monkeypatch, error, status):
    client, root = api
    monkeypatch.setattr(routes, "analyser_etiquette_vision", AsyncMock(side_effect=error))
    assert scan(client).status_code == status
    assert list(root.rglob("*.jpg")) == []
    assert get(client, "recherche").json() == []


def test_database_failure_rolls_back_and_removes_photo(api, monkeypatch):
    client, root = api
    def fail_commit(self):
        raise OperationalError("commit", {}, Exception("locked"))
    with monkeypatch.context() as patch:
        patch.setattr(Session, "commit", fail_commit)
        assert scan(client).status_code == 500
    assert list(root.rglob("*.jpg")) == []
    assert get(client, "recherche").json() == []


def test_disk_failure_is_explicit_and_never_inserts(api, monkeypatch):
    client, root = api
    def fail_write(path, content):
        raise OSError("disk full")
    monkeypatch.setattr(routes, "_write_image", fail_write)
    assert scan(client).status_code == 500
    assert get(client, "recherche").json() == []
    assert list(root.rglob("*.jpg")) == []


def test_query_failure_is_an_explicit_server_error(api, monkeypatch):
    client, _ = api
    def fail_query(self, statement):
        raise OperationalError("select", {}, Exception("locked"))
    monkeypatch.setattr(Session, "scalars", fail_query)
    assert get(client, "recherche").status_code == 500
    assert get(client, "export-csv").status_code == 500


def test_registry_survives_engine_restart_and_has_isolated_json_defaults(api):
    client, _ = api
    record = scan(client).json()
    engine = haccp_database.get_engine()
    with Session(engine) as db:
        first = EtiquetteHaccp(nom_produit="A", numero_lot="A", scope_key="user:one", image_path="a")
        second = EtiquetteHaccp(nom_produit="B", numero_lot="B", scope_key="user:one", image_path="b")
        db.add_all([first, second])
        db.flush()
        first.allergenes.append("Lait")
        assert second.allergenes == []
        db.rollback()
    engine.dispose()
    haccp_database._configured_engine.cache_clear()
    assert get(client, "recherche").json()[0]["id"] == record["id"]


def test_missing_photo_and_traversal_are_not_served(api):
    client, root = api
    record = scan(client).json()
    with Session(haccp_database.get_engine()) as db:
        row = db.get(EtiquetteHaccp, record["id"])
        (root / row.image_path).unlink()
    assert get(client, f"{record['id']}/photo").status_code == 404
    secret = root / "outside.png"
    secret.write_bytes(picture())
    with Session(haccp_database.get_engine()) as db:
        row = db.get(EtiquetteHaccp, record["id"])
        row.image_path = "outside.png"
        db.commit()
    assert get(client, f"{record['id']}/photo").status_code == 404
    assert get(client, "999999/photo").status_code == 404
    assert get(client, "0/photo").status_code == 422


def test_real_server_registration_and_account_company_permissions(monkeypatch):
    import server

    paths = server.app.openapi()["paths"]
    assert "post" in paths["/api/haccp/etiquettes/scan"]
    assert "get" in paths["/api/haccp/receptions/dossier"]
    assert "get" in paths["/api/haccp/registre/recherche"]
    assert "get" in paths["/api/haccp/registre/export-csv"]
    assert "get" in paths["/api/haccp/registre/{id}/photo"]

    request = Request({"type": "http", "headers": []})
    user = AsyncMock(return_value={"user_id": "one"})
    membership = AsyncMock(return_value={"permissions": ["haccp"]})
    monkeypatch.setattr(server, "require_user", user)
    monkeypatch.setattr(server, "db", SimpleNamespace(
        enterprise_members=SimpleNamespace(find_one=membership),
    ))
    assert asyncio.run(server._haccp_labels_scope(request)) == "user:one"
    user.return_value = {"user_id": "one", "company_id": "kitchen"}
    assert asyncio.run(server._haccp_labels_scope(request)) == "company:kitchen"
    assert membership.call_args.args[0] == {"company_id": "kitchen", "user_id": "one"}
    membership.return_value = None
    with pytest.raises(HTTPException) as denied:
        asyncio.run(server._haccp_labels_scope(request))
    assert denied.value.status_code == 403
    user.side_effect = HTTPException(401, "Authentification requise.")
    with pytest.raises(HTTPException) as anonymous:
        asyncio.run(server._haccp_labels_scope(request))
    assert anonymous.value.status_code == 401


def opening_rule(**changes):
    return OperationCapture(
        **({"type_operation": "ouverture", "duree_conservation_heures": 72,
            "justification_duree": "Notice fabricant : 72 h entre 0 et 4 C", "regle_confirmee": True} | changes),
    )


def test_opening_uses_confirmed_hours_and_caps_at_original_dlc():
    now = datetime(2026, 10, 27, 11, 0, tzinfo=timezone.utc)
    result, limit = calculer_ouverture(extracted(dlc_ou_ddm="2026-10-28"), opening_rule(), now)
    assert result.conforme_reception is True
    assert limit == datetime(2026, 10, 28, 22, 59, 59, 999999, tzinfo=timezone.utc)
    _, shorter = calculer_ouverture(extracted(), opening_rule(duree_conservation_heures=12), now)
    assert shorter == now + timedelta(hours=12)


def test_opening_across_dst_uses_elapsed_hours_and_ddm_is_not_a_dlc():
    now = datetime(2026, 10, 24, 10, tzinfo=timezone.utc)
    _, limit = calculer_ouverture(extracted(), opening_rule(duree_conservation_heures=24), now)
    assert limit - now == timedelta(hours=24)
    assert limit.astimezone(PARIS).hour == 11
    result, limit = calculer_ouverture(
        extracted(type_date="DDM", dlc_ou_ddm="2020-01-01"), opening_rule(), now,
    )
    assert result.conforme_reception and limit == now + timedelta(hours=72)


@pytest.mark.parametrize("changes", [
    {"dlc_ou_ddm": None}, {"type_date": "inconnue"},
    {"dlc_ou_ddm": "2000-01-01"},
    {"conforme_reception": False, "commentaire_anomalie": "Etiquette abimee"},
])
def test_uncertain_or_expired_openings_never_get_a_secondary_dlc(changes):
    result, limit = calculer_ouverture(
        extracted(**changes), opening_rule(), datetime.now(timezone.utc),
    )
    assert limit is None and not result.conforme_reception
    assert result.commentaire_anomalie


@pytest.mark.parametrize("changes", [
    {"duree_conservation_heures": 0}, {"duree_conservation_heures": -1},
    {"duree_conservation_heures": 1.5}, {"duree_conservation_heures": "72"},
    {"duree_conservation_heures": True}, {"justification_duree": " "},
    {"justification_duree": "a" * 501}, {"regle_confirmee": False},
    {"regle_confirmee": "true"}, {"type_operation": "reception"},
])
def test_unconfirmed_or_invalid_opening_rules_are_rejected(changes):
    with pytest.raises(ValidationError):
        opening_rule(**changes)


def test_opening_records_rule_operator_dates_and_prints_saved_label(api, monkeypatch):
    client, _ = api
    monkeypatch.setattr(routes, "analyser_etiquette_vision", AsyncMock(return_value=extracted(
        nom_produit='<script>alert("x")</script>', numero_lot="<LOT>",
    )))
    response = scan(client, data={"operation": opening_rule().model_dump_json(), "operateur": "Chef"})
    assert response.status_code == 201, response.text
    record = response.json()
    assert record["type_operation"] == "ouverture"
    opened = datetime.fromisoformat(record["date_ouverture"].replace("Z", "+00:00"))
    limit = datetime.fromisoformat(record["dlc_secondaire"].replace("Z", "+00:00"))
    assert opened.tzinfo is not None
    assert limit - opened == timedelta(hours=72)
    assert record["duree_conservation_heures"] == 72 and record["regle_confirmee"]
    assert record["justification_duree"] == opening_rule().justification_duree
    assert get(client, "recherche").json()[0]["dlc_secondaire"] == record["dlc_secondaire"]
    label = get(client, f"{record['id']}/etiquette")
    assert label.status_code == 200 and "text/html" in label.headers["content-type"]
    assert "<script>" not in label.text and "&lt;script&gt;" in label.text
    assert "Chef" in label.text and "ΣIRIUS" in label.text and "Europe/Paris" in label.text
    assert "72" in label.text and "Reference fabricant" in label.text
    assert "no-store" in label.headers["cache-control"]
    assert get(client, f"{record['id']}/etiquette", user="two").status_code == 404
    assert get(client, f"{record['id']}/etiquette", user=None).status_code == 401
    csv_row = next(csv.DictReader(io.StringIO(get(client, "export-csv").content.decode("utf-8-sig")), delimiter=";"))
    assert csv_row["type_operation"] == "ouverture"
    assert csv_row["duree_conservation_heures"] == "72"
    assert csv_row["justification_duree"] == opening_rule().justification_duree
    with Session(haccp_database.get_engine()) as db:
        db.get(EtiquetteHaccp, record["id"]).dlc_secondaire = datetime(2000, 1, 1)
        db.commit()
    assert get(client, f"{record['id']}/etiquette").status_code == 422


def test_opening_without_rule_is_archived_as_alert_without_printable_dlc(api):
    client, _ = api
    record = scan(client, data={"operation": '{"type_operation":"ouverture"}'}).json()
    assert record["date_ouverture"] and record["dlc_secondaire"] is None
    assert record["conforme_reception"] is False
    assert "sans regle" in record["commentaire_anomalie"]
    assert get(client, f"{record['id']}/etiquette").status_code == 422
    reception = scan(client).json()
    assert reception["type_operation"] == "reception"
    assert reception["date_ouverture"] is None and reception["dlc_secondaire"] is None
    assert get(client, f"{reception['id']}/etiquette").status_code == 422


@pytest.mark.parametrize("operation", [
    "invalid json", '{"type_operation":"autre"}',
    '{"type_operation":"ouverture","regle_confirmee":true}',
    '{"type_operation":"ouverture","date_ouverture":"2026-01-01"}',
])
def test_invalid_operation_is_rejected_before_photo_or_vision(api, monkeypatch, operation):
    client, root = api
    analyzer = AsyncMock(return_value=extracted())
    monkeypatch.setattr(routes, "analyser_etiquette_vision", analyzer)
    assert scan(client, data={"operation": operation}).status_code == 422
    analyzer.assert_not_awaited()
    assert list(root.rglob("*.jpg")) == []


def test_excessive_duration_fails_explicitly_and_cleans_photo(api):
    client, root = api
    payload = opening_rule().model_dump() | {"duree_conservation_heures": 10**100}
    assert scan(client, data={"operation": json.dumps(payload)}).status_code == 422
    assert list(root.rglob("*.jpg")) == []
    assert get(client, "recherche").json() == []


def test_sqlite_additive_upgrade_keeps_old_receptions(api):
    client, root = api
    first = scan(client).json()
    legacy = root / "storage" / "etiquettes_haccp" / "ancienne-photo.jpg"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    (root / first["chemin_photo"]).rename(legacy)
    engine = haccp_database.get_engine()
    engine.dispose()
    haccp_database._configured_engine.cache_clear()
    additions = ["type_operation", "date_ouverture", "dlc_secondaire",
                 "duree_conservation_heures", "justification_duree", "regle_confirmee", "capture_id", "capture_hash", "categorie"]
    # Reconstruit le schema precedent en gardant les contraintes et la ligne.
    with sqlite3.connect(root / "haccp.sqlite3") as connection:
        connection.execute(
            "UPDATE etiquettes_haccp SET image_path = ? WHERE id = ?",
            ("storage/etiquettes_haccp/ancienne-photo.jpg", first["id"]),
        )
        connection.execute("DROP INDEX uq_haccp_capture")
        connection.execute("DROP INDEX ix_haccp_scope_categorie")
        for column in additions:
            connection.execute(f"ALTER TABLE etiquettes_haccp DROP COLUMN {column}")
    for _ in range(2):
        records = get(client, "recherche").json()
        assert records[0]["id"] == first["id"]
        assert records[0]["type_operation"] == "reception"
        assert records[0]["date_ouverture"] is None and records[0]["dlc_secondaire"] is None
        assert records[0]["categorie"] == "Non classé"
        assert records[0]["chemin_photo"] == "storage/etiquettes_haccp/ancienne-photo.jpg"
        assert_jpeg(legacy.read_bytes())
        assert_jpeg(get(client, f"{first['id']}/photo").content)
        haccp_database.get_engine().dispose()
        haccp_database._configured_engine.cache_clear()
    assert scan(client).status_code == 201


@pytest.mark.parametrize("value,expected", [
    ("Viandes", "Viandes"), (" poissons ", "Poissons"),
    ("Produits Laitiers", "Produits Laitiers"), ("Fruits & Légumes", "Fruits & Légumes"),
    ("Épicerie", "Épicerie"), (None, "Non classé"), ("Autres", "Non classé"),
    ("../../outside", "Non classé"), ("", "Non classé"),
])
def test_categories_are_bounded_with_explicit_unclassified_default(value, expected):
    assert extracted(categorie=value).categorie == expected


@pytest.mark.parametrize("value", [42, True, [], {}])
def test_non_text_categories_are_not_silently_accepted(value):
    with pytest.raises(ValidationError):
        extracted(categorie=value)


def test_archived_files_use_restaurant_type_timestamp_and_unique_jpeg_names(api, monkeypatch):
    client, root = api
    monkeypatch.setattr(routes, "analyser_etiquette_vision", AsyncMock(return_value=extracted(
        categorie="Poissons", nom_produit="../Saumon fumé / test", numero_lot="../../LOT:42",
    )))
    first = scan(client).json()
    second = scan(client).json()
    assert first["chemin_photo"] != second["chemin_photo"]
    for record in [first, second]:
        path = root / record["chemin_photo"]
        assert path.is_relative_to(root / "uploads" / "restaurant")
        timestamp = datetime.fromisoformat(record["date_reception"]).astimezone(PARIS).strftime("%Y%m%d_%H%M%S")
        assert re.fullmatch(rf"restaurant_reception_{timestamp}_[a-f0-9]{{8}}\.jpg", path.name)
        assert_jpeg(path.read_bytes())
        assert_jpeg(get(client, f"{record['id']}/photo").content)
    with Session(haccp_database.get_engine()) as db:
        assert db.query(EtiquetteHaccp).filter_by(categorie="Poissons").count() == 2
    assert get(client, "recherche", params={"categorie": "Poissons"}).json()[0]["id"] == second["id"]
    assert get(client, "recherche", params={"categorie": "Viandes"}).json() == []
    assert get(client, "recherche", params={"categorie": "../../outside"}).status_code == 422
    assert get(client, "recherche", user="two", params={"categorie": "Poissons"}).json() == []
    export = get(client, "export-csv")
    assert "categorie" in export.text and "Poissons" in export.text


def test_reception_paths_separate_accounts_and_temperature_is_never_certified(api, monkeypatch):
    client, _ = api
    monkeypatch.setattr(routes, "analyser_etiquette_vision", AsyncMock(return_value=extracted(
        categorie="Produits Laitiers", temperature_stockage="0 a 4 C",
    )))
    first = scan(client).json()
    second = scan(client, user="two").json()
    assert first["chemin_photo"].split("/")[2] != second["chemin_photo"].split("/")[2]
    assert first["temperature_conforme"] is None
    assert first["temperature_stockage"] == "0 a 4 C"
    with pytest.raises(ValidationError):
        extracted(temperature_conforme=True)


def test_openings_use_the_selected_restaurant_dossier(api):
    client, _ = api
    record = scan(client, data={"operation": opening_rule().model_dump_json()}).json()
    assert re.fullmatch(r"uploads/restaurant/[a-f0-9]{64}/restaurant_ouverture_\d{8}_\d{6}_[a-f0-9]{8}\.jpg", record["chemin_photo"])
    assert record["date_reception"] is None


def test_establishment_directory_creation_failure_is_explicit_and_never_inserts(api, monkeypatch):
    client, root = api
    monkeypatch.setattr(routes.os, "makedirs", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk unavailable")))
    assert scan(client).status_code == 500
    assert get(client, "recherche").json() == []
    assert list(root.rglob("*.jpg")) == []


def test_linked_pc_scan_and_reads_use_cloud_registry_instead_of_local_lots(api, monkeypatch):
    client, _ = api
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "1")
    payload = {
        **extracted().model_dump(mode="json"), "id": 99, "created_at": "2026-10-27T12:00:00Z",
        "operateur": "Cuisine", "image_url": "https://example.test/api/haccp/registre/99/photo",
    }
    forwarded = AsyncMock(return_value=httpx.Response(201, json=payload))
    monkeypatch.setattr(cloud_link, "relay_haccp_registry", forwarded)
    analyzer = AsyncMock()
    monkeypatch.setattr(routes, "analyser_etiquette_vision", analyzer)
    response = scan(client)
    assert response.status_code == 201 and response.json()["id"] == 99
    analyzer.assert_not_awaited()
    assert forwarded.call_args.args == ("POST", "/etiquettes/scan")
    assert forwarded.call_args.kwargs["files"]["file"][1] == picture()
    assert forwarded.call_args.kwargs["data"]["restaurant_name"] == "Restaurant"
    with Session(haccp_database.get_engine()) as db:
        assert db.query(EtiquetteHaccp).count() == 0
    forwarded.return_value = httpx.Response(200, json=[payload])
    assert get(client, "recherche", params={"terme": "LOT"}).json()[0]["id"] == 99
    assert forwarded.call_args.kwargs["params"] == {"terme": "LOT"}
    forwarded.return_value = httpx.Response(200, json={
        "restaurant_name": "Restaurant", "restaurant_slug": "restaurant",
        "directory": "uploads/restaurant", "directory_existed": False, "items": [], "total": 0,
    })
    assert dossier(client).json()["restaurant_slug"] == "restaurant"
    assert forwarded.call_args.args == ("GET", "/receptions/dossier")
    assert forwarded.call_args.kwargs["params"] == {"restaurant_name": "Restaurant"}
    forwarded.return_value = httpx.Response(200, json=payload)
    metadata = get(client, "99/donnees")
    assert metadata.status_code == 200 and metadata.json()["id"] == 99
    assert metadata.headers["cache-control"] == "private, no-store"
    assert forwarded.call_args.args == ("GET", "/registre/99/donnees")
    forwarded.return_value = httpx.Response(200, content=picture(), headers={"content-type": "image/png"})
    assert get(client, "99/photo").content == picture()
    forwarded.return_value = httpx.Response(200, text="<html>Etiquette Cloud</html>")
    assert "Etiquette Cloud" in get(client, "99/etiquette").text
    forwarded.return_value = httpx.Response(200, content=b"registre;cloud")
    assert get(client, "export-csv").content == b"registre;cloud"


def test_cloud_registry_failure_is_not_saved_locally_or_hidden(api, monkeypatch):
    client, root = api
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "1")
    monkeypatch.setattr(cloud_link, "relay_haccp_registry", AsyncMock(
        side_effect=HTTPException(502, "Cloud indisponible"),
    ))
    assert scan(client).status_code == 502
    assert get(client, "recherche").status_code == 502
    assert list(root.rglob("*.jpg")) == []


def test_retry_of_same_capture_returns_same_record_without_rerunning_vision(api, monkeypatch):
    import uuid
    client, root = api
    analyzer = AsyncMock(return_value=extracted())
    monkeypatch.setattr(routes, "analyser_etiquette_vision", analyzer)
    key = str(uuid.uuid4())
    first = scan(client, data={"capture_id": key})
    assert first.status_code == 201
    second = scan(client, data={"capture_id": key})
    assert second.status_code == 201 and second.json() == first.json()
    analyzer.assert_awaited_once()
    assert len(list(root.rglob("*.jpg"))) == 1
    assert len(get(client, "recherche").json()) == 1
    conflict = scan(client, data={"capture_id": key, "operateur": "Autre"})
    assert conflict.status_code == 409
    assert len(list(root.rglob("*.jpg"))) == 1
    assert scan(client, data={"capture_id": "invalid"}).status_code == 422


def test_concurrent_same_capture_commits_exactly_one_photo_and_record(api, monkeypatch):
    import uuid
    from concurrent.futures import ThreadPoolExecutor
    client, root = api
    monkeypatch.setattr(routes, "analyser_etiquette_vision", AsyncMock(return_value=extracted()))
    key = str(uuid.uuid4())
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: scan(client, data={"capture_id": key}), range(2)))
    assert [result.status_code for result in results] == [201, 201]
    assert results[0].json()["id"] == results[1].json()["id"]
    assert len(list(root.rglob("*.jpg"))) == 1
    assert len(get(client, "recherche").json()) == 1
