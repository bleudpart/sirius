"""Exemple autonome, sans reseau ni imprimante : python -m haccp_reception_demo."""
import argparse
import io
import json
import os
import tempfile
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from sqlalchemy.exc import OperationalError

import haccp_database
import services.haccp_reception as pipeline
import services.haccp_vision as vision
from routers.haccp import make_haccp_router
from schemas.haccp import PARIS, EtiquetteVisionOutput
from schemas.haccp_reception import DESTINATIONS


def _sample_photo(label: EtiquetteVisionOutput) -> bytes:
    if label.dlc_ou_ddm is None or label.fournisseur_ou_marque is None:
        raise ValueError("L'etiquette de demonstration doit preciser sa date et son fournisseur fictifs.")
    image = Image.new("RGB", (640, 280), "white")
    ImageDraw.Draw(image).multiline_text((20, 20), "\n".join([
        "SIMULATION - ETIQUETTE FICTIVE - NE PAS CONSOMMER",
        label.nom_produit, label.fournisseur_ou_marque,
        f"Lot : {label.numero_lot} - DLC : {label.dlc_ou_ddm.isoformat()}",
        "Estampille fictive : FR 75.111.001 CE",
        "Ne, eleve, abattu et decoupe en France",
        "Poids net : 3.500 kg - Conservation : entre 0 et +3 C",
        "Allergenes declares : " + (", ".join(label.allergenes) or "aucun mentionne"),
        "Traces possibles : Lait",
    ]), fill="black", spacing=5)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def run_demo(output: Path) -> dict:
    """Refuse tout dossier existant et tout moteur deja ouvert dans ce processus."""
    if haccp_database._configured_engine.cache_info().currsize:
        raise RuntimeError("Lancez cet exemple dans un processus Python distinct du serveur.")
    output = output.resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    due = datetime.now(PARIS).date() + timedelta(days=4)
    labels = [EtiquetteVisionOutput(
        nom_produit="Boeuf marine TEST - NE PAS CONSOMMER", fournisseur_ou_marque="FOURNISSEUR DEMO",
        numero_lot=f"DEMO-{index}", dlc_ou_ddm=due, type_date="DLC", categorie="Viandes",
        agrement_sanitaire="FR 75.111.001 CE", temperature_stockage="Entre 0 et +3 C (TEST)",
        origines={"naissance": "France", "elevage": ["France"], "abattage": "France", "decoupe": "France"},
        poids_net={"valeur": "3.500", "unite": "kg"},
        allergenes=["Moutarde"] if index == 2 else [], traces_allergenes=["Lait"],
        mentions_traces="Peut contenir du lait.", allergenes_lecture="complete",
    ) for index in (1, 2)]
    create = AsyncMock(side_effect=[SimpleNamespace(choices=[
        SimpleNamespace(finish_reason="stop", message=SimpleNamespace(content=label.model_dump_json())),
    ]) for label in labels])
    provider = AsyncMock()
    provider.__aenter__.return_value = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    async def scope(request: Request) -> str:
        if request.headers.get("x-sirius-demo") != "simulation":
            raise HTTPException(401, "Session de demonstration requise.")
        return "demo:reception"
    app = FastAPI()
    app.include_router(make_haccp_router(scope), prefix="/api")
    actual_stock_writer = pipeline._write_stock
    def simulate_stock_failure(db, source, document):
        actual_stock_writer(db, source, document)
        db.flush()
        if document.reception_id == 1:
            raise OperationalError("DEMONSTRATION: panne stock simulee apres INSERT", {}, None)
    def checked(response):
        response.raise_for_status()
        return response.json()
    with patch.dict(os.environ, {
        "SIRIUS_DATA_DIR": str(output), "SIRIUS_CLOUD_RELAY": "0", "OPENAI_API_KEY": "simulation-no-real-key",
    }), patch.object(vision, "AsyncOpenAI", return_value=provider):
        try:
            with TestClient(app, headers={"x-sirius-demo": "simulation"}) as client:
                captures = []
                with patch.object(pipeline, "_write_stock", simulate_stock_failure):
                    for label in labels:
                        captures.append(checked(client.post("/api/haccp/etiquettes/scan", data={
                            "restaurant_name": "Restaurant FICTIF", "operateur": "DEMONSTRATION",
                            "capture_id": str(uuid.uuid4()),
                        }, files={"file": ("viande-demo.png", _sample_photo(label), "image/png")})))
                resumed = checked(client.post(f"/api/haccp/receptions/{captures[0]['id']}/reprise"))
                views = {name: checked(client.get(f"/api/haccp/receptions/destinations/{name}")) for name in DESTINATIONS}
                integrity = checked(client.get("/api/haccp/receptions/integrite"))
                opening = checked(client.post(f"/api/haccp/receptions/{captures[1]['id']}/ouverture", json={
                    "capture_id": str(uuid.uuid4()), "operateur": "DEMONSTRATION",
                    "duree_conservation_heures": 72, "justification_duree": "PMS FICTIF POUR TEST : 72 h entre 0 et +3 C",
                    "regle_confirmee": True, "ouverture_effectuee": True,
                }))
                html = client.get(f"/api/haccp/registre/{opening['id']}/etiquette")
                html.raise_for_status()
                (output / "etiquette-ouverture-TEST.html").write_text(html.text, encoding="utf-8")
            (output / "A-traceabilite.jsonl").write_text(
                "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in views["traceabilite"]["items"]),
                encoding="utf-8",
            )
            for name, filename in [
                ("stock", "B-stock.json"), ("allergenes", "C-observations-allergenes.json"), ("achats", "D-achats.json"),
            ]:
                (output / filename).write_text(json.dumps(views[name], ensure_ascii=False, indent=2), encoding="utf-8")
            if (captures[0]["distribution"]["statut"] != "partial" or resumed["statut"] != "complete"
                    or not integrity["ok"] or any(view["total"] != 2 for view in views.values())
                    or views["allergenes"]["items"][0]["new_allergens"] != ["Moutarde"] or create.await_count != 2):
                raise RuntimeError("La demonstration n'a pas satisfait toutes les garanties attendues.")
            return {
                "simulation_uniquement": True, "dossier": str(output), "lectures_vision_simulees": create.await_count,
                "panne_stock_reprise_sans_doublon": resumed["statut"] == "complete",
                "receptions_par_destination": {name: view["total"] for name, view in views.items()},
                "nouvel_allergene": "Moutarde", "integrite": integrity,
                "etiquette_ouverture": opening["id"], "impression_reelle": False,
            }
        finally:
            if haccp_database._configured_engine.cache_info().currsize:
                haccp_database.get_engine().dispose()
                haccp_database._configured_engine.cache_clear()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Nouveau dossier pour conserver les sorties fictives ; doit etre inexistant.")
    args = parser.parse_args()
    if args.output:
        if args.output.exists():
            parser.error("Le dossier existe deja : aucun fichier ne sera ecrase.")
        report = run_demo(args.output)
    else:
        with tempfile.TemporaryDirectory(prefix="sirius-reception-demo-") as directory:
            report = run_demo(Path(directory) / "donnees")
        report["dossier"] = "Dossier temporaire nettoye ; utilisez --output pour conserver les fichiers."
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
