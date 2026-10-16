"""Explicit account-wide invoice preview grammar and bounded factual report."""

import re


def batch_days(text: str) -> int | None:
    match = re.fullmatch(
        r"(?:prepare|preparer) (?:les|toutes les) relances "
        r"(?:de mes|des|de toutes les) factures "
        r"(?:en retard de plus de|ayant plus de) (\d{1,4}|quinze) jours"
        r"(?: de retard)?[\s.!?]*",
        text,
    )
    if not match:
        return None
    days = 15 if match[1] == "quinze" else int(match[1])
    return days if 0 <= days <= 3650 else None


def batch_report(batch: dict) -> str:
    counts = batch["counts"]
    lines = [
        "Prévisualisation des relances · factures THÉMIS de votre compte uniquement.",
        "Ce lot porte sur votre compte entier, pas uniquement sur le dossier affiché.",
        f"Au {batch['on']} ({batch['timezone']}), retard strictement supérieur "
        f"à {batch['minimum_overdue_days']} jours.",
        f"{batch['examined']} facture(s) examinée(s) ; "
        f"{counts['prepared']} texte(s) préparé(s) à relire, "
        f"{counts['blocked']} facture(s) bloquée(s), {counts['skipped']} ignorée(s).",
        "Préparé ne signifie pas prêt à envoyer : vérifiez l'adresse et les règlements récents.",
    ]
    actionable = [item for item in batch["items"] if item["state"] != "skipped"]
    for item in actionable[:10]:
        source = item["source"]
        label = source["id"] if source else "Référence à corriger"
        lines.append(f"\n{label} — {item['reason']}")
        content = item.get("content")
        if content:
            lines.extend([
                f"Solde enregistré : {content['remaining']:.2f} € ; retard : {item['overdue_days']} jours.",
                f"Destinataire à vérifier : {content['to'] or 'non renseigné'}.",
                f"Objet : {content['subject']}", content["message"],
            ])
    if len(actionable) > 10:
        lines.append(f"\nSeules les dix premières préparations/anomalies sont détaillées ici ; "
                     f"{len(actionable) - 10} autre(s) figurent dans le résultat structuré du lot.")
    if not batch["items"]:
        lines.append("Aucune facture accessible dans la partie consultée.")
    if batch["truncated"]:
        lines.append(f"Lecture partielle : limite de {batch['limit']} factures examinées. "
                     "Ce bilan ne couvre pas toutes les factures du compte.")
    lines.append(
        "Brouillons temporaires non enregistrés. Aucun message envoyé, aucune facture modifiée. "
        "Les preuves de règlements récents ne sont pas disponibles dans cette source. "
        "Pour enregistrer une proposition, utilisez le parcours Brouillon du dossier après relecture."
    )
    return "\n".join(lines)
