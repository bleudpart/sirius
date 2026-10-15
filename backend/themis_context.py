"""Résumé des données THÉMIS (factures, devis, stocks, clients) pour le contexte de l'assistant."""
import logging
import re
from datetime import date

logger = logging.getLogger(__name__)

NO_ID = {"_id": 0}
MAX_CONTEXT_CHARS = 4000

_BUSINESS_RE = re.compile(
    r"th[ée]mis|factur|devis|impay|encaiss|relanc|cr[ée]ance|qui me doit|doit de l'argent|"
    r"client|stock|rupture|r[ée]appro|inventaire|article|chiffre d'affaires|\bca\b|ventes?\b|"
    r"tr[ée]sorerie|paiement|r[èe]glement|commande|compta|\btva\b|b[ée]n[ée]fice|recette",
    re.IGNORECASE,
)


def wants_business_context(text: str, history=None) -> bool:
    """Vrai si la question (ou la précédente) porte sur la gestion de l'entreprise."""
    if _BUSINESS_RE.search(str(text or "")):
        return True
    previous = [
        str(turn.get("content") or "")
        for turn in (history or [])[-4:]
        if isinstance(turn, dict) and turn.get("role") == "user"
    ]
    return bool(previous and _BUSINESS_RE.search(previous[-1]))


def _euros(value) -> str:
    try:
        amount = float(value or 0)
    except (TypeError, ValueError):
        amount = 0.0
    return f"{amount:,.2f} €".replace(",", " ").replace(".", ",")


def _is_late(due: str, today: date) -> bool:
    try:
        return date.fromisoformat(str(due)[:10]) < today
    except ValueError:
        return False


async def themis_context(db, uid: str, today: date | None = None) -> str:
    """Texte compact décrivant l'état réel de THÉMIS pour cet utilisateur ("" si vide)."""
    if db is None or not uid:
        return ""
    today = today or date.today()
    query = {"user_id": uid}
    try:
        docs = await db.themis_docs.find(query, NO_ID).to_list(1000)
        items = await db.themis_items.find(query, NO_ID).to_list(1000)
        clients = await db.themis_clients.find(query, NO_ID).to_list(500)
        orders = await db.themis_orders.find(query, NO_ID).to_list(500)
        payments = await db.themis_payments.find(query, NO_ID).to_list(2000)
    except Exception as error:
        logger.warning("themis_context indisponible (%s)", type(error).__name__)
        return ""
    if not (docs or items or clients or orders):
        return ""

    factures = [d for d in docs if d.get("kind") == "facture"]
    unpaid = [d for d in factures if d.get("status") not in ("payé", "refusé")]
    quotes = [d for d in docs if d.get("kind") == "devis" and d.get("status") in ("brouillon", "envoyé")]
    low_stock = [i for i in items if int(i.get("stock", 0) or 0) <= int(i.get("alert", 5) or 0)]
    active_orders = [o for o in orders if o.get("status") in ("en_attente", "en_cours", "expédiée")]
    due_total = sum(max(0.0, float(d.get("total_ttc", 0) or 0) - float(d.get("paid", 0) or 0)) for d in unpaid)
    cashed = sum(float(p.get("amount", 0) or 0) for p in payments)

    lines = [
        f"Encaissé : {_euros(cashed)} ; reste à encaisser : {_euros(due_total)} "
        f"({len(unpaid)} facture(s) non payée(s)) ; devis en cours : {len(quotes)} ; "
        f"clients : {len(clients)} ; commandes actives : {len(active_orders)} ; "
        f"articles en stock bas : {len(low_stock)}."
    ]
    if unpaid:
        lines.append("Factures non payées :")
        for d in sorted(unpaid, key=lambda d: str(d.get("due_date") or d.get("created_at") or ""))[:10]:
            rest = max(0.0, float(d.get("total_ttc", 0) or 0) - float(d.get("paid", 0) or 0))
            due = str(d.get("due_date") or "")[:10]
            detail = f"échéance {due}" + (" (EN RETARD)" if due and _is_late(due, today) else "") if due else "sans échéance"
            lines.append(
                f"- {d.get('number', '?')} — {d.get('client_name') or 'client inconnu'} — reste {_euros(rest)} "
                f"sur {_euros(d.get('total_ttc'))} — {detail} — statut {d.get('status', '?')}"
            )
    if quotes:
        lines.append("Devis en cours :")
        for d in quotes[:5]:
            lines.append(f"- {d.get('number', '?')} — {d.get('client_name') or 'client inconnu'} — {_euros(d.get('total_ttc'))} — {d.get('status')}")
    if low_stock:
        lines.append("Stock bas :")
        for i in low_stock[:10]:
            lines.append(f"- {i.get('name', '?')} : {int(i.get('stock', 0) or 0)} en stock (seuil {int(i.get('alert', 5) or 0)})")
    if clients:
        names = [str(c.get("name") or "").strip() for c in clients if str(c.get("name") or "").strip()]
        lines.append("Clients : " + ", ".join(names[:15]) + (" …" if len(names) > 15 else ""))

    return "\n".join(lines)[:MAX_CONTEXT_CHARS]


def themis_prompt_section(context: str) -> str:
    context = str(context or "").strip()[:MAX_CONTEXT_CHARS]
    if not context:
        return ""
    return (
        "\n\nDONNÉES RÉELLES DE GESTION (module THÉMIS de l'utilisateur, à jour) :\n"
        + context
        + "\nRègles : appuie-toi sur ces chiffres exacts pour répondre aux questions sur les factures, devis, "
        "clients, stocks ou l'encaissement ; ne les invente ni ne les arrondis. Si une information manque, dis-le. "
        "Tu ne peux pas envoyer de relance toi-même : propose d'ouvrir THÉMIS pour la relance par mail."
    )
