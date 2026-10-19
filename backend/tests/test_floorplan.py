"""Tests du module PLANS# : moteur de géométrie, normalisation, export DXF."""
import pytest

from floorplan import normalize_plan, plan_metrics, plan_to_dxf, room_metrics


GARAGE = {
    "titre": "Garage 6x4",
    "pieces": [{"nom": "Garage", "x": 0, "y": 0, "l": 6, "p": 4, "hauteur": 2.5}],
    "ouvertures": [
        {"type": "porte_garage", "piece": "Garage", "mur": "sud", "position": 1.5, "largeur": 3},
        {"type": "fenetre", "piece": "Garage", "mur": "est", "position": 1.2, "largeur": 1.2},
    ],
    "mobilier": [{"nom": "Établi", "x": 0.1, "y": 0.1, "l": 2, "p": 0.6}],
}


# ---------- Moteur de géométrie ----------

def test_room_metrics_surface_perimetre_volume():
    m = room_metrics({"l": 6, "p": 4, "hauteur": 2.5})
    assert m["surface_m2"] == 24.0
    assert m["perimetre_m"] == 20.0
    assert m["volume_m3"] == 60.0
    assert m["surface_murs_m2"] == 50.0


def test_plan_metrics_totaux_et_emprise():
    plan = {
        "pieces": [
            {"nom": "Salon", "x": 0, "y": 0, "l": 5, "p": 4},
            {"nom": "Cuisine", "x": 5, "y": 0, "l": 3, "p": 4},
        ]
    }
    geo = plan_metrics(plan)
    assert geo["surface_totale_m2"] == 32.0
    assert geo["emprise"] == {"largeur_m": 8.0, "profondeur_m": 4.0}
    assert [p["nom"] for p in geo["pieces"]] == ["Salon", "Cuisine"]


# ---------- Normalisation ----------

def test_normalize_plan_complet():
    plan = normalize_plan(dict(GARAGE))
    assert plan["titre"] == "Garage 6x4"
    assert plan["geometrie"]["surface_totale_m2"] == 24.0
    assert len(plan["ouvertures"]) == 2
    assert plan["mobilier"][0]["nom"] == "Établi"


def test_normalize_rejette_plan_vide():
    with pytest.raises(ValueError):
        normalize_plan({"pieces": []})


def test_ouverture_bornee_au_mur():
    plan = normalize_plan({
        "pieces": [{"nom": "Bureau", "x": 0, "y": 0, "l": 3, "p": 3}],
        "ouvertures": [{"type": "porte", "piece": "Bureau", "mur": "nord", "position": 99, "largeur": 12}],
    })
    op = plan["ouvertures"][0]
    assert op["largeur"] <= 2.9
    assert op["position"] + op["largeur"] <= 3.0


def test_ouverture_piece_inconnue_rattachee():
    plan = normalize_plan({
        "pieces": [{"nom": "Atelier", "x": 0, "y": 0, "l": 4, "p": 3}],
        "ouvertures": [{"type": "porte", "piece": "Inexistante", "mur": "sud"}],
    })
    assert plan["ouvertures"][0]["piece"] == "Atelier"


# ---------- Filet de sécurité : accès garanti ----------

def test_piece_isolee_recoit_porte_interieure():
    """Une pièce sans ouverture est reliée à sa voisine par une porte sur le mur partagé."""
    plan = normalize_plan({
        "pieces": [
            {"nom": "Sejour", "x": 0, "y": 0, "l": 4, "p": 4},
            {"nom": "Chambre", "x": 4, "y": 0, "l": 3, "p": 4},
        ],
        "ouvertures": [{"type": "porte", "piece": "Sejour", "mur": "sud", "position": 1.5, "largeur": 0.9}],
    })
    chambre_doors = [op for op in plan["ouvertures"] if op["piece"] == "Chambre" and op["type"] == "porte"]
    assert len(chambre_doors) == 1
    # Porte posée sur le mur partagé (ouest de la chambre = est du séjour)
    assert chambre_doors[0]["mur"] == "ouest"


def test_piece_seule_sans_porte_recoit_acces_exterieur():
    plan = normalize_plan({"pieces": [{"nom": "Abri", "x": 0, "y": 0, "l": 3, "p": 2}], "ouvertures": []})
    doors = [op for op in plan["ouvertures"] if op["type"] == "porte"]
    assert len(doors) == 1 and doors[0]["mur"] == "sud"


def test_fenetre_seule_ne_suffit_pas_comme_acces():
    """Une pièce qui n'a qu'une fenêtre reçoit quand même une porte."""
    plan = normalize_plan({
        "pieces": [{"nom": "Bureau", "x": 0, "y": 0, "l": 3, "p": 3}],
        "ouvertures": [{"type": "fenetre", "piece": "Bureau", "mur": "nord", "position": 1, "largeur": 1.2}],
    })
    types = sorted(op["type"] for op in plan["ouvertures"])
    assert types == ["fenetre", "porte"]


def test_piece_deja_servie_inchangee():
    plan = normalize_plan(dict(GARAGE))
    garage_doors = [op for op in plan["ouvertures"] if op["type"] != "fenetre"]
    assert len(garage_doors) == 1  # la porte_garage suffit, pas de porte ajoutée


def test_porte_sur_mur_partage_dessert_les_deux_pieces():
    """Une porte posée côté séjour sur le mur commun dessert aussi la chambre."""
    plan = normalize_plan({
        "pieces": [
            {"nom": "Sejour", "x": 0, "y": 0, "l": 4, "p": 4},
            {"nom": "Chambre", "x": 4, "y": 0, "l": 3, "p": 4},
        ],
        "ouvertures": [
            {"type": "porte", "piece": "Sejour", "mur": "sud", "position": 1.5, "largeur": 0.9},
            {"type": "porte", "piece": "Sejour", "mur": "est", "position": 1.5, "largeur": 0.9},
        ],
    })
    # La chambre est déjà desservie par la porte du mur est du séjour : rien d'ajouté.
    assert not any(op["piece"] == "Chambre" and op["type"] == "porte" for op in plan["ouvertures"])


def test_ouvertures_dupliquees_fusionnees():
    plan = normalize_plan({
        "pieces": [{"nom": "Sejour", "x": 0, "y": 0, "l": 4, "p": 4}],
        "ouvertures": [
            {"type": "porte", "piece": "Sejour", "mur": "est", "position": 1.5, "largeur": 0.9},
            {"type": "porte", "piece": "Sejour", "mur": "est", "position": 1.5, "largeur": 0.9},
        ],
    })
    assert len([op for op in plan["ouvertures"] if op["mur"] == "est"]) == 1


# ---------- Couche technique ----------

def test_technique_validee_et_bornee():
    plan = normalize_plan({
        "pieces": [{"nom": "Cuisine", "x": 0, "y": 0, "l": 3, "p": 3}],
        "ouvertures": [{"type": "porte", "piece": "Cuisine", "mur": "sud", "position": 1, "largeur": 0.9}],
        "technique": [
            {"type": "prise_20a", "piece": "Cuisine", "x": 0.1, "y": 0.1},
            {"type": "point_lumineux", "piece": "Cuisine", "x": 1.5, "y": 1.5},
            {"type": "prise", "piece": "Cuisine", "x": 99, "y": -5},      # hors pièce → ramené dedans
            {"type": "machin_inconnu", "piece": "Cuisine", "x": 1, "y": 1},  # type invalide → rejeté
        ],
    })
    kinds = sorted(t["type"] for t in plan["technique"])
    assert kinds == ["point_lumineux", "prise", "prise_20a"]
    stray = next(t for t in plan["technique"] if t["type"] == "prise")
    assert 0 <= stray["x"] <= 3 and 0 <= stray["y"] <= 3


def test_technique_dans_le_dxf():
    plan = normalize_plan({
        "pieces": [{"nom": "Bureau", "x": 0, "y": 0, "l": 4, "p": 3}],
        "ouvertures": [],
        "technique": [
            {"type": "prise", "piece": "Bureau", "x": 0.2, "y": 0.2},
            {"type": "arrivee_eau", "piece": "Bureau", "x": 3.5, "y": 0.2},
        ],
    })
    txt = plan_to_dxf(plan).decode("utf-8", errors="ignore")
    assert "ELEC" in txt and "PLOMBERIE" in txt


# ---------- Export DXF ----------

def test_dxf_export_valide():
    data = plan_to_dxf(normalize_plan(dict(GARAGE)))
    assert isinstance(data, bytes) and len(data) > 2000
    text = data.decode("utf-8", errors="ignore")
    assert "SECTION" in text and "ENTITIES" in text  # structure DXF
    assert "MURS" in text and "COTES" in text        # calques ΣIRIUS
    assert "Garage" in text                          # étiquette de pièce


def test_dxf_relisible_par_ezdxf(tmp_path):
    import ezdxf
    path = tmp_path / "plan.dxf"
    path.write_bytes(plan_to_dxf(normalize_plan(dict(GARAGE))))
    doc = ezdxf.readfile(str(path))
    names = [layer.dxf.name for layer in doc.layers]
    for expected in ("MURS", "OUVERTURES", "MOBILIER", "COTES", "TEXTE"):
        assert expected in names
    assert len(list(doc.modelspace())) > 5


# ---------- Intérieur ----------

def test_normalize_interior_borne_le_mobilier_dans_la_piece():
    from floorplan import normalize_interior
    room = {"nom": "Séjour", "x": 2, "y": 1, "l": 5, "p": 4}
    out = normalize_interior({
        "mobilier": [
            {"nom": "Canapé", "x": 4.5, "y": -1, "l": 2.4, "p": 0.95},
            {"nom": "Table", "x": "abc", "y": 1, "l": 1, "p": 1},
            {"nom": "Tapis géant", "x": 0, "y": 0, "l": 9, "p": 9},
        ],
        "conseils": ["Murs lin", "", "Bois clair"],
        "eclairage": "2700 K",
        "achats": [{"article": "Canapé lin", "quantite": "2", "budget_eur": "890.4"}, {"article": ""}],
    }, room)
    assert out["piece"] == "Séjour"
    assert [m["nom"] for m in out["mobilier"]] == ["Canapé", "Tapis géant"]
    for m in out["mobilier"]:
        assert room["x"] <= m["x"] and m["x"] + m["l"] <= room["x"] + room["l"]
        assert room["y"] <= m["y"] and m["y"] + m["p"] <= room["y"] + room["p"]
    assert out["conseils"] == ["Murs lin", "Bois clair"]
    assert out["achats"] == [{"article": "Canapé lin", "quantite": 2, "budget_eur": 890}]


def test_interior_endpoint_refuse_une_piece_inconnue(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import floorplan

    app = FastAPI()
    app.include_router(floorplan.make_floorplan_router(lambda *a, **k: True), prefix="/api")
    client = TestClient(app)
    resp = client.post("/api/floorplan/interior", json={"plan": GARAGE, "piece": "Cuisine"})
    assert resp.status_code == 400
    assert "introuvable" in resp.json()["detail"]


def _png_data_url():
    import base64
    import io as _io
    from PIL import Image
    buf = _io.BytesIO()
    Image.new("RGB", (40, 30), (200, 180, 150)).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def test_clean_image_input_accepte_image_et_pdf():
    import base64
    import pymupdf as fitz
    from floorplan import clean_image_input

    assert clean_image_input("") == ""
    png = _png_data_url()
    assert clean_image_input(png) == png
    doc = fitz.open()
    page = doc.new_page(width=200, height=150)
    page.insert_text((20, 40), "Séjour 5 x 4")
    pdf_url = "data:application/pdf;base64," + base64.b64encode(doc.tobytes()).decode()
    out = clean_image_input(pdf_url)
    assert out.startswith("data:image/png;base64,")
    assert base64.b64decode(out.split(",", 1)[1]).startswith(b"\x89PNG")


@pytest.mark.parametrize("bad", [
    "data:image/gif;base64,R0lGODlh",
    "data:image/png;base64,%%%",
    "data:application/pdf;base64,aGVsbG8=",
    "https://exemple.fr/plan.png",
])
def test_clean_image_input_refuse_les_fichiers_invalides(bad):
    from floorplan import clean_image_input
    with pytest.raises(ValueError):
        clean_image_input(bad)


class _FakeCompletions:
    def __init__(self, content):
        self.content, self.calls = content, []

    async def create(self, **kwargs):
        from types import SimpleNamespace
        self.calls.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=self.content))])


def _fake_openai(monkeypatch, content):
    import json as _json
    from types import SimpleNamespace
    import openai
    import provider_access

    completions = _FakeCompletions(_json.dumps(content) if not isinstance(content, str) else content)
    monkeypatch.setattr(openai, "AsyncOpenAI",
                        lambda **kw: SimpleNamespace(chat=SimpleNamespace(completions=completions)))
    monkeypatch.setattr(provider_access, "require_key", lambda *a, **k: "cle-test")
    return completions


def test_plan_depuis_une_image_utilise_le_modele_vision(monkeypatch):
    import asyncio
    import floorplan

    completions = _fake_openai(monkeypatch, GARAGE)
    plan = asyncio.run(floorplan.generate_floorplan("", keys={}, image=_png_data_url()))
    assert plan["pieces"][0]["nom"] == "Garage"
    call = completions.calls[0]
    assert call["model"] == floorplan.VISION_MODEL
    parts = call["messages"][0]["content"]
    assert parts[1]["type"] == "image_url" and parts[1]["image_url"]["url"].startswith("data:image/png")


def test_amenagement_depuis_une_photo_renvoie_l_inspiration(monkeypatch):
    import asyncio
    import floorplan

    completions = _fake_openai(monkeypatch, "<think>analyse</think>" + __import__("json").dumps({
        "mobilier": [{"nom": "Établi", "x": 0.2, "y": 0.2, "l": 2, "p": 0.6}],
        "palette": ["#c8a97e", "#C8A97E", "bleu", "#3e4a3d"],
        "matieres": ["chêne", "lin"], "style": "Japandi", "analyse": "Pièce lumineuse.",
    }))
    out = asyncio.run(floorplan.generate_interior(
        floorplan.normalize_plan(GARAGE), "Garage", "Japandi", "", keys={}, photo=_png_data_url()))
    assert completions.calls[0]["model"] == floorplan.VISION_MODEL
    assert out["inspiration"] == {"style": "Japandi", "palette": ["#C8A97E", "#3E4A3D"],
                                  "matieres": ["chêne", "lin"], "analyse": "Pièce lumineuse."}


def test_json_illisible_reessaie_puis_erreur_generique(monkeypatch):
    import asyncio
    import floorplan

    completions = _fake_openai(monkeypatch, "{pas du json")
    with pytest.raises(RuntimeError):
        asyncio.run(floorplan.generate_floorplan("un garage", keys={}))
    assert len(completions.calls) == 2


def test_plan_endpoint_accepte_une_image_sans_description(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import floorplan

    seen = {}

    async def fake_generate(description, keys=None, image=""):
        seen.update(description=description, image=image)
        return floorplan.normalize_plan(GARAGE)

    monkeypatch.setattr(floorplan, "generate_floorplan", fake_generate)
    app = FastAPI()
    app.include_router(floorplan.make_floorplan_router(lambda *a, **k: True), prefix="/api")
    client = TestClient(app)
    assert client.post("/api/floorplan", json={"description": " "}).status_code == 400
    resp = client.post("/api/floorplan", json={"image": _png_data_url()})
    assert resp.status_code == 200 and seen["image"].startswith("data:image/png")
