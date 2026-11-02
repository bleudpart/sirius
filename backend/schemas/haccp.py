"""Sortie Vision bornee et dates sans interpretation implicite."""
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StringConstraints, field_validator, model_validator

Texte255 = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=255)]
Lot = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=128)]
PARIS = ZoneInfo("Europe/Paris")
CategorieProduit = Literal["Viandes", "Poissons", "Produits Laitiers", "Fruits & Légumes", "Épicerie", "Non classé"]
CATEGORIES_PRODUITS: tuple[CategorieProduit, ...] = (
    "Viandes", "Poissons", "Produits Laitiers", "Fruits & Légumes", "Épicerie", "Non classé",
)
Allergene = Literal[
    "Gluten", "Crustacés", "Œufs", "Poissons", "Arachides", "Soja", "Lait",
    "Fruits à coque", "Céleri", "Moutarde", "Sésame", "Sulfites", "Lupin", "Mollusques",
]
ChampLecture = Literal[
    "nom_produit", "fournisseur_ou_marque", "numero_lot", "dlc_ou_ddm", "type_date",
    "agrement_sanitaire", "temperature_stockage", "origines", "poids_net",
    "allergenes", "traces_allergenes", "mentions_traces", "allergenes_lecture",
]


class OriginesProduit(BaseModel):
    """Pays recopies sur l'etiquette, jamais deduits de l'estampille sanitaire."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    naissance: Texte255 | None = None
    elevage: list[Texte255] = Field(default_factory=list, max_length=10)
    abattage: Texte255 | None = None
    decoupe: Texte255 | None = None


class PoidsNet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    valeur: Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=6, allow_inf_nan=False)]
    unite: Literal["kg", "g"]

    def en_kilogrammes(self) -> Decimal:
        return self.valeur / Decimal(1000) if self.unite == "g" else self.valeur


class EtiquetteVisionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    nom_produit: Texte255
    fournisseur_ou_marque: Texte255 | None = None
    numero_lot: Lot
    dlc_ou_ddm: date | None = None
    type_date: Literal["DLC", "DDM", "inconnue"] = "inconnue"
    agrement_sanitaire: Annotated[str, StringConstraints(strict=True, max_length=64)] | None = None
    temperature_stockage: Annotated[str, StringConstraints(strict=True, max_length=64)] | None = None
    origines: OriginesProduit | None = None
    poids_net: PoidsNet | None = None
    allergenes: list[Allergene] = Field(default_factory=list, max_length=14)
    traces_allergenes: list[Allergene] = Field(default_factory=list, max_length=14)
    mentions_traces: Annotated[str, StringConstraints(strict=True, max_length=500)] | None = None
    allergenes_lecture: Literal["non_verifiee", "partielle", "complete"] = "non_verifiee"
    champs_incertains: list[ChampLecture] = Field(default_factory=list, max_length=14)
    conforme_reception: StrictBool = True
    commentaire_anomalie: Annotated[str, StringConstraints(strict=True, max_length=500)] | None = None
    categorie: CategorieProduit = "Non classé"

    @field_validator("categorie", mode="before")
    @classmethod
    def categorie_connue(cls, value: object) -> object:
        if value is None:
            return "Non classé"
        if isinstance(value, str):
            return next((name for name in CATEGORIES_PRODUITS if name.casefold() == value.strip().casefold()), "Non classé")
        return value

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


class OperationEtiquette(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    type_operation: Literal["reception", "ouverture", "preparation"] = "reception"
    duree_conservation_heures: Annotated[int, Field(strict=True, gt=0)] | None = None
    justification_duree: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=500)] | None = None
    regle_confirmee: StrictBool = False

    @model_validator(mode="after")
    def valider_regle(self) -> "OperationEtiquette":
        supplied = self.duree_conservation_heures is not None or self.justification_duree is not None or self.regle_confirmee
        if self.type_operation == "reception" and supplied:
            raise ValueError("La regle de conservation concerne une ouverture ou une preparation.")
        if (supplied or self.type_operation == "preparation") and not (
            self.duree_conservation_heures is not None and self.justification_duree and self.regle_confirmee
        ):
            raise ValueError("Indiquez la duree, sa justification fabricant/PMS et confirmez la regle.")
        return self


class OperationCapture(OperationEtiquette):
    type_operation: Literal["reception", "ouverture"] = "reception"


class PreparationCreate(OperationEtiquette):
    type_operation: Literal["preparation"] = "preparation"
    capture_id: uuid.UUID
    nom_produit: Texte255
    numero_lot: Lot | None = None
    categorie: CategorieProduit = "Non classé"
    operateur: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=100)]
    restaurant_name: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=160)]
    date_fabrication: datetime
    conditions_conservation: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=500)]

    @field_validator("date_fabrication", mode="before")
    @classmethod
    def fabrication_explicite(cls, value: object) -> datetime:
        if isinstance(value, str) and re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?", value,
        ):
            value = datetime.fromisoformat(value)
        if not isinstance(value, datetime) or value.microsecond:
            raise ValueError("Indiquez la date et l'heure reelles de fabrication, a la seconde pres.")
        if value.tzinfo is not None:
            if value.utcoffset() not in (timedelta(0), value.astimezone(PARIS).utcoffset()):
                raise ValueError("Le decalage UTC choisi ne correspond pas a cette heure en Europe/Paris.")
            return value.astimezone(timezone.utc)
        # Un datetime-local n'a pas de fuseau : refuser les heures sautees ou repetees.
        candidates = set()
        for fold in (0, 1):
            instant = value.replace(tzinfo=PARIS, fold=fold).astimezone(timezone.utc)
            if instant.astimezone(PARIS).replace(tzinfo=None) == value:
                candidates.add(instant)
        if len(candidates) != 1:
            raise ValueError("Heure inexistante ou ambigue en Europe/Paris : indiquez un horaire avec decalage UTC explicite.")
        return candidates.pop()

    @field_validator("conditions_conservation")
    @classmethod
    def conditions_sur_une_ligne(cls, value: str) -> str:
        return " ".join(value.split())


Destination = Literal["traceabilite", "stock", "allergenes", "achats"]


class EtatDestination(BaseModel):
    model_config = ConfigDict(extra="forbid")
    destination: Destination
    statut: Literal["pending", "done", "error"]
    tentatives: Annotated[int, Field(strict=True, ge=0)]
    erreur: str | None = None


class ObservationAllergenesEtat(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lecture: Literal["non_verifiee", "partielle", "complete"]
    verification_requise: StrictBool
    reference_reception_id: int | None
    nouveaux_allergenes: list[Allergene]
    nouvelles_traces: list[Allergene]


class EtatDistribution(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reception_id: int
    statut: Literal["complete", "partial", "pending"]
    destinations: list[EtatDestination]
    controle_physique_effectue: Literal[False] = False
    observation_allergenes: ObservationAllergenesEtat | None = None


class EtiquetteResponse(EtiquetteVisionOutput, OperationEtiquette):
    id: int
    created_at: datetime
    operateur: str
    image_url: str | None
    chemin_image_brute: str | None = None
    empreinte_image_brute: str | None = None
    image_brute_url: str | None = None
    reception_source_id: int | None = None
    distribution: EtatDistribution | None = None
    date_ouverture: datetime | None = None
    date_fabrication: datetime | None = None
    conditions_conservation: str | None = None
    restaurant_name: str | None = None
    dlc_secondaire: datetime | None = None
    chemin_photo: str | None = None
    chemin_donnees: str | None = None
    donnees_url: str | None = None
    temperature_conforme: None = None
    fournisseur: str | None = None
    dlc_dluo: date | None = None
    date_reception: datetime | None = None

    @field_validator("created_at", "date_ouverture", "date_fabrication", "dlc_secondaire", "date_reception", mode="after")
    @classmethod
    def horodatage_utc(cls, value: datetime | None) -> datetime | None:
        return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value
