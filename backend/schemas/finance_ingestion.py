"""Résultat des imports financiers atomiques, indépendant du transport."""
from datetime import datetime
from typing import Self

from pydantic import Field, model_validator

from schemas.finance import FinanceIngestionSource, StrictModel


class FinanceIngestionResult(StrictModel):
    batch_id: str = Field(min_length=36, max_length=36)
    company_id: str
    source: FinanceIngestionSource
    record_count: int = Field(ge=0)
    duplicate_count: int = Field(default=0, ge=0)
    payload_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    replayed: bool
    review_required: bool
    notes: list[str] = Field(default_factory=list)
    warnings: list[str]

    @model_validator(mode="after")
    def replay_is_consistent(self) -> Self:
        if self.review_required != bool(self.warnings):
            raise ValueError("La revue requise doit correspondre aux avertissements.")
        return self


class FinanceIngestionBatchView(StrictModel):
    batch_id: str = Field(min_length=36, max_length=36)
    source: FinanceIngestionSource
    created_at: datetime
    record_count: int = Field(ge=0)
    duplicate_count: int = Field(ge=0)
    remaining_count: int = Field(ge=0)
    notes: list[str]
    warnings: list[str]


class FinanceIngestionLog(StrictModel):
    batches: list[FinanceIngestionBatchView]
    truncated: bool
