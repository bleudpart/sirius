"""Factures et bons de livraison : lecture documentaire, pas reception physique."""
from typing import Annotated, Literal
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from schemas.haccp import CategorieProduit, EtiquetteVisionOutput

Text = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=255)]


class DeliveryLine(BaseModel):
    model_config = ConfigDict(extra="forbid")
    produit: Text | None = None
    lot: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=128)] | None = None
    categorie: CategorieProduit = "Non classé"

    @field_validator("categorie", mode="before")
    @classmethod
    def known_category(cls, value):
        return EtiquetteVisionOutput.categorie_connue(value)


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
