"""Calcul tracable apres ouverture, sans duree universelle supposee."""
from datetime import datetime, time, timedelta, timezone
from html import escape
from zoneinfo import ZoneInfo

from schemas.haccp import EtiquetteResponse, EtiquetteVisionOutput, OperationCapture

PARIS = ZoneInfo("Europe/Paris")


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


LABEL_STYLE = (
    'body{font:14px sans-serif;margin:12mm;color:#000;background:#fff}'
    'article{max-width:90mm;border:1px solid;padding:4mm;overflow-wrap:anywhere}'
    'dt{font-weight:bold;margin-top:2mm}dd{margin:0;white-space:pre-wrap}'
    '@media print{body{margin:0}.notice{display:none}article{break-inside:avoid}}'
)


def _article_etiquette(record: EtiquetteResponse) -> str:
    def horodatage(value: datetime | None) -> str:
        return value.astimezone(PARIS).strftime("%d/%m/%Y %H:%M:%S") if value else ""

    fields = [
        ("Lot", record.numero_lot),
        ("Ouverture enregistree", horodatage(record.date_ouverture)),
        ("DLC secondaire au plus tard", horodatage(record.dlc_secondaire)),
        ("Operateur", record.operateur),
        ("Consigne de stockage d'origine", record.temperature_stockage or "A verifier sur l'original"),
        ("Duree declaree (heures)", str(record.duree_conservation_heures)),
        ("Reference fabricant / PMS", record.justification_duree or ""),
    ]
    rows = "".join(f"<dt>{escape(label)}</dt><dd>{escape(value)}</dd>" for label, value in fields)
    return (
        f'<article><header>ΣIRIUS · OUVERTURE #{record.id}</header><h1>{escape(record.nom_produit)}</h1>'
        f'<dl>{rows}</dl><p>Heures Europe/Paris. Conditions fabricant/PMS a respecter. '
        "Calcul sur declaration operateur, sans certification sanitaire.</p></article>"
    )


def construire_etiquette(record: EtiquetteResponse) -> str:
    return (
        '<!doctype html><html lang="fr"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<title>ΣIRIUS — Ouverture produit</title><style>'
        + LABEL_STYLE + '</style></head><body><p class="notice">Imprimer avec le navigateur ; '
        "adapter le format du papier et verifier l'apercu avant de coller.</p>"
        + _article_etiquette(record) + "</body></html>"
    )


def construire_fragment_impression(record: EtiquetteResponse) -> str:
    def stamp(value: datetime | None) -> str:
        return value.astimezone(PARIS).strftime("%d/%m/%Y %H:%M") if value else ""

    fields = [
        ("Lot", record.numero_lot),
        ("Ouvert", stamp(record.date_ouverture)),
        ("Au plus tard", stamp(record.dlc_secondaire)),
        ("Operateur", record.operateur),
    ]
    rows = "".join(f"<div><b>{escape(label)} :</b> {escape(value)}</div>" for label, value in fields)
    return (
        "<style>body{margin:0;color:#000;background:#fff;font:11px sans-serif}"
        "article{padding:2mm;box-sizing:border-box;overflow-wrap:anywhere}"
        "header,footer{font-size:9px}h1{font-size:13px;margin:1mm 0}"
        "div{margin:0.6mm 0}footer{margin-top:1mm}</style>"
        f"<article><header>ΣIRIUS · OUVERTURE #{record.id}</header>"
        f"<h1>{escape(record.nom_produit)}</h1>{rows}"
        "<footer>Europe/Paris · Respecter les consignes fabricant/PMS."
        " Regle et original conserves au registre.</footer></article>"
    )
