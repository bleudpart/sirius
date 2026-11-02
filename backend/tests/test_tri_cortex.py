import asyncio
import json
import os
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from schemas.haccp import EtiquetteVisionOutput
from tri_cortex.brains import Brain2DeepReasoning
from tri_cortex.runtime import TriCortexOrchestrator
from tri_cortex.schemas import (
    InvoiceDocument, PriceAuditInput, QueueUnavailable, RetryableTaskError, SanitaryInput,
    TaskConflict, TaskContext, TaskFailed, TaskPending, TaskPermissionError, VisionInput, VisionResult,
)
from tri_cortex.services import ArchiveService
from tri_cortex.store import INPUT_ADAPTER, OfflineStore
from tri_cortex.telemetry import EventBus, Telemetry
from tri_cortex.vision import _parse


def label():
    return VisionResult(
        kind="label", document=EtiquetteVisionOutput(
            nom_produit="PRODUIT-PRIVE", numero_lot="LOT-PRIVE", dlc_ou_ddm="2099-12-31",
            type_date="DLC", allergenes_lecture="complete",
        ), field_confidence={"nom_produit": 0.94, "numero_lot": None},
    )


async def allow(_job):
    return None


async def empty(_value):
    return {}


def runtime(tmp_path, reader, **kwargs):
    return TriCortexOrchestrator(
        OfflineStore(tmp_path / "cortex.sqlite3"), authorize=allow, vision_reader=reader,
        sanitary_reader=empty, financial_handler=empty, archive_handler=empty,
        heartbeat_interval=0.01, retry_delay=0.01, **kwargs,
    )


async def until(condition, timeout=4):
    start = time.monotonic()
    while not condition():
        if time.monotonic() - start > timeout:
            raise AssertionError("Condition asynchrone non satisfaite")
        await asyncio.sleep(0.01)


def test_vision_brain2_hud_during_live_dialogue_and_scoped_metrics(tmp_path):
    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()

        async def reader(*_args):
            started.set()
            await release.wait()
            return label()

        core = runtime(tmp_path, reader)
        await core.start()
        try:
            context = TaskContext(scope="user:one", actor_id="one")
            job = await core.vision(context, b"simulated", "image/png", "vision_label", "capture-1")
            await asyncio.wait_for(started.wait(), 2)

            async def fast_stream():
                yield "Bonjour"
                yield " cuisine."

            answer = await asyncio.wait_for(
                collect(core.stream(context.scope, fast_stream())), timeout=0.5,
            )
            assert answer == "Bonjour cuisine."
            assert core.store.get(job.id, frozenset({context.scope})).state == "running"
            frame = core.telemetry.frame(frozenset({context.scope}))
            assert len(frame.nodes) == 3 and len(frame.satellites) == 4
            assert next(item for item in frame.satellites if item.id == "vision").pulse_level == 1
            assert frame.nodes[0].first_token_ms is not None
            assert all(0 <= item.pulse_level <= 1 for item in frame.nodes + frame.satellites)
            serialized = frame.model_dump_json()
            assert "PRODUIT-PRIVE" not in serialized and "LOT-PRIVE" not in serialized
            foreign = core.telemetry.frame(frozenset({"user:two"}))
            assert not foreign.edge_flows
            assert all(item.completed == 0 and item.current_task is None for item in foreign.nodes + foreign.satellites)
            release.set()
            result = VisionResult.model_validate(await core.brain3.wait(job))
            assert result.requires_human_review
            assert result.field_confidence["numero_lot"] is None
            edges = {(event.source, event.target) for event in core.bus.flows}
            assert {("vision", "brain_2"), ("brain_2", "brain_1")} <= edges
        finally:
            release.set()
            await core.stop()
        assert all(not agent.running for agent in core.brain3.agents.values())
        assert core.telemetry.states["brain_3"] == "stopped"

    asyncio.run(scenario())


async def collect(stream):
    return "".join([chunk async for chunk in stream])


def test_worker_crash_isolated_and_supervised_restart(tmp_path):
    async def scenario():
        calls = 0

        async def reader(*_args):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("PRIVATE PROVIDER DETAIL")
            return label()

        core = runtime(tmp_path, reader)
        await core.start()
        try:
            context = TaskContext(scope="user:one", actor_id="one")
            failed = await core.vision(context, b"first", "image/png", "vision_label", "first")
            with pytest.raises(TaskFailed, match="Analyse refusee"):
                await core.brain3.wait(failed)
            assert await core.brain1.answer(context.scope, lambda: asyncio.sleep(0, result="OK")) == "OK"
            assert await core.brain2.run(context.scope, "test", lambda: asyncio.sleep(0, result=42)) == 42
            second = await core.vision(context, b"second", "image/png", "vision_label", "second")
            result = await core.brain3.wait(second, timeout=4)
            assert result["kind"] == "label"
            assert core.telemetry.restarts["vision"] == 1
            assert "PRIVATE PROVIDER DETAIL" not in core.telemetry.frame(frozenset({context.scope})).model_dump_json()
        finally:
            await core.stop()

    asyncio.run(scenario())


def test_offline_retry_is_bounded_and_survives_new_runtime(tmp_path):
    async def scenario():
        started = asyncio.Event()

        async def interrupted(*_args):
            started.set()
            await asyncio.Event().wait()

        core = runtime(tmp_path, interrupted)
        await core.start()
        context = TaskContext(scope="user:one", actor_id="one")
        job = await core.vision(context, b"persistent-original", "image/png", "vision_label", "persistent")
        await asyncio.wait_for(started.wait(), 2)
        await core.stop()
        assert core.store.get(job.id, frozenset({context.scope})).state == "retry"

        calls = 0

        async def unavailable(*_args):
            nonlocal calls
            calls += 1
            raise RetryableTaskError("Fournisseur indisponible")

        resumed = runtime(tmp_path, unavailable)
        await resumed.start()
        try:
            await until(lambda: resumed.store.get(job.id, frozenset({context.scope})).state == "failed")
            assert calls == 2
            assert resumed.store.get(job.id, frozenset({context.scope})).attempts == 3
            assert resumed.store.image(context.scope, job.input.image_digest, "image/png") == b"persistent-original"
        finally:
            await resumed.stop()

    asyncio.run(scenario())


def test_queue_idempotency_concurrency_conflict_and_backpressure(tmp_path):
    store = OfflineStore(tmp_path / "queue.sqlite3", capacity=1)
    store.initialize()
    context = TaskContext(scope="user:one", actor_id="one")
    payload = VisionInput(kind="vision_label", image_digest="a" * 64, mime_type="image/png")
    with ThreadPoolExecutor(max_workers=8) as pool:
        jobs = list(pool.map(lambda _index: store.put(context, payload, "same"), range(16)))
    assert len({job.id for job in jobs}) == 1
    with pytest.raises(TaskConflict):
        store.put(context, payload.model_copy(update={"image_digest": "b" * 64}), "same")
    with pytest.raises(QueueUnavailable):
        store.put(context, payload, "different")
    with pytest.raises(LookupError):
        store.get(jobs[0].id, frozenset({"user:two"}))
    with ThreadPoolExecutor(max_workers=8) as pool:
        claims = list(pool.map(lambda index: store.claim(jobs[0].id, str(index), 60), range(8)))
    assert sum(job is not None for job in claims) == 1


def test_bus_backpressure_drops_only_notifications_not_durable_results():
    bus = EventBus(capacity=1)
    telemetry = Telemetry(bus)
    with bus.subscribe(frozenset({"user:one"})) as own, bus.subscribe(frozenset({"user:two"})) as other:
        telemetry.flow("user:one", "vision", "brain_2", "one")
        telemetry.flow("user:one", "brain_2", "brain_1", "two")
        assert own.qsize() == 1 and other.empty()
        assert telemetry.frame(frozenset({"user:one"})).dropped_events == 1
        assert telemetry.frame(frozenset({"user:two"})).dropped_events == 0


def prices(**changes):
    return PriceAuditInput.model_validate({
        "supplier_id": "supplier-1", "product_id": "beef-1", "baseline_reference": "BL-1",
        "current_reference": "BL-2", "currency": "EUR", "unit": "kg",
        "period": {"start_date": "2026-01-01", "end_date": "2026-01-31"},
        "previous_unit_price_ht": "10", "current_unit_price_ht": "12", "quantity": "100",
        "revenue_ht": "5000", "food_cost_before_ht": "2000", "other_variable_costs_ht": "500",
        "fixed_costs_ht": "1000", "sources_confirmed": True, **changes,
    })


def test_financial_calculation_is_exact_and_no_accounting_write():
    result = Brain2DeepReasoning._prices(prices())
    assert result.price_change_percent == Decimal("20")
    assert Brain2DeepReasoning._prices(prices(
        previous_unit_price_ht="14.80", current_unit_price_ht="16.20",
    )).price_change_percent == Decimal("9.46")
    assert result.food_cost_delta_ht == Decimal("200.00")
    assert result.food_cost_after_percent == Decimal("44")
    assert result.break_even_before_ht == Decimal("2000.00")
    assert result.break_even_after_ht == Decimal("2173.91")
    assert result.accounting_written is False
    assert json.loads(result.model_dump_json())["food_cost_delta_ht"] == "200.00"
    with pytest.raises(ValidationError):
        prices(current_unit_price_ht=12.1)
    with pytest.raises(ValidationError):
        prices(sources_confirmed=False)
    with pytest.raises(ValidationError):
        prices(food_cost_before_ht="10")


def test_zero_revenue_and_nonpositive_contribution_do_not_invent_break_even():
    no_revenue = Brain2DeepReasoning._prices(prices(revenue_ht="0"))
    assert no_revenue.food_cost_after_percent is None and no_revenue.break_even_after_ht is None
    loss = Brain2DeepReasoning._prices(prices(revenue_ht="2000"))
    assert loss.break_even_after_ht is None and loss.issues


def test_confidence_unknown_invalid_and_partial_fields():
    parsed = label().model_dump(mode="json")
    parsed["document"]["dlc_ou_ddm"] = "04/12/26"
    parsed["field_confidence"]["dlc_ou_ddm"] = 0.99
    result = Brain2DeepReasoning._validate(_parse(parsed, "vision_label"))
    assert result.document.dlc_ou_ddm is None
    assert result.field_confidence["dlc_ou_ddm"] is None
    assert result.requires_human_review
    for invalid in (-0.1, 1.1, float("nan"), True, "0.9"):
        with pytest.raises(ValidationError):
            VisionResult.model_validate(label().model_dump() | {"field_confidence": {"nom_produit": invalid}})
    with pytest.raises(ValidationError):
        VisionResult.model_validate(label().model_dump() | {"field_confidence": {"secret": 0.9}})


def test_invoice_validation_flags_vat_and_totals_without_rewriting():
    document = InvoiceDocument.model_validate({
        "supplier": "TEST", "invoice_number": "F-1", "currency": "EUR", "date": "2026-01-01",
        "lines": [{"quantity": "2", "unit_price_ht": "10", "amount_ht": "20",
                   "amount_vat": "3", "vat_rate": "20"}],
        "amount_ht": "21", "amount_vat": "3", "amount_ttc": "99",
    })
    result = Brain2DeepReasoning._validate(VisionResult(kind="invoice", document=document, field_confidence={}))
    assert result.document.amount_ttc == Decimal("99")
    assert any("Total incoherent" in issue for issue in result.issues)
    assert any("TVA differente" in issue for issue in result.issues)
    assert result.requires_human_review


def test_archive_purge_only_known_cache_files_and_never_originals(tmp_path):
    service = ArchiveService(root=tmp_path)
    bucket = service._bucket("user:one")
    candidate = bucket / ("preview_12_" + "a" * 64 + ".jpg")
    other = bucket / "original.jpg"
    original = tmp_path / "REC_TEST_ORIGINAL.jpg"
    for path in (candidate, other, original):
        path.write_bytes(b"unchanged")
        old = (datetime.now(timezone.utc) - timedelta(days=8)).timestamp()
        os.utime(path, (old, old))
    result = service.purge_caches("user:one", datetime.now(timezone.utc))
    assert result["deleted_cache_files"] == 1 and result["originals_deleted"] == 0
    assert not candidate.exists()
    assert other.read_bytes() == original.read_bytes() == b"unchanged"
    with pytest.raises(ValidationError):
        INPUT_ADAPTER.validate_python({"kind": "purge_originals"})


@pytest.mark.parametrize("column,value", [("input_json", "{broken"), ("agent", "archivist")])
def test_corrupt_payload_is_quarantined_without_repeated_worker_crashes(tmp_path, caplog, column, value):
    store = OfflineStore(tmp_path / "queue.sqlite3")
    store.initialize()
    context = TaskContext(scope="user:one", actor_id="one")
    broken = store.put(context, SanitaryInput(), "broken")
    valid = store.put(context, SanitaryInput(), "valid")
    with store.connection(write=True) as connection:
        connection.execute(f"UPDATE cortex_jobs SET {column}=? WHERE id=?", (value, broken.id))
    assert store.claim(broken.id, "worker", 60) is None
    with store.connection() as connection:
        row = connection.execute("SELECT state, error_code, input_json FROM cortex_jobs WHERE id=?", (broken.id,)).fetchone()
    assert row["state"] == "failed" and row["error_code"] == "IntegrityError"
    if column == "input_json":
        assert row["input_json"] == "{broken"
    assert "quarantaine" in caplog.text
    assert broken.id not in store.due("sanitary_guard")
    assert store.claim(valid.id, "worker", 60).id == valid.id
    with pytest.raises(ValueError):
        store.get(broken.id, frozenset({context.scope}))


def test_manual_retry_cannot_bypass_queue_capacity(tmp_path):
    store = OfflineStore(tmp_path / "queue.sqlite3", capacity=1)
    store.initialize()
    context = TaskContext(scope="user:one", actor_id="one")
    first = store.put(context, SanitaryInput(), "first")
    claimed = store.claim(first.id, "worker", 60)
    store.fail(claimed, "worker", "Test", "Test", False, 0)
    second = store.put(context, SanitaryInput(), "second")
    with pytest.raises(QueueUnavailable):
        store.retry(first.id, frozenset({context.scope}), "one")
    assert store.get(first.id, frozenset({context.scope})).state == "failed"
    store.claim(second.id, "worker", 60)
    store.finish(second.id, "worker", {"ok": True})
    retried = store.retry(first.id, frozenset({context.scope}), "one")
    assert retried.state == "pending" and retried.attempts == 0


def test_manual_retry_reauthorizes_before_any_provider_call(tmp_path):
    async def scenario():
        reader = AsyncMock(return_value=label())
        core = runtime(tmp_path, reader)
        deny = AsyncMock(side_effect=TaskPermissionError("Droits revoques"))
        core.brain3.agents["vision"].authorize = deny
        await core.start()
        try:
            context = TaskContext(scope="company:a", actor_id="one")
            job = await core.vision(context, b"example", "image/png", "vision_label", "capture")
            with pytest.raises(TaskFailed, match="Droits revoques"):
                await core.brain3.wait(job)
            retried = core.store.retry(job.id, frozenset({context.scope}), "one")
            with pytest.raises(TaskFailed, match="Droits revoques"):
                await core.brain3.wait(retried)
            assert deny.await_count == 2
            reader.assert_not_awaited()
        finally:
            await core.stop()
    asyncio.run(scenario())


def test_worker_timeout_is_bounded_and_does_not_block_dialogue(tmp_path):
    async def scenario():
        async def stalled(*_args):
            await asyncio.Event().wait()

        core = runtime(tmp_path, stalled)
        core.brain3.agents["vision"].timeout = 0.02
        await core.start()
        try:
            context = TaskContext(scope="user:one", actor_id="one")
            job = await core.vision(context, b"example", "image/png", "vision_label", "timeout")
            await until(lambda: core.store.get(job.id, frozenset({context.scope})).state == "failed")
            saved = core.store.get(job.id, frozenset({context.scope}))
            assert saved.attempts == 3 and saved.error_code == "RetryableTaskError"
            assert await core.brain1.answer(context.scope, lambda: asyncio.sleep(0, result="OK")) == "OK"
            assert core.brain3.agents["vision"].running
        finally:
            await core.stop()
    asyncio.run(scenario())


def test_missing_confidence_and_missing_nested_values_remain_unknown():
    parsed = label().model_dump(mode="json")
    parsed.pop("field_confidence")
    result = _parse(parsed, "vision_label")
    assert result.document.nom_produit == "PRODUIT-PRIVE"
    assert all(value is None for value in result.field_confidence.values())
    parsed["field_confidence"] = {"origines.naissance": 0.9, "poids_net.valeur": 0.95}
    result = _parse(parsed, "vision_label")
    assert result.field_confidence["origines.naissance"] is None
    assert result.field_confidence["poids_net.valeur"] is None


def test_large_invoice_confidence_parsing_serializes_document_constant_times(monkeypatch):
    dumps = 0
    original = InvoiceDocument.model_dump

    def counted(self, *args, **kwargs):
        nonlocal dumps
        dumps += 1
        return original(self, *args, **kwargs)

    monkeypatch.setattr(InvoiceDocument, "model_dump", counted)
    parsed = {
        "kind": "invoice",
        "document": {"supplier": "TEST", "lines": [{"quantity": "1", "unit_price_ht": "2"} for _ in range(500)]},
        "field_confidence": {"lines.499.unit_price_ht": 0.8},
    }
    result = _parse(parsed, "vision_invoice")
    assert len(result.document.lines) == 500
    assert result.field_confidence["lines.499.unit_price_ht"] == 0.8
    assert dumps <= 3


def test_offline_demo_runs_dialogue_during_vision_and_cleans_its_queue(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    from tri_cortex_demo import run_demo

    report = run_demo(vision_seconds=0.05)
    assert report["simulation"] is True
    assert report["brain_1"]["premier_fragment_avant_fin_vision_ms"] > 0
    assert report["brain_2_disponible_pendant_panne"] is True
    assert report["vision"]["controle_humain_requis"] is True
    assert report["vision"]["confiance"]["temperature_stockage"] is None
    assert report["sanitary_guard"]["relances"] == 1
    assert report["margin_audit"]["price_change_percent"] == "9.46"
    assert report["margin_audit"]["accounting_written"] is False
    during = report["zeus_cortex_pendant_analyse"]
    assert len(during["nodes"]) == 3 and len(during["satellites"]) == 4
    assert during["satellites"]["vision"]["pulse_level"] == 1
    assert {"vision->brain_2 x1", "brain_2->brain_1 x2"} <= set(report["zeus_cortex_final"]["edge_flows"])
    assert list(tmp_path.iterdir()) == []
