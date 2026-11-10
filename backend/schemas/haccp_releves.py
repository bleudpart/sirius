"""Modèles et validation des saisies HACCP signées."""

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictStr, StringConstraints


TypeReleve = Literal[
    "temperature", "reception", "huile", "refroidissement", "remise",
    "tracabilite", "nettoyage",
]


def field(key, label, kind="text", *, required=True, options=None, minimum=None, maximum=None):
    item = {"key": key, "label": label, "type": kind, "required": required}
    if options is not None:
        item["options"] = options
    if minimum is not None:
        item["min"] = minimum
    if maximum is not None:
        item["max"] = maximum
    return item


FORMS = {
    "temperature": {
        "titre": "Relevé de température",
        "champs": [
            field("usage", "Contrôle", "select", options=["Enceinte froide", "Liaison froide", "Liaison chaude"]),
            field("equipement", "Équipement ou lieu"),
            field("date_heure", "Date et heure", "datetime-local"),
            field("temperature", "Température relevée (°C)", "number", minimum=-100, maximum=300),
            field("consigne", "Consigne / plage cible", required=False),
            field("action", "Anomalie / action corrective", required=False),
        ],
    },
    "reception": {
        "titre": "Contrôle à réception",
        "champs": [
            field("date_heure", "Date et heure de livraison", "datetime-local"),
            field("fournisseur", "Fournisseur"),
            field("produit", "Produit"),
            field("lot", "Numéro de lot"),
            field("temperature", "Température à la livraison (°C)", "number", minimum=-100, maximum=300),
            field("date_limite", "DLC / DDM", "date"),
            field("emballage", "État de l'emballage", "select", options=["Intact", "Endommagé", "À vérifier"]),
            field("action", "Anomalie / action corrective", required=False),
            field("etiquette_id", "Photo d'étiquette liée", "etiquette", required=False),
        ],
    },
    "huile": {
        "titre": "Contrôle des huiles de friture",
        "champs": [
            field("date_heure", "Date et heure", "datetime-local"),
            field("friteuse", "Friteuse / bain"),
            field("methode", "Méthode", "select", options=["Testeur", "Bandelette"]),
            field("polaires", "Composés polaires (%)", "number", required=False, minimum=0, maximum=100),
            field("bandelette", "Résultat de la bandelette", required=False),
            field("renouvellement", "Huile renouvelée", "select", options=["Oui", "Non"]),
            field("action", "Observation / action corrective", required=False),
        ],
    },
    "refroidissement": {
        "titre": "Refroidissement rapide",
        "champs": [
            field("produit", "Plat / produit"),
            field("lot", "Numéro de lot"),
            field("debut", "Début du refroidissement", "datetime-local"),
            field("temperature_debut", "Température au début (°C)", "number", minimum=-100, maximum=300),
            field("fin", "Fin du refroidissement", "datetime-local"),
            field("temperature_fin", "Température à la fin (°C)", "number", minimum=-100, maximum=300),
            field("controle", "Contrôle selon votre PMS", "select", options=["Conforme", "Non conforme", "À vérifier"]),
            field("action", "Anomalie / action corrective", required=False),
        ],
    },
    "remise": {
        "titre": "Remise en température",
        "champs": [
            field("produit", "Plat / produit"),
            field("lot", "Numéro de lot"),
            field("debut", "Début de la remise en température", "datetime-local"),
            field("temperature_debut", "Température au début (°C)", "number", minimum=-100, maximum=300),
            field("fin", "Fin de la remise en température", "datetime-local"),
            field("temperature_fin", "Température à la fin (°C)", "number", minimum=-100, maximum=300),
            field("controle", "Contrôle selon votre PMS", "select", options=["Conforme", "Non conforme", "À vérifier"]),
            field("action", "Anomalie / action corrective", required=False),
        ],
    },
    "tracabilite": {
        "titre": "Traçabilité / DLC secondaire",
        "champs": [
            field("etiquette_id", "Photo d'étiquette conservée", "etiquette"),
            field("produit", "Produit"),
            field("lot", "Numéro de lot"),
            field("ouverture", "Date et heure de déconditionnement", "datetime-local"),
            field("dlc_origine", "DLC / DDM d'origine", "date"),
            field("dlc_secondaire", "DLC secondaire validée", "datetime-local"),
            field("conservation", "Conditions de conservation"),
            field("action", "Observation", required=False),
        ],
    },
    "nettoyage": {
        "titre": "Fiche de nettoyage et désinfection",
        "champs": [
            field("date_heure", "Date et heure", "datetime-local"),
            field("zone", "Zone"),
            field("surface", "Surface / matériel"),
            field("produit", "Produit utilisé"),
            field("frequence", "Fréquence / méthode", required=False),
            field("controle", "Contrôle visuel", "select", options=["Satisfaisant", "À reprendre", "Non vérifié"]),
            field("action", "Anomalie / action corrective", required=False),
        ],
    },
}


class ReleveInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    capture_id: UUID
    type_releve: TypeReleve
    etablissement: Annotated[str, StringConstraints(min_length=1, max_length=160)]
    operateur: Annotated[str, StringConstraints(min_length=1, max_length=160)]
    champs: dict[str, StrictStr]
    signature_image: Annotated[str, StringConstraints(min_length=1, max_length=256_022)]


def validate_fields(kind: TypeReleve, values: dict[str, str]) -> dict[str, str]:
    definitions = FORMS[kind]["champs"]
    expected = {item["key"] for item in definitions}
    if set(values) - expected:
        raise ValueError("Le relevé contient des champs inconnus.")
    result = {}
    for item in definitions:
        key, label = item["key"], item["label"]
        value = values.get(key, "").strip()
        if not value:
            if item["required"]:
                raise ValueError(f"{label} est requis.")
            result[key] = ""
            continue
        if len(value) > 500:
            raise ValueError(f"{label} est trop long.")
        kind_of_field = item["type"]
        try:
            if kind_of_field == "date":
                date.fromisoformat(value)
            elif kind_of_field == "datetime-local":
                stamp = datetime.fromisoformat(value)
                if stamp.tzinfo is not None or "T" not in value:
                    raise ValueError
            elif kind_of_field == "number":
                numeric = Decimal(value.replace(",", "."))
                if not numeric.is_finite() or numeric < item["min"] or numeric > item["max"]:
                    raise ValueError
            elif kind_of_field == "select" and value not in item["options"]:
                raise ValueError
            elif kind_of_field == "etiquette" and (not value.isascii() or not value.isdigit() or int(value) <= 0):
                raise ValueError
        except (ValueError, InvalidOperation) as error:
            raise ValueError(f"{label} est invalide.") from error
        result[key] = value
    if kind == "huile":
        if result["methode"] == "Testeur" and not result["polaires"]:
            raise ValueError("Indiquez le pourcentage de composés polaires mesuré.")
        if result["methode"] == "Bandelette" and not result["bandelette"]:
            raise ValueError("Indiquez le résultat de la bandelette.")
    if kind in {"refroidissement", "remise"}:
        if datetime.fromisoformat(result["fin"]) < datetime.fromisoformat(result["debut"]):
            raise ValueError("La fin du contrôle ne peut pas précéder son début.")
    if kind == "tracabilite":
        if datetime.fromisoformat(result["dlc_secondaire"]) < datetime.fromisoformat(result["ouverture"]):
            raise ValueError("La DLC secondaire ne peut pas précéder le déconditionnement.")
    return result
