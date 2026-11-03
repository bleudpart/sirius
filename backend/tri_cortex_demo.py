"""Demonstration autonome Tri-Cortex, sans cle ni reseau : python -m tri_cortex_demo.

Le Cerveau 3 analyse une etiquette fictive pendant que le Cerveau 1 diffuse une reponse ;
un crash volontaire de SanitaryGuard montre que les Cerveaux 1 et 2 restent disponibles.
"""
import argparse
import asyncio
import io
import json
import shutil
import tempfile
import time
from collections.abc import AsyncIterator
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image, ImageDraw

from schemas.haccp import PARIS, EtiquetteVisionOutput
from tri_cortex.runtime import TriCortexOrchestrator
from tri_cortex.schemas import (
    CortexFrame, Job, JsonObject, PriceAuditInput, PriceInput, SanitaryAlert, SanitaryInput, SanitaryResult,
    TaskContext, TaskFailed, TaskPermissionError, VisionResult,
)
from tri_cortex.store import OfflineStore, run_io

KITCHEN = TaskContext(scope="user:demo-cuisine", actor_id="demo-chef")
FINANCE = TaskContext(scope="finance:demo-bistrot", actor_id="demo-gerant")
FINANCE_KINDS = {"price_audit", "financial_analysis", "vision_invoice"}
ANSWER = ["Bonjour chef, ", "la livraison ", "de boeuf ", "est en cours ", "d'analyse ; ", "je reste ", "disponible."]


def _label() -> EtiquetteVisionOutput:
    return EtiquetteVisionOutput(
        nom_produit="Paleron de boeuf TEST - NE PAS CONSOMMER", fournisseur_ou_marque="FOURNISSEUR DEMO",
        numero_lot="DEMO-TRI-001", dlc_ou_ddm=datetime.now(PARIS).date() + timedelta(days=4), type_date="DLC",
        categorie="Viandes", agrement_sanitaire="FR 75.111.001 CE", temperature_stockage="Entre 0 et +3 C (TEST)",
        origines={"naissance": "France", "elevage": ["France"], "abattage": "France", "decoupe": "France"},
        poids_net={"valeur": "4.200", "unite": "kg"}, allergenes=[], traces_allergenes=["Lait"],
        mentions_traces="Peut contenir du lait.", allergenes_lecture="complete",
    )


def _photo(label: EtiquetteVisionOutput) -> bytes:
    image = Image.new("RGB", (640, 220), "white")
    ImageDraw.Draw(image).multiline_text((20, 20), "\n".join([
        "SIMULATION - ETIQUETTE FICTIVE - NE PAS CONSOMMER",
        label.nom_produit, f"Lot : {label.numero_lot} - DLC : {label.dlc_ou_ddm}",
        "Estampille fictive : FR 75.111.001 CE", "Ne, eleve, abattu et decoupe en France",
        "Poids net : 4.200 kg - Conservation : entre 0 et +3 C",
    ]), fill="black", spacing=5)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


async def _authorize(job: Job) -> None:
    """Remplace RuntimeServices.authorize : la demonstration n'utilise aucun compte reel."""
    if (job.input.kind in FINANCE_KINDS) != job.context.scope.startswith("finance:"):
        raise TaskPermissionError("Perimetre incompatible avec cette tache.")


def _summary(frame: CortexFrame) -> JsonObject:
    return {
        "nodes": {node.id: {"status": node.status, "pulse_level": node.pulse_level, "current_task": node.current_task}
                  for node in frame.nodes},
        "satellites": {node.id: {"status": node.status, "pulse_level": node.pulse_level,
                                 "current_task": node.current_task, "completed": node.completed,
                                 "failures": node.failures, "restarts": node.restarts}
                       for node in frame.satellites},
        "edge_flows": [f"{edge.source}->{edge.target} x{edge.count}" for edge in frame.edge_flows],
    }


async def _scenario(root: Path, vision_seconds: float) -> JsonObject:
    label = _label()
    photo = _photo(label)
    started, release = asyncio.Event(), asyncio.Event()
    clock: dict[str, float] = {}
    sanitary_calls = 0

    async def vision_reader(content: bytes, mime_type: str, kind: str) -> VisionResult:
        if content != photo or mime_type != "image/png" or kind != "vision_label":
            raise TaskFailed("Image relue depuis la file durable inattendue.")
        started.set()
        await asyncio.sleep(vision_seconds)  # Latence d'un fournisseur Vision simule.
        await release.wait()
        clock["vision_done"] = time.perf_counter()
        return VisionResult(kind="label", document=label, field_confidence={
            "nom_produit": 0.97, "numero_lot": 0.93, "dlc_ou_ddm": 0.88, "agrement_sanitaire": 0.91,
            "poids_net.valeur": 0.9, "temperature_stockage": None,
        })

    async def sanitary_reader(_scope: str) -> JsonObject:
        nonlocal sanitary_calls
        sanitary_calls += 1
        if sanitary_calls == 1:
            raise RuntimeError("Panne simulee de SanitaryGuard")
        now = datetime.now(PARIS)
        return SanitaryResult(checked_at=now, total_alerts=1, truncated=False, alerts=[SanitaryAlert(
            reception_id=1, kind="rotation", message="Lot DEMO-TRI-001 a utiliser en priorite (FEFO).",
            deadline=now + timedelta(hours=40),
        )]).model_dump(mode="json")

    async def unused(_job: Job) -> JsonObject:
        raise TaskFailed("Non utilise dans cette demonstration.")

    core = TriCortexOrchestrator(
        OfflineStore(root / "tri_cortex.sqlite3"), authorize=_authorize, vision_reader=vision_reader,
        sanitary_reader=sanitary_reader, archive_handler=unused, financial_handler=unused,
        heartbeat_interval=0.1, retry_delay=0.1,
    )
    scopes = frozenset({KITCHEN.scope, FINANCE.scope})
    await core.start()
    try:
        vision_job = await core.vision(KITCHEN, photo, "image/png", "vision_label", "demo-scan-1")
        await asyncio.wait_for(started.wait(), 5)
        crashed = await core.brain3.submit(KITCHEN, SanitaryInput(), "demo-sanitary-crash")

        async def llm() -> AsyncIterator[str]:
            for chunk in ANSWER:
                await asyncio.sleep(0.05)
                yield chunk

        chunks = []
        async for chunk in core.stream(KITCHEN.scope, llm()):
            clock.setdefault("first_fragment", time.perf_counter())
            chunks.append(chunk)
        if (await run_io(core.store.get, vision_job.id, frozenset({KITCHEN.scope}))).state != "running":
            raise RuntimeError("Vision devait encore etre en cours pendant le dialogue.")
        during = core.telemetry.frame(scopes)
        try:
            await core.brain3.wait(crashed, timeout=5)
            raise RuntimeError("La panne simulee de SanitaryGuard aurait du echouer.")
        except TaskFailed:
            pass
        brain2_alive = await core.brain2.run(KITCHEN.scope, "verification_disponibilite",
                                             lambda: asyncio.sleep(0, result=True))
        release.set()
        vision = VisionResult.model_validate(await core.brain3.wait(vision_job, timeout=10))
        if clock["first_fragment"] >= clock["vision_done"]:
            raise RuntimeError("Le Cerveau 1 a attendu le Cerveau 3 : isolation non respectee.")

        deadline = time.monotonic() + 5
        while core.telemetry.restarts["sanitary_guard"] < 1 or not core.brain3.agents["sanitary_guard"].running:
            if time.monotonic() > deadline:
                raise RuntimeError("SanitaryGuard n'a pas ete relance par Sentinel.")
            await asyncio.sleep(0.05)
        sanitary = SanitaryResult.model_validate(await core.brain3.wait(
            await core.brain3.submit(KITCHEN, SanitaryInput(), "demo-sanitary-after-restart"), timeout=5,
        ))
        audit = await core.brain3.wait(await core.brain3.submit(FINANCE, PriceInput(values=PriceAuditInput(
            supplier_id="FOURNISSEUR-DEMO", product_id="PALERON-DEMO", baseline_reference="BL-DEMO-001",
            current_reference="BL-DEMO-002", currency="EUR", unit="kg",
            period={"start_date": "2026-01-01", "end_date": "2026-01-31"},
            previous_unit_price_ht="14.80", current_unit_price_ht="16.20", quantity="120",
            revenue_ht="48000", food_cost_before_ht="14400", other_variable_costs_ht="3600",
            fixed_costs_ht="21000", sources_confirmed=True,
        )), "demo-price-audit"), timeout=5)
        final = core.telemetry.frame(scopes)
        document = vision.document
        return {
            "simulation": True,
            "brain_1": {"reponse": "".join(chunks),
                        "premier_fragment_avant_fin_vision_ms": round(
                            (clock["vision_done"] - clock["first_fragment"]) * 1000)},
            "brain_2_disponible_pendant_panne": brain2_alive,
            "vision": {
                "produit": document.nom_produit, "lot": document.numero_lot,
                "dlc": document.dlc_ou_ddm.isoformat() if document.dlc_ou_ddm else None,
                "estampille": document.agrement_sanitaire, "confiance": vision.field_confidence,
                "methode_confiance": vision.confidence_method,
                "controle_humain_requis": vision.requires_human_review, "points_a_verifier": vision.issues,
            },
            "sanitary_guard": {"relances": core.telemetry.restarts["sanitary_guard"],
                               "alertes": [alert.message for alert in sanitary.alerts],
                               "stock_physique_verifie": sanitary.physical_stock_verified},
            "margin_audit": {key: audit[key] for key in (
                "price_change_percent", "food_cost_delta_ht", "food_cost_after_percent",
                "break_even_before_ht", "break_even_after_ht", "accounting_written")},
            "zeus_cortex_pendant_analyse": _summary(during),
            "zeus_cortex_final": _summary(final),
        }
    finally:
        release.set()
        await core.stop()
        if any(agent.running for agent in core.brain3.agents.values()):
            raise RuntimeError("Un subagent est reste actif apres l'arret.")


def run_demo(*, vision_seconds: float = 1.0, keep: Path | None = None) -> JsonObject:
    """Utilise une file SQLite temporaire dediee, jamais le dossier de donnees de SIRIUS."""
    if vision_seconds < 0:
        raise ValueError("La duree Vision simulee doit etre positive.")
    if keep is not None:
        keep = keep.resolve()
        keep.mkdir(parents=True, mode=0o700, exist_ok=False)
        return asyncio.run(_scenario(keep, vision_seconds))
    root = Path(tempfile.mkdtemp(prefix="sirius-tricortex-"))
    try:
        return asyncio.run(_scenario(root, vision_seconds))
    finally:
        shutil.rmtree(root)


def main() -> None:
    parser = argparse.ArgumentParser(description="Simulation Tri-Cortex hors ligne (donnees fictives).")
    parser.add_argument("--vision-secondes", type=float, default=1.0, help="latence Vision simulee")
    parser.add_argument("--conserver", type=Path, help="nouveau dossier ou garder la file SQLite de la simulation")
    args = parser.parse_args()
    print(json.dumps(run_demo(vision_seconds=args.vision_secondes, keep=args.conserver), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
