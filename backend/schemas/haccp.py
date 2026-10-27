"""Sortie Vision bornee et dates sans interpretation implicite."""
import re
from datetime import date, datetime, timezone
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StringConstraints, field_validator, model_validator

Texte255 = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=255)]
Lot = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=128)]
Allergene = Literal[
    "Gluten", "Crustacés", "Œufs", "Poissons", "Arachides", "Soja", "Lait",
    "Fruits à coque", "Céleri", "Moutarde", "Sésame", "Sulfites", "Lupin", "Mollusques",
]


class EtiquetteVisionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    nom_produit: Texte255
    fournisseur_ou_marque: Texte255 | None = None
    numero_lot: Lot
    dlc_ou_ddm: date | None = None
    type_date: Literal["DLC", "DDM", "inconnue"] = "inconnue"
    agrement_sanitaire: Annotated[str, StringConstraints(strict=True, max_length=64)] | None = None
    temperature_stockage: Annotated[str, StringConstraints(strict=True, max_length=64)] | None = None
    allergenes: list[Allergene] = Field(default_factory=list, max_length=14)
    conforme_reception: StrictBool = True
    commentaire_anomalie: Annotated[str, StringConstraints(strict=True, max_length=500)] | None = None

    @field_validator("dlc_ou_ddm", mode="before")
    @classmethod
    def date_explicite(cls, value: object) -> date | None:
        if value is None:
            return None
        if isinstance(value, date) and not isinstance(value, datetime):
            return value
        if isinstance(value, str):
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                return date.fromisoformat(value)
            if re.fullmatch(r"\d{2}/\d{2}/\d{4}", value):
                return datetime.strptime(value, "%d/%m/%Y").date()
        raise ValueError("Date attendue au format YYYY-MM-DD ou JJ/MM/AAAA avec annee complete.")


class OperationCapture(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    type_operation: Literal["reception", "ouverture"] = "reception"
    duree_conservation_heures: Annotated[int, Field(strict=True, gt=0)] | None = None
    justification_duree: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=500)] | None = None
    regle_confirmee: StrictBool = False

    @model_validator(mode="after")
    def valider_regle(self) -> "OperationCapture":
        supplied = self.duree_conservation_heures is not None or self.justification_duree is not None or self.regle_confirmee
        if self.type_operation == "reception" and supplied:
            raise ValueError("La regle de conservation concerne uniquement une ouverture.")
        if supplied and not (
            self.duree_conservation_heures is not None and self.justification_duree and self.regle_confirmee
        ):
            raise ValueError("Indiquez la duree, sa justification fabricant/PMS et confirmez la regle.")
        return self


class EtiquetteResponse(EtiquetteVisionOutput, OperationCapture):
    id: int
    created_at: datetime
    operateur: str
    image_url: str
    date_ouverture: datetime | None = None
    dlc_secondaire: datetime | None = None

    @field_validator("created_at", "date_ouverture", "dlc_secondaire", mode="after")
    @classmethod
    def horodatage_utc(cls, value: datetime | None) -> datetime | None:
        return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value
