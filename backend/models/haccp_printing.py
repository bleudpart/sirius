"""Poste d'impression et file durable : jamais de reemission automatique."""
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from models.haccp import Base


class HaccpPrintStation(Base):
    __tablename__ = "haccp_print_stations"

    scope_key: Mapped[str] = mapped_column(String(255), primary_key=True)
    relay_id: Mapped[str] = mapped_column(String(36), nullable=False)
    device_name: Mapped[str] = mapped_column(String(255), nullable=False)
    width_mm: Mapped[int] = mapped_column(Integer, nullable=False)
    height_mm: Mapped[int] = mapped_column(Integer, nullable=False)
    last_seen: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class HaccpPrintJob(Base):
    __tablename__ = "haccp_print_jobs"
    __table_args__ = (UniqueConstraint("scope_key", "label_id", name="uq_haccp_print_label"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_key: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    label_id: Mapped[int] = mapped_column(Integer, nullable=False)
    relay_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    detail: Mapped[str | None] = mapped_column(String(500))
