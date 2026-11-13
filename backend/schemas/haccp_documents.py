"""Factures et bons de livraison : lecture documentaire, pas reception physique."""
from typing import Annotated, Literal
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_serializer, field_validator
from schemas.finance import Quantity
from schemas.haccp import CategorieProduit, EtiquetteVisionOutput

Text = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=255)]


class DeliveryLine(BaseModel):
    model_config = ConfigDict(extra="forbid")
    produit: Text | None = None
    lot: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=128)] | None = None
    categorie: CategorieProduit = "Non classé"
    quantite: Annotated[Quantity, Field(gt=0)] | None = None
    unite: Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=30)] | None = None

    @field_validator("categorie", mode="before")
    @classmethod
    def known_category(cls, value):
        return EtiquetteVisionOutput.categorie_connue(value)

    @field_serializer("quantite")
    def serialize_quantity(self, value):
        return format(value, "f") if value is not None else None


class DeliveryDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type_document: Literal["facture", "bon_livraison", "inconnu"]
    fournisseur: Text | None = None
    reference: Text | None = None
    date_document: date | None = None
    lignes: list[DeliveryLine] = Field(default_factory=list, max_length=200)
    incertitudes: list[Text] = Field(default_factory=list, max_length=30)

    @field_validator("date_document", mode="before")
    @classmethod
    def explicit_date(cls, value):
        return EtiquetteVisionOutput.date_explicite(value)


class DeliveryDocumentResponse(DeliveryDocument):
    id: str
    restaurant_name: str
    created_at: datetime
    chemin_photo: str
    photo_sha256: str


class ReceptionEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    restaurant_name: str
    date: date
    origine_date: Literal["document", "photo"]
    categorie: CategorieProduit
    produit: str | None
    quantite: str | None
    unite: str | None
    lot: str | None
    source: Literal["facture", "bon_livraison", "etiquette"]
    reference: str | None
    fournisseur: str | None


class ReceptionEntryPage(BaseModel):
    restaurant_name: str
    annee: int
    mois: int | None
    annees: list[int]
    offset: int
    limit: int
    total: int
    items: list[ReceptionEntry]
