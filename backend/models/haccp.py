"""Registre local des etiquettes originales de reception."""
from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, Integer, String, Index
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class EtiquetteHaccp(Base):
    __tablename__ = "etiquettes_haccp"
    __table_args__ = (Index("uq_haccp_capture", "scope_key", "capture_id", unique=True),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    scope_key: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    nom_produit: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    fournisseur_ou_marque: Mapped[str | None] = mapped_column(String(255), index=True)
    numero_lot: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    dlc_ou_ddm: Mapped[date | None] = mapped_column(Date, index=True)
    type_date: Mapped[str] = mapped_column(String(8), default="inconnue")
    agrement_sanitaire: Mapped[str | None] = mapped_column(String(64), index=True)
    temperature_stockage: Mapped[str | None] = mapped_column(String(64))
    allergenes: Mapped[list[str]] = mapped_column(JSON, default=list)
    conforme_reception: Mapped[bool] = mapped_column(Boolean, default=True)
    commentaire_anomalie: Mapped[str | None] = mapped_column(String(500))
    image_path: Mapped[str] = mapped_column(String(512), nullable=False)
    operateur: Mapped[str] = mapped_column(String(100), default="Cuisine")
    type_operation: Mapped[str] = mapped_column(String(10), default="reception", server_default="reception")
    date_ouverture: Mapped[datetime | None] = mapped_column(DateTime)
    dlc_secondaire: Mapped[datetime | None] = mapped_column(DateTime)
    duree_conservation_heures: Mapped[int | None] = mapped_column(Integer)
    justification_duree: Mapped[str | None] = mapped_column(String(500))
    regle_confirmee: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    capture_id: Mapped[str | None] = mapped_column(String(36))
    capture_hash: Mapped[str | None] = mapped_column(String(64))
