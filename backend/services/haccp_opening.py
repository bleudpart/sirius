"""Calcul et etiquettes d'ouverture ou de preparation, selon une regle confirmee."""
from datetime import datetime, time, timedelta, timezone
from html import escape
from schemas.haccp import PARIS, EtiquetteResponse, EtiquetteVisionOutput, OperationCapture, PreparationCreate


def calculer_ouverture(
    etiquette: EtiquetteVisionOutput, operation: OperationCapture, maintenant: datetime,
) -> tuple[EtiquetteVisionOutput, datetime | None]:
    if operation.type_operation == "reception":
        return etiquette, None
    anomalies: list[str] = []
    limite: datetime | None = None
    if not operation.regle_confirmee:
        anomalies.append("Ouverture archivee sans regle fabricant/PMS confirmee : aucune DLC secondaire.")
    if etiquette.type_date == "inconnue" or etiquette.dlc_ou_ddm is None:
        anomalies.append("Date d'origine incertaine : aucune DLC secondaire.")
    if not etiquette.conforme_reception:
        anomalies.append("Anomalie sur l'etiquette : ouverture a verifier, aucune DLC secondaire.")
    if not anomalies and operation.duree_conservation_heures is not None:
        try:
            limite = maintenant.astimezone(timezone.utc) + timedelta(hours=operation.duree_conservation_heures)
        except OverflowError as error:
            raise ValueError("La duree indiquee depasse les dates prises en charge.") from error
        if etiquette.type_date == "DLC" and etiquette.dlc_ou_ddm is not None:
            if etiquette.dlc_ou_ddm < maintenant.astimezone(PARIS).date():
                anomalies.append("DLC d'origine depassee : aucune DLC secondaire.")
                limite = None
            elif etiquette.dlc_ou_ddm.year < 9999:
                # Date seule : borne au dernier instant du jour de DLC en France.
                fin_dlc = datetime.combine(
                    etiquette.dlc_ou_ddm + timedelta(days=1), time.min, tzinfo=PARIS,
                ).astimezone(timezone.utc) - timedelta(microseconds=1)
                limite = min(limite, fin_dlc)
    if anomalies:
        comment = " ".join(anomalies + ([etiquette.commentaire_anomalie] if etiquette.commentaire_anomalie else []))
        etiquette = etiquette.model_copy(update={"conforme_reception": False, "commentaire_anomalie": comment[:500]})
    return etiquette, limite


def calculer_preparation(preparation: PreparationCreate, maintenant: datetime) -> datetime:
    fabrication = preparation.date_fabrication.astimezone(timezone.utc)
    if fabrication > maintenant:
        raise ValueError("La fabrication ne peut pas etre dans le futur.")
    if preparation.duree_conservation_heures is None:
        raise ValueError("Une duree validee pour ce produit est obligatoire.")
    try:
        limite = fabrication + timedelta(hours=preparation.duree_conservation_heures)
    except OverflowError as error:
        raise ValueError("La duree indiquee depasse les dates prises en charge.") from error
    if limite <= maintenant:
        raise ValueError("La DLC calculee est deja depassee : aucune etiquette d'utilisation.")
    return limite


def verifier_etiquette_imprimable(record: EtiquetteResponse, maintenant: datetime) -> None:
    if (record.type_operation not in ("ouverture", "preparation") or not record.dlc_secondaire
            or not record.conforme_reception or not record.regle_confirmee
            or not record.duree_conservation_heures or not record.justification_duree):
        raise ValueError("Aucune etiquette d'utilisation : regle, verification ou DLC invalide.")
    if record.type_operation == "preparation" and (
        not record.date_fabrication or not record.conditions_conservation
        or record.date_fabrication > maintenant
    ):
        raise ValueError("Preparation incomplete : fabrication et conditions de conservation obligatoires.")
    if record.dlc_secondaire <= maintenant:
        raise ValueError("DLC depassee : impression d'utilisation refusee.")


LABEL_STYLE = (
    'body{font:14px sans-serif;margin:12mm;color:#000;background:#fff}'
    'article{max-width:90mm;border:1px solid;padding:4mm;overflow-wrap:anywhere}'
    'dt{font-weight:bold;margin-top:2mm}dd{margin:0;white-space:pre-wrap}'
    '@media print{body{margin:0}.notice{display:none}article{break-inside:avoid}}'
)


def _conditions_stockage(record: EtiquetteResponse) -> str:
    if record.type_operation == "preparation":
        if not record.conditions_conservation:
            raise ValueError("Conditions de conservation manquantes pour la preparation.")
        return record.conditions_conservation
    return record.temperature_stockage or "A verifier sur l'original"


def _article_etiquette(record: EtiquetteResponse) -> str:
    preparation = record.type_operation == "preparation"

    def horodatage(value: datetime | None) -> str:
        return value.astimezone(PARIS).strftime("%d/%m/%Y %H:%M:%S" + (" %z" if preparation else "")) if value else ""

    fields = [
        ("Lot", record.numero_lot),
        ("Fabrication" if preparation else "Ouverture enregistree",
         horodatage(record.date_fabrication if preparation else record.date_ouverture)),
        ("DLC au plus tard" if preparation else "DLC secondaire au plus tard", horodatage(record.dlc_secondaire)),
        ("Operateur", record.operateur),
        ("Conditions de conservation" if preparation else "Consigne de stockage d'origine",
         _conditions_stockage(record)),
        ("Duree declaree (heures)", str(record.duree_conservation_heures)),
        ("Reference fabricant / PMS", record.justification_duree or ""),
    ]
    if record.restaurant_name:
        fields.insert(0, ("Etablissement", record.restaurant_name))
    rows = "".join(f"<dt>{escape(label)}</dt><dd>{escape(value)}</dd>" for label, value in fields)
    return (
        f'<article><header>ΣIRIUS · {"PREPARATION" if preparation else "OUVERTURE"} #{record.id}</header>'
        f'<h1>{escape(record.nom_produit)}</h1>'
        f'<dl>{rows}</dl><p>Heures Europe/Paris. Conditions fabricant/PMS a respecter. '
        "Calcul sur declaration operateur, sans certification sanitaire.</p></article>"
    )


def construire_etiquette(record: EtiquetteResponse) -> str:
    return (
        '<!doctype html><html lang="fr"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f'<title>ΣIRIUS — {"Preparation" if record.type_operation == "preparation" else "Ouverture produit"}</title><style>'
        + LABEL_STYLE + '</style></head><body><p class="notice">Imprimer avec le navigateur ; '
        "adapter le format du papier et verifier l'apercu avant de coller.</p>"
        + _article_etiquette(record) + "</body></html>"
    )


def construire_fragment_impression(record: EtiquetteResponse) -> str:
    preparation = record.type_operation == "preparation"

    def stamp(value: datetime | None) -> str:
        return value.astimezone(PARIS).strftime("%d/%m/%Y %H:%M:%S %z" if preparation else "%d/%m/%Y %H:%M") if value else ""

    fields = [
        ("Lot", record.numero_lot),
        ("Fabrication" if preparation else "Ouvert", stamp(record.date_fabrication if preparation else record.date_ouverture)),
        ("DLC" if preparation else "Au plus tard", stamp(record.dlc_secondaire)),
        ("Operateur", record.operateur),
    ]
    if preparation:
        fields.append(("Conservation", _conditions_stockage(record)))
    rows = "".join(f"<div><b>{escape(label)} :</b> {escape(value)}</div>" for label, value in fields)
    return (
        "<style>body{margin:0;color:#000;background:#fff;font:11px sans-serif}"
        "article{padding:2mm;box-sizing:border-box;overflow-wrap:anywhere}"
        "header,footer{font-size:9px}h1{font-size:13px;margin:1mm 0}"
        "div{margin:0.6mm 0}footer{margin-top:1mm}</style>"
        f'<article><header>ΣIRIUS · {"PREPARATION" if preparation else "OUVERTURE"} #{record.id}</header>'
        f"<h1>{escape(record.nom_produit)}</h1>{rows}"
        "<footer>Europe/Paris · Respecter les consignes fabricant/PMS."
        + (" Regle declaree conservee au registre." if preparation else " Regle et original conserves au registre.")
        + "</footer></article>"
    )
