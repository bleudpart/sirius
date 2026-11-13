"""Registre local des receptions, ouvertures et preparations declarees."""
from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, Integer, String, Index
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class EtiquetteHaccp(Base):
    __tablename__ = "etiquettes_haccp"
    __table_args__ = (
        Index("uq_haccp_capture", "scope_key", "capture_id", unique=True),
        Index("ix_haccp_scope_categorie", "scope_key", "categorie"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    scope_key: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    nom_produit: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    categorie: Mapped[str] = mapped_column(String(32), default="Non classé", server_default="Non classé", nullable=False)
    fournisseur_ou_marque: Mapped[str | None] = mapped_column(String(255), index=True)
    numero_lot: Mapped[str] = mapped_column(String(128), index=True, nullable=False)
    dlc_ou_ddm: Mapped[date | None] = mapped_column(Date, index=True)
    type_date: Mapped[str] = mapped_column(String(8), default="inconnue")
    agrement_sanitaire: Mapped[str | None] = mapped_column(String(64), index=True)
    temperature_stockage: Mapped[str | None] = mapped_column(String(64))
    origines: Mapped[dict | None] = mapped_column(JSON)
    poids_net: Mapped[dict | None] = mapped_column(JSON)
    allergenes: Mapped[list[str]] = mapped_column(JSON, default=list)
    traces_allergenes: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    mentions_traces: Mapped[str | None] = mapped_column(String(500))
    allergenes_lecture: Mapped[str] = mapped_column(String(16), default="non_verifiee", server_default="non_verifiee")
    champs_incertains: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    conforme_reception: Mapped[bool] = mapped_column(Boolean, default=True)
    commentaire_anomalie: Mapped[str | None] = mapped_column(String(500))
    image_path: Mapped[str] = mapped_column(String(512), nullable=False)
    raw_image_path: Mapped[str | None] = mapped_column(String(512))
    raw_image_sha256: Mapped[str | None] = mapped_column(String(64))
    reception_source_id: Mapped[int | None] = mapped_column(Integer)
    operateur: Mapped[str] = mapped_column(String(100), default="Cuisine")
    type_operation: Mapped[str] = mapped_column(String(16), default="reception", server_default="reception")
    date_ouverture: Mapped[datetime | None] = mapped_column(DateTime)
    date_fabrication: Mapped[datetime | None] = mapped_column(DateTime)
    conditions_conservation: Mapped[str | None] = mapped_column(String(500))
    restaurant_name: Mapped[str | None] = mapped_column(String(160))
    dlc_secondaire: Mapped[datetime | None] = mapped_column(DateTime)
    duree_conservation_heures: Mapped[int | None] = mapped_column(Integer)
    justification_duree: Mapped[str | None] = mapped_column(String(500))
    regle_confirmee: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    capture_id: Mapped[str | None] = mapped_column(String(36))
    capture_hash: Mapped[str | None] = mapped_column(String(64))


class HaccpDeliveryDocument(Base):
    __tablename__ = "haccp_delivery_documents"
    __table_args__ = (Index("uq_haccp_document_capture", "scope_key", "capture_id", unique=True),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_key: Mapped[str] = mapped_column(String(255), index=True)
    restaurant_name: Mapped[str] = mapped_column(String(160), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    capture_id: Mapped[str] = mapped_column(String(36))
    capture_hash: Mapped[str] = mapped_column(String(64))
    image_path: Mapped[str] = mapped_column(String(512))
    image_sha256: Mapped[str] = mapped_column(String(64))
    document: Mapped[dict] = mapped_column(JSON)
