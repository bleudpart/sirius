import asyncio
import hashlib
import io
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

import haccp_database
import routers.haccp as haccp_routes
import tri_cortex.vision as vision
from brain_analytical.orchestrator import AnalyticalOrchestrator
from models.haccp import Base
from models.haccp_reception import AllergenObservation, StockLot
from services.haccp_reception import charger_source
from tri_cortex.runtime import TriCortexOrchestrator
from tri_cortex.schemas import FinancialInput, PurgeInput, QueueUnavailable, SanitaryInput, TaskPermissionError
from tri_cortex.services import ArchiveService, RuntimeServices, sanitary_report
from tri_cortex.store import OfflineStore
from test_brain_analytical import NOW, engine
from test_haccp_labels import api as haccp_api, extracted, scan
from test_haccp_reception import counts, request
from test_tri_cortex import allow, empty, label, runtime, until


def test_scanner_sentinel_preserves_four_destinations_and_compresses_only_copy(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "0")
    haccp_database._configured_engine.cache_clear()
    reader = AsyncMock(return_value=label().model_dump(mode="json"))
    monkeypatch.setattr(vision, "demander_document_vision", reader)
    services = RuntimeServices(None, AnalyticalOrchestrator(None), root=tmp_path)
    core = TriCortexOrchestrator(
        OfflineStore(tmp_path / "queue.sqlite3"), authorize=allow, vision_reader=vision.read_vision,
        sanitary_reader=services.sanitary, archive_handler=services.archives.handle, financial_handler=empty,
        heartbeat_interval=0.01,
    )
    services.runtime = core

    async def scope(incoming: Request):
        incoming.state.haccp_actor = "one"
        return "user:one"

    @asynccontextmanager
    async def lifespan(_app):
        await core.start()
        try:
            yield
        finally:
            await core.stop()

    app = FastAPI(lifespan=lifespan)
    app.include_router(haccp_routes.make_haccp_router(
        scope, vision_analyser=services.analyse_label, on_received=services.received,
    ), prefix="/api")
    image = io.BytesIO()
    Image.new("RGB", (2400, 1600), "white").save(image, "PNG")
    content = image.getvalue()
    capture = {"capture_id": str(uuid.uuid4())}
    try:
        with TestClient(app) as client:
            response = scan(client, content=content, data=capture)
            assert response.status_code == 201, response.text
            saved = response.json()
            assert saved["distribution"]["statut"] == "complete"
            assert all(item["statut"] == "done" for item in saved["distribution"]["destinations"])
            raw = tmp_path / saved["chemin_image_brute"]
            original_hash = hashlib.sha256(content).hexdigest()
            assert raw.read_bytes() == content
            assert saved["empreinte_image_brute"] == original_hash

            async def finished():
                await until(lambda: len(core.store.recent(frozenset({"user:one"}))) == 3 and all(
                    job.state == "done" for job in core.store.recent(frozenset({"user:one"}))
                ))
            client.portal.call(finished)
            jobs = core.store.recent(frozenset({"user:one"}))
            report = next(job.result for job in jobs if job.input.kind == "vision_label")
            assert report["requires_human_review"] and report["confidence_method"] == "model_self_report_not_calibrated"
            compressed = next(job.result for job in jobs if job.input.kind == "compress_receipt")
            preview = services.archives._bucket("user:one") / compressed["cache_name"]
            with Image.open(preview) as reduced:
                assert max(reduced.size) <= 1280 and reduced.format == "JPEG"
            assert compressed["preview_bytes"] < len(content)
            assert compressed["original_modified"] is False
            assert raw.read_bytes() == content
            assert request(client, "/integrite").json()["ok"]
            with Session(haccp_database.get_engine()) as session:
                _source, document = charger_source(session, "user:one", saved["id"])
                assert document.model_dump(mode="json")["version"] == 1
                assert "field_confidence" not in document.model_dump_json()
            before = counts()
            duplicate = scan(client, content=content, data=capture)
            assert duplicate.json()["id"] == saved["id"] and counts() == before
            reader.assert_awaited_once()
    finally:
        haccp_database.get_engine().dispose()
        haccp_database._configured_engine.cache_clear()


def test_reused_vision_result_revalidates_current_dlc_without_new_ocr(tmp_path, monkeypatch):
    async def scenario():
        reader = AsyncMock(return_value=label())
        core = runtime(tmp_path, reader)
        services = RuntimeServices(None, AnalyticalOrchestrator(None))
        services.runtime = core
        await core.start()
        try:
            first = await services.analyse_label(b"example", "image/png", "user:one", "capture", "one")
            assert first.conforme_reception
            import tri_cortex.brains as brains
            validate = brains.verifier_reception

            def expired(document):
                return validate(document.model_copy(update={"dlc_ou_ddm": datetime(2000, 1, 1).date()}))

            monkeypatch.setattr(brains, "verifier_reception", expired)
            reused = await services.analyse_label(b"example", "image/png", "user:one", "capture", "one")
            assert not reused.conforme_reception and "DLC depassee" in reused.commentaire_anomalie
            reader.assert_awaited_once()
        finally:
            await core.stop()
    asyncio.run(scenario())


def test_sanitary_guard_48h_boundary_fefo_fifo_ddm_and_new_allergen(haccp_api, monkeypatch):
    client, _root = haccp_api
    monkeypatch.setattr(haccp_routes, "analyser_etiquette_vision", AsyncMock(return_value=extracted(
        allergenes=["Lait"], allergenes_lecture="complete",
    )))
    references = [scan(client).json()["id"] for _ in range(6)]
    haccp_routes.analyser_etiquette_vision.return_value = extracted(
        allergenes=["Lait", "Moutarde"], allergenes_lecture="complete",
    )
    changed = scan(client).json()["id"]
    foreign = scan(client, user="two").json()["id"]
    now = datetime.now(timezone.utc)
    stamp = now.replace(tzinfo=None)
    deadlines = (stamp + timedelta(hours=48), stamp + timedelta(hours=48), stamp + timedelta(hours=48, seconds=1),
                 stamp - timedelta(seconds=1), stamp - timedelta(days=1), None)
    with Session(haccp_database.get_engine()) as session, session.begin():
        for index, (reference, deadline) in enumerate(zip(references, deadlines)):
            row = session.get(StockLot, reference)
            row.deadline = deadline
            row.received_at = stamp - timedelta(days=10 - index)
            if index == 4:
                row.date_type = "DDM"
        observation = session.get(AllergenObservation, changed)
        assert observation.new_allergens == ["Moutarde"]
    report = sanitary_report(haccp_database.get_engine(), "user:one", now)
    rotation = [item.reception_id for item in report.alerts if item.kind == "rotation"]
    assert rotation == [references[4], references[0], references[1]]
    assert [item.reception_id for item in report.alerts if item.kind == "expired_dlc"] == [references[3]]
    assert [item.reception_id for item in report.alerts if item.kind == "date_unknown"] == [references[5]]
    assert any(item.reception_id == changed and "Moutarde" in item.message for item in report.alerts)
    assert all(item.reception_id != foreign for item in report.alerts)
    assert not report.physical_stock_verified


def test_periodic_rotation_covers_more_than_64_scopes_even_when_archive_queue_is_full():
    database = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(database)
    stamp = datetime(2026, 1, 1)
    scopes = [f"user:site-{index:03d}" for index in range(85)]
    with Session(database) as session, session.begin():
        for index, scope in enumerate(scopes, 1):
            session.add(StockLot(
                reception_id=index, scope_key=scope, restaurant_name="TEST", product="TEST", supplier=None,
                lot="TEST", received_at=stamp, date_type="inconnue", deadline=None, alert_at=stamp,
                declared_weight_kg=None, storage=None, label_compliant=False,
            ))
    accepted = []

    async def submit(context, payload, _key):
        if isinstance(payload, PurgeInput):
            raise QueueUnavailable("Archive pleine")
        assert isinstance(payload, SanitaryInput)
        accepted.append(context.scope)

    services = RuntimeServices(None, AnalyticalOrchestrator(None), engine_factory=lambda: database)
    services.runtime = SimpleNamespace(brain3=SimpleNamespace(submit=submit))

    async def scenario():
        await services.periodic()
        assert accepted == scopes[:64]
        await services.periodic()
        assert accepted == scopes
    try:
        asyncio.run(scenario())
    finally:
        database.dispose()


def test_financial_scheduler_is_supervised_by_margin_and_publishes_through_brain2(engine, tmp_path):
    async def scenario():
        db = SimpleNamespace(
            users=SimpleNamespace(find_one=AsyncMock(return_value=None)),
            enterprise_companies=SimpleNamespace(find_one=AsyncMock(return_value={"owner_user_id": "one"})),
        )
        worker = AnalyticalOrchestrator(db, engine_factory=lambda: engine, clock=lambda: NOW,
                                        debounce=0, periodic_start=3600)
        services = RuntimeServices(db, worker)
        core = runtime(tmp_path, AsyncMock(return_value=label()))
        services.runtime = core
        margin = core.brain3.agents["margin_audit"]
        margin.handler = services.financial
        margin.scheduler = worker.loop
        worker.execution_delegate = services.delegate_financial
        worker.executor_available = lambda: margin.running
        entered, release = asyncio.Event(), asyncio.Event()
        original = worker.executer

        async def delayed(signal, number):
            entered.set()
            await release.wait()
            return await original(signal, number)

        worker.executer = delayed
        await core.start()
        try:
            assert worker.notify("a", "one")
            await asyncio.wait_for(entered.wait(), 2)
            assert worker.statut("a").actif and worker.statut("a").en_attente == 1
            assert [task.get_name() for task in asyncio.all_tasks()].count("sentinel:margin_audit:scheduler") == 1
            release.set()
            await until(lambda: worker.statut("a").analyses_terminees == 1 and worker.statut("a").en_attente == 0)
            state = await worker.lire("a")
            assert state.snapshot.company_id == "a"
            job = core.store.recent(frozenset({"finance:a"}))[0]
            assert isinstance(job.input, FinancialInput) and job.state == "done"
            assert job.result == {"published": True, "accounting_written": False}
            flows = {(event.source, event.target) for event in core.bus.flows}
            assert {("margin_audit", "brain_2"), ("brain_2", "brain_1")} <= flows
        finally:
            release.set()
            await core.stop()
        assert not worker.statut("a").actif and worker._queue is None
    asyncio.run(scenario())


@pytest.mark.parametrize("scope,role,permissions,disabled", [
    ("company:a", "employee", [], False),
    ("finance:a", "employee", ["haccp"], False),
    ("user:one", "manager", ["haccp"], True),
])
def test_runtime_permissions_are_rechecked_for_queued_jobs(tmp_path, scope, role, permissions, disabled):
    db = SimpleNamespace(
        users=SimpleNamespace(find_one=AsyncMock(return_value={"user_id": "one", "disabled": disabled})),
        enterprise_members=SimpleNamespace(find_one=AsyncMock(return_value={"role": role, "permissions": permissions})),
    )
    services = RuntimeServices(db, AnalyticalOrchestrator(db))
    store = OfflineStore(tmp_path / "queue.sqlite3")
    store.initialize()
    from tri_cortex.schemas import TaskContext, VisionInput
    job = store.put(
        TaskContext(scope=scope, actor_id="one"),
        VisionInput(kind="vision_label", image_digest="a" * 64, mime_type="image/png"), "test",
    )
    with pytest.raises(TaskPermissionError):
        asyncio.run(services.authorize(job))
