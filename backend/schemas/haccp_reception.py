"""Contrats du pipeline : une preuve source et quatre destinations independantes."""
import hashlib
import json
import unicodedata
import uuid
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictBool, StringConstraints, model_validator

from schemas.haccp import Destination, EtatDestination, EtatDistribution, EtiquetteVisionOutput, OperationCapture

DESTINATIONS: tuple[Destination, ...] = ("traceabilite", "stock", "allergenes", "achats")
ALERTE_AVANT_HEURES = 48
Empreinte = Annotated[str, StringConstraints(strict=True, pattern=r"^[a-f0-9]{64}$")]


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class ImageArchivee(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    chemin: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=512)]
    sha256: Empreinte
    taille_octets: Annotated[int, Field(strict=True, gt=0, le=20 * 1024 * 1024)]
    type_mime: Literal["image/jpeg", "image/png", "image/webp"]


class ReceptionDocument(BaseModel):
    """Instant et emplacement proviennent du serveur, pas du modele de vision."""
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    reception_id: Annotated[int, Field(strict=True, gt=0)]
    date_scan: AwareDatetime
    operateur: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=100)]
    restaurant_name: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=160)]
    image: ImageArchivee
    etiquette: EtiquetteVisionOutput
    alerte_avant_heures: Annotated[int, Field(strict=True, ge=0, le=24 * 365)] = ALERTE_AVANT_HEURES

    def product_key(self) -> str | None:
        name = self.etiquette.nom_produit
        supplier = self.etiquette.fournisseur_ou_marque
        if (not supplier or name.upper() == "ILLISIBLE" or supplier.upper() == "ILLISIBLE"
                or set(self.etiquette.champs_incertains).intersection({"nom_produit", "fournisseur_ou_marque"})):
            return None
        def normalized(value: str) -> str:
            return " ".join(unicodedata.normalize("NFC", value).casefold().split())
        return fingerprint(canonical_json([
            normalized(self.restaurant_name), normalized(supplier), normalized(name),
        ]))

    def allergens_comparable(self) -> bool:
        uncertain = set(self.etiquette.champs_incertains)
        return self.etiquette.allergenes_lecture == "complete" and not uncertain.intersection(
            {"allergenes", "traces_allergenes", "mentions_traces", "allergenes_lecture"},
        )


class OuvertureReception(OperationCapture):
    type_operation: Literal["ouverture"] = "ouverture"
    capture_id: uuid.UUID
    operateur: Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=100)]
    ouverture_effectuee: StrictBool

    @model_validator(mode="after")
    def ouverture_confirmee(self) -> "OuvertureReception":
        if not self.ouverture_effectuee or not self.regle_confirmee:
            raise ValueError("Confirmez l'ouverture reelle et une duree fabricant/PMS validee pour ce produit.")
        return self
