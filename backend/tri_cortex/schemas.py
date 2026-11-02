"""Contrats internes et publics de Sentinel, distincts des preuves HACCP v1."""
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal, TypeAlias

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, JsonValue, StrictBool, model_validator

from schemas.finance import IsoDate, Money, NonNegativeMoney, Period, Percent, Quantity
from schemas.haccp import EtiquetteVisionOutput, OriginesProduit, PoidsNet

JsonObject: TypeAlias = dict[str, JsonValue]
NodeId = Literal["brain_1", "brain_2", "brain_3", "vision", "sanitary_guard", "margin_audit", "archivist"]
AgentId = Literal["vision", "sanitary_guard", "margin_audit", "archivist"]
TaskKind = Literal[
    "vision_label", "vision_invoice", "sanitary_check", "price_audit",
    "financial_analysis", "compress_receipt", "purge_caches",
]
EventKind = Literal["task_queued", "task_started", "task_completed", "task_failed", "hud_result", "flow"]
NodeStatus = Literal["stopped", "idle", "busy", "degraded", "failed"]
TASK_AGENTS: dict[TaskKind, AgentId] = {
    "vision_label": "vision", "vision_invoice": "vision", "sanitary_check": "sanitary_guard",
    "price_audit": "margin_audit", "financial_analysis": "margin_audit",
    "compress_receipt": "archivist", "purge_caches": "archivist",
}
AGENT_IDS: tuple[AgentId, ...] = ("vision", "sanitary_guard", "margin_audit", "archivist")
NODE_IDS: tuple[NodeId, ...] = ("brain_1", "brain_2", "brain_3", *AGENT_IDS)
Confidence = Annotated[float, Field(strict=True, ge=0, le=1, allow_inf_nan=False)]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)


class TaskContext(Contract):
    scope: str = Field(min_length=1, max_length=255, pattern=r"^(user|company|finance):[^\s/\\]+$")
    actor_id: str | None = Field(default=None, min_length=1, max_length=128)


class VisionInput(Contract):
    kind: Literal["vision_label", "vision_invoice"]
    image_digest: Digest
    mime_type: Literal["image/jpeg", "image/png", "image/webp"]


class SanitaryInput(Contract):
    kind: Literal["sanitary_check"] = "sanitary_check"


class PriceAuditInput(Contract):
    """Prix et volumes comparables, confirmes, sur une meme periode et dans une meme devise."""
    supplier_id: str = Field(min_length=1, max_length=128)
    product_id: str = Field(min_length=1, max_length=128)
    baseline_reference: str = Field(min_length=1, max_length=160)
    current_reference: str = Field(min_length=1, max_length=160)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    unit: Literal["kg", "g", "l", "piece"]
    period: Period
    previous_unit_price_ht: Quantity
    current_unit_price_ht: Quantity
    quantity: Quantity
    revenue_ht: NonNegativeMoney
    food_cost_before_ht: NonNegativeMoney
    other_variable_costs_ht: NonNegativeMoney
    fixed_costs_ht: NonNegativeMoney
    sources_confirmed: StrictBool

    @model_validator(mode="after")
    def comparable(self) -> "PriceAuditInput":
        if not self.sources_confirmed:
            raise ValueError("Les sources de comparaison doivent etre confirmees.")
        if self.previous_unit_price_ht * self.quantity > self.food_cost_before_ht:
            raise ValueError("Le cout matiere de reference ne couvre pas le volume indique.")
        return self


class PriceInput(Contract):
    kind: Literal["price_audit"] = "price_audit"
    values: PriceAuditInput


class FinancialInput(Contract):
    kind: Literal["financial_analysis"] = "financial_analysis"
    company_id: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    trigger: Literal["EVENEMENT", "SEUIL", "PERIODIQUE", "MANUEL"]
    signals: int = Field(default=1, ge=1)
    attempt: int = Field(default=0, ge=0, le=2)


class ArchiveInput(Contract):
    kind: Literal["compress_receipt"] = "compress_receipt"
    reception_id: int = Field(gt=0)


class PurgeInput(Contract):
    kind: Literal["purge_caches"] = "purge_caches"


TaskInput = Annotated[
    VisionInput | SanitaryInput | PriceInput | FinancialInput | ArchiveInput | PurgeInput,
    Field(discriminator="kind"),
]


class Job(Contract):
    id: str
    context: TaskContext
    input: TaskInput
    state: Literal["pending", "running", "retry", "done", "failed"]
    attempts: int = Field(ge=0)
    created_at: AwareDatetime
    updated_at: AwareDatetime
    next_attempt_at: AwareDatetime
    result: JsonObject | None = None
    error_code: str | None = None
    error_message: str | None = None


class InvoiceItem(Contract):
    description: str | None = Field(default=None, max_length=500)
    product_reference: str | None = Field(default=None, max_length=160)
    quantity: Quantity | None = None
    unit: str | None = Field(default=None, max_length=30)
    unit_price_ht: Quantity | None = None
    amount_ht: Money | None = None
    amount_vat: Money | None = None
    amount_ttc: Money | None = None
    vat_rate: Percent | None = None


class InvoiceDocument(Contract):
    supplier: str | None = Field(default=None, max_length=160)
    supplier_registration: str | None = Field(default=None, max_length=40)
    invoice_number: str | None = Field(default=None, max_length=160)
    date: IsoDate | None = None
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    lines: list[InvoiceItem] = Field(default_factory=list, max_length=500)
    amount_ht: Money | None = None
    amount_vat: Money | None = None
    amount_ttc: Money | None = None


def field_paths(value: JsonValue, prefix: str = "") -> set[str]:
    result: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else key
            result.add(path)
            result.update(field_paths(child, path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            result.update(field_paths(child, f"{prefix}.{index}"))
    return result


def confidence_paths(document: EtiquetteVisionOutput | InvoiceDocument) -> set[str]:
    paths = field_paths(document.model_dump(mode="json"))
    if isinstance(document, EtiquetteVisionOutput):
        for prefix, model in (("origines", OriginesProduit), ("poids_net", PoidsNet)):
            paths.update(f"{prefix}.{name}" for name in model.model_fields)
    return paths


class VisionResult(Contract):
    kind: Literal["label", "invoice"]
    document: EtiquetteVisionOutput | InvoiceDocument
    field_confidence: dict[str, Confidence | None] = Field(default_factory=dict)
    confidence_method: Literal["model_self_report_not_calibrated"] = "model_self_report_not_calibrated"
    requires_human_review: Literal[True] = True
    issues: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def compatible_document(self) -> "VisionResult":
        if (self.kind == "label") != isinstance(self.document, EtiquetteVisionOutput):
            raise ValueError("Type de document Vision incoherent.")
        allowed = confidence_paths(self.document)
        if self.field_confidence.keys() - allowed:
            raise ValueError("Confiance fournie pour un champ inconnu.")
        return self


class PriceAuditResult(Contract):
    currency: str
    unit_price_delta_ht: Decimal
    price_change_percent: Decimal | None
    food_cost_delta_ht: Decimal
    food_cost_after_ht: Decimal
    food_cost_before_percent: Decimal | None
    food_cost_after_percent: Decimal | None
    contribution_margin_after_ht: Decimal
    break_even_before_ht: Decimal | None
    break_even_after_ht: Decimal | None
    issues: list[str]
    accounting_written: Literal[False] = False


class SanitaryAlert(Contract):
    reception_id: int
    kind: Literal["expired_dlc", "rotation", "date_unknown", "allergens", "reading"]
    message: str
    deadline: AwareDatetime | None = None


class SanitaryResult(Contract):
    checked_at: AwareDatetime
    alerts: list[SanitaryAlert]
    total_alerts: int = Field(ge=0)
    truncated: bool
    rotation: Literal["FEFO_then_FIFO"] = "FEFO_then_FIFO"
    physical_stock_verified: Literal[False] = False


class NodeMetrics(Contract):
    id: NodeId
    parent: Literal["brain_3"] | None = None
    status: NodeStatus
    latency_ms: float | None = Field(default=None, ge=0)
    first_token_ms: float | None = Field(default=None, ge=0)
    load: Confidence
    pulse_level: Confidence
    current_task: str | None
    queued: int = Field(ge=0)
    completed: int = Field(ge=0)
    failures: int = Field(ge=0)
    restarts: int = Field(ge=0)


class EdgeFlow(Contract):
    source: NodeId
    target: NodeId
    count: int = Field(ge=1)
    last_at: AwareDatetime


class CortexFrame(Contract):
    version: Literal[1] = 1
    runtime_id: str
    sequence: int = Field(ge=0)
    emitted_at: AwareDatetime
    heartbeat_at: AwareDatetime | None
    source: Literal["local", "cloud"] = "local"
    nodes: list[NodeMetrics] = Field(min_length=3, max_length=3)
    satellites: list[NodeMetrics] = Field(min_length=4, max_length=4)
    edge_flows: list[EdgeFlow]
    dropped_events: int = Field(ge=0)


class CortexEvent(Contract):
    kind: EventKind
    scope: str
    source: NodeId
    target: NodeId
    task_id: str | None = None
    at: datetime


class CortexError(RuntimeError):
    """Erreur publique sans contenu du document ni message brut du fournisseur."""


class QueueUnavailable(CortexError):
    pass


class TaskConflict(CortexError):
    pass


class TaskFailed(CortexError):
    pass


class RetryableTaskError(CortexError):
    pass


class TaskPermissionError(CortexError):
    pass


class TaskPending(CortexError):
    def __init__(self, job_id: str):
        self.job_id = job_id
        super().__init__("Analyse conservee en file ; reprise automatique bornee. Reference : " + job_id)
