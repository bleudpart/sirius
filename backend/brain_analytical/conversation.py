"""Le cerveau opérationnel lit l'état publié ; il ne recalcule pas la finance dans la conversation."""
import re
import unicodedata

from fastapi import HTTPException

from brain_analytical.orchestrator import AnalyticalOrchestrator
from brain_analytical.repartition import etat_perime
from brain_analytical.routes import etat_autorise, membre_courant


def est_question_strategique(text: str) -> bool:
    normalized = "".join(c for c in unicodedata.normalize("NFD", text.casefold()) if not unicodedata.combining(c))
    return bool(re.search(
        r"\bcerveau analytique\b|\b(?:sante|tresorerie|rentabilite|marges?|risque financier)\b.{0,60}\bentreprise\b"
        r"|\bcomment va (?:mon|notre|l') ?entreprise\b", normalized,
    ))


async def repondre(req, user, db, orchestrator: AnalyticalOrchestrator):
    if not est_question_strategique(req.text):
        return None
    membership = await membre_courant(db, user["user_id"])
    if not membership or membership.get("role") not in {"admin", "manager"}:
        answer = "L'analyse financière nécessite un compte administrateur ou gestionnaire rattaché à l'entreprise."
    else:
        try:
            state = await etat_autorise(orchestrator, str(membership["company_id"]))
        except HTTPException as error:
            if error.status_code != 404:
                raise
            answer = str(error.detail)
        else:
            refreshing = False
            if etat_perime(state.verifie_le, orchestrator.clock()):
                refreshing = await orchestrator.demander_analyse(state.company_id, user["user_id"])
            snapshot = state.snapshot
            if snapshot is None:
                answer = "L'état analytique n'est pas encore disponible."
            else:
                lines = [f"Analyse des pièces du {snapshot.periode.start_date:%d/%m/%Y} au {snapshot.periode.end_date:%d/%m/%Y}."]
                if state.synthese and state.synthese_a_jour:
                    lines.append(state.synthese.resume)
                lines.extend(a.explication for a in snapshot.alertes[:3])
                lines.append("Les détails et plans d'action sont consultables dans ZEUS CORTEX.")
                answer = "\n".join(lines)
            if refreshing:
                answer += " Une actualisation a été demandée en arrière-plan."
            elif etat_perime(state.verifie_le, orchestrator.clock()):
                answer += " Actualisation indisponible : moteur arrêté ou file pleine."
    return {"answer": answer, "state": {"module": "cerveau_analytique"}}
