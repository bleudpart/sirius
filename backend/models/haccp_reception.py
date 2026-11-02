"""Source durable, outbox et projections du pipeline de reception HACCP."""
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from models.haccp import Base


class ReceptionSource(Base):
    __tablename__ = "haccp_reception_sources"
    reception_id: Mapped[int] = mapped_column(ForeignKey("etiquettes_haccp.id"), primary_key=True)
    scope_key: Mapped[str] = mapped_column(String(255), index=True)
    payload_json: Mapped[str] = mapped_column(Text)
    payload_sha256: Mapped[str] = mapped_column(String(64))
    product_key: Mapped[str | None] = mapped_column(String(64), index=True)
    allergens_comparable: Mapped[bool] = mapped_column(Boolean)


class ReceptionDelivery(Base):
    __tablename__ = "haccp_reception_deliveries"
    reception_id: Mapped[int] = mapped_column(ForeignKey("haccp_reception_sources.reception_id"), primary_key=True)
    destination: Mapped[str] = mapped_column(String(16), primary_key=True)
    status: Mapped[str] = mapped_column(String(10), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(String(500))
    updated_at: Mapped[datetime] = mapped_column(DateTime)


class ReceptionJournal(Base):
    __tablename__ = "haccp_reception_journal"
    __table_args__ = (Index("uq_haccp_reception_sequence", "scope_key", "sequence", unique=True),)
    reception_id: Mapped[int] = mapped_column(ForeignKey("haccp_reception_sources.reception_id"), primary_key=True)
    scope_key: Mapped[str] = mapped_column(String(255), index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    previous_hash: Mapped[str] = mapped_column(String(64))
    entry_hash: Mapped[str] = mapped_column(String(64))
    recorded_at: Mapped[datetime] = mapped_column(DateTime)
    payload_json: Mapped[str] = mapped_column(Text)


class StockLot(Base):
    __tablename__ = "haccp_stock_lots"
    reception_id: Mapped[int] = mapped_column(ForeignKey("haccp_reception_sources.reception_id"), primary_key=True)
    scope_key: Mapped[str] = mapped_column(String(255), index=True)
    restaurant_name: Mapped[str] = mapped_column(String(160))
    product: Mapped[str] = mapped_column(String(255))
    supplier: Mapped[str | None] = mapped_column(String(255))
    lot: Mapped[str] = mapped_column(String(128))
    received_at: Mapped[datetime] = mapped_column(DateTime)
    date_type: Mapped[str] = mapped_column(String(8))
    deadline: Mapped[datetime | None] = mapped_column(DateTime)
    alert_at: Mapped[datetime] = mapped_column(DateTime)
    declared_weight_kg: Mapped[str | None] = mapped_column(String(32))
    storage: Mapped[str | None] = mapped_column(String(64))
    label_compliant: Mapped[bool] = mapped_column(Boolean)


class AllergenObservation(Base):
    __tablename__ = "haccp_allergen_observations"
    reception_id: Mapped[int] = mapped_column(ForeignKey("haccp_reception_sources.reception_id"), primary_key=True)
    scope_key: Mapped[str] = mapped_column(String(255), index=True)
    restaurant_name: Mapped[str] = mapped_column(String(160))
    product: Mapped[str] = mapped_column(String(255))
    supplier: Mapped[str | None] = mapped_column(String(255))
    allergens: Mapped[list[str]] = mapped_column(JSON)
    traces: Mapped[list[str]] = mapped_column(JSON)
    trace_mentions: Mapped[str | None] = mapped_column(String(500))
    reading_status: Mapped[str] = mapped_column(String(16))
    baseline_id: Mapped[int | None] = mapped_column(Integer)
    new_allergens: Mapped[list[str]] = mapped_column(JSON)
    new_traces: Mapped[list[str]] = mapped_column(JSON)
    review_required: Mapped[bool] = mapped_column(Boolean)


class PurchaseReceipt(Base):
    __tablename__ = "haccp_purchase_receipts"
    reception_id: Mapped[int] = mapped_column(ForeignKey("haccp_reception_sources.reception_id"), primary_key=True)
    scope_key: Mapped[str] = mapped_column(String(255), index=True)
    restaurant_name: Mapped[str] = mapped_column(String(160))
    supplier: Mapped[str | None] = mapped_column(String(255))
    product: Mapped[str] = mapped_column(String(255))
    lot: Mapped[str] = mapped_column(String(128))
    received_at: Mapped[datetime] = mapped_column(DateTime)
    net_weight: Mapped[dict | None] = mapped_column(JSON)
    raw_image_path: Mapped[str] = mapped_column(String(512))
    raw_image_sha256: Mapped[str] = mapped_column(String(64))
