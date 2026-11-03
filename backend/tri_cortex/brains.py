"""Les Cerveaux 1 et 2 sont des appels directs, sans worker ni file d'attente."""
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import contextmanager
from decimal import Decimal, localcontext
from typing import TypeVar

from kpi_engine import ratio
from schemas.finance import FINANCE_CONTEXT, HUNDRED, ZERO, money
from schemas.haccp import EtiquetteVisionOutput
from services.haccp_vision import verifier_reception
from tri_cortex.schemas import (
    InvoiceDocument, JsonObject, PriceAuditInput, PriceAuditResult, TaskContext, VisionResult,
)
from tri_cortex.store import run_io
from tri_cortex.telemetry import Telemetry

T = TypeVar("T")


class Brain1FastStream:
    def __init__(self, telemetry: Telemetry):
        self.telemetry = telemetry

    async def stream(self, scope: str, source: AsyncIterator[str]) -> AsyncIterator[str]:
        start = time.perf_counter()
        first = True
        with self.telemetry.measure(scope, "brain_1", "dialogue_stream") as metrics:
            async for chunk in source:
                if chunk and first:
                    metrics.first_token_ms = max(0, (time.perf_counter() - start) * 1000)
                    first = False
                yield chunk

    async def answer(self, scope: str, operation: Callable[[], Awaitable[T]]) -> T:
        with self.telemetry.measure(scope, "brain_1", "dialogue"):
            return await operation()

    async def publish(self, context: TaskContext, task_id: str, result: JsonObject) -> JsonObject:
        with self.telemetry.measure(context.scope, "brain_1", "hud_result"):
            self.telemetry.flow(context.scope, "brain_2", "brain_1", task_id, "hud_result")
            return result


class Brain2DeepReasoning:
    def __init__(self, telemetry: Telemetry):
        self.telemetry = telemetry

    @contextmanager
    def activity(self, scope: str, task: str) -> Iterator[None]:
        with self.telemetry.measure(scope, "brain_2", task):
            yield
        self.telemetry.flow(scope, "brain_2", "brain_1")

    async def run(self, scope: str, task: str, operation: Callable[[], Awaitable[T]]) -> T:
        with self.telemetry.measure(scope, "brain_2", task):
            return await operation()

    async def stream(self, scope: str, source: AsyncIterator[str]) -> AsyncIterator[str]:
        with self.telemetry.measure(scope, "brain_2", "raisonnement_stream"):
            async for chunk in source:
                self.telemetry.flow(scope, "brain_2", "brain_1")
                yield chunk

    async def validate_vision(self, context: TaskContext, result: VisionResult, task_id: str) -> VisionResult:
        self.telemetry.flow(context.scope, "vision", "brain_2", task_id)
        return await self.run(context.scope, "validation_document", lambda: run_io(self._validate, result))

    @staticmethod
    def _validate(result: VisionResult) -> VisionResult:
        document = result.document
        issues = list(result.issues)
        scores = dict(result.field_confidence)
        if isinstance(document, EtiquetteVisionOutput):
            document = verifier_reception(document)
            for name in document.champs_incertains:
                for path in scores:
                    if path == name or path.startswith(name + "."):
                        scores[path] = None
            if document.commentaire_anomalie:
                issues.append(document.commentaire_anomalie)
            issues.append("Lecture uniquement : temperature mesuree, chaine du froid et etat physique a verifier.")
        elif isinstance(document, InvoiceDocument):
            issues.extend(Brain2DeepReasoning._invoice_issues(document))
            issues.append("Fournisseur commercial, prix, affectation et TVA deductible a confirmer ; aucune ecriture.")
        return result.model_copy(update={
            "document": document, "field_confidence": scores, "issues": list(dict.fromkeys(issues)),
        })

    @staticmethod
    def _invoice_issues(document: InvoiceDocument) -> list[str]:
        issues = []
        if any(value is None for value in (document.supplier, document.invoice_number, document.date, document.currency)):
            issues.append("Identite, date ou devise de facture incomplete.")
        with localcontext(FINANCE_CONTEXT):
            totals = (document.amount_ht, document.amount_vat, document.amount_ttc)
            if all(value is not None for value in totals):
                if document.amount_ht + document.amount_vat != document.amount_ttc:
                    issues.append("Total incoherent : HT + TVA ne correspond pas au TTC.")
            else:
                issues.append("Totaux incomplets : rapprochement impossible.")
            for index, line in enumerate(document.lines, 1):
                if line.quantity is not None and line.unit_price_ht is not None and line.amount_ht is not None:
                    if money(line.quantity * line.unit_price_ht) != line.amount_ht:
                        issues.append(f"Ligne {index} : quantite x prix unitaire different du HT (remise a verifier).")
                if line.amount_ht is not None and line.vat_rate is not None and line.amount_vat is not None:
                    if money(line.amount_ht * line.vat_rate / HUNDRED) != line.amount_vat:
                        issues.append(f"Ligne {index} : TVA differente du calcul au taux indique.")
            for field in ("amount_ht", "amount_vat"):
                total = getattr(document, field)
                values = [getattr(line, field) for line in document.lines]
                if total is not None and values and all(value is not None for value in values):
                    if sum(values, ZERO) != total:
                        issues.append(f"Somme des lignes differente du total {field}.")
        return issues

    async def audit_prices(self, context: TaskContext, values: PriceAuditInput, task_id: str) -> PriceAuditResult:
        self.telemetry.flow(context.scope, "margin_audit", "brain_2", task_id)
        return await self.run(context.scope, "calcul_marges", lambda: run_io(self._prices, values))

    @staticmethod
    def _prices(values: PriceAuditInput) -> PriceAuditResult:
        issues: list[str] = []
        with localcontext(FINANCE_CONTEXT):
            delta = values.current_unit_price_ht - values.previous_unit_price_ht
            cost_delta = money(delta * values.quantity)
            after = values.food_cost_before_ht + cost_delta
            revenue = values.revenue_ht
            price_percent = ratio(delta, values.previous_unit_price_ht)
            if price_percent is None:
                issues.append("Prix de reference nul : variation en pourcentage non calculable.")
            before_percent = ratio(values.food_cost_before_ht, revenue)
            after_percent = ratio(after, revenue)
            if not revenue:
                issues.append("Chiffre d'affaires nul : food cost en pourcentage et point mort non calculables.")

            def break_even(food_cost: Decimal, label: str) -> Decimal | None:
                contribution = revenue - food_cost - values.other_variable_costs_ht
                if not revenue or contribution <= ZERO:
                    if revenue:
                        issues.append(f"Marge sur couts variables {label} non positive : aucun point mort fini.")
                    return None
                return money(values.fixed_costs_ht * revenue / contribution)

            before_break = break_even(values.food_cost_before_ht, "avant")
            after_break = break_even(after, "apres")
            return PriceAuditResult(
                currency=values.currency, unit_price_delta_ht=delta, price_change_percent=price_percent,
                food_cost_delta_ht=cost_delta, food_cost_after_ht=after,
                food_cost_before_percent=before_percent, food_cost_after_percent=after_percent,
                contribution_margin_after_ht=revenue - after - values.other_variable_costs_ht,
                break_even_before_ht=before_break, break_even_after_ht=after_break, issues=issues,
            )
