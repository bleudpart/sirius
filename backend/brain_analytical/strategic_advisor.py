"""Rédaction finale uniquement : données consolidées, quota existant, chiffres contrôlés et repli explicite."""
import json
import logging
import re
import sqlite3
from collections.abc import Awaitable, Callable
from datetime import datetime
from decimal import Decimal, localcontext

from openai import APIError, AsyncOpenAI
from pydantic import ValidationError
from pymongo.errors import PyMongoError

from brain_analytical.regles import fr
from brain_analytical.schemas import (
    BusinessHealthSnapshot, HorizonAction, Recommandation, RedactionLLM, SeveriteAlerte,
    SourceSynthese, SyntheseStrategique, TypeDeclencheur,
)
from finance_connectors import json_nesting_exceeds
from schemas.finance import FINANCE_CONTEXT

logger = logging.getLogger(__name__)
Redacteur = Callable[[str], Awaitable[tuple[str, str]]]
AVERTISSEMENT = "Repères indicatifs issus des pièces saisies, non certifiés. Faire valider les décisions par l'expert-comptable, le banquier ou le courtier."
PROMPT = """Vous êtes le conseiller financier de ΣIRIUS. Expliquez en français, en vouvoyant,
uniquement les faits consolidés fournis. Aucun calcul, nouveau chiffre, diagnostic juridique,
fiscal ou avis définitif. Ne déduisez pas qu'une donnée manquante vaut zéro.
Répondez en JSON : {"resume": "...", "points_cles": ["..."],
"recommandations": [{"titre": "...", "action": "...", "horizon": "IMMEDIAT|SEMAINE|MOIS|TRIMESTRE",
"metriques": ["clé fournie"]}]}. Au plus 5 éléments par liste, résumé de 1200 caractères,
titres de 120 caractères, actions de 400 caractères. Aucun Markdown."""


class RedactionIndisponible(ValueError):
    pass


def faits(snapshot: BusinessHealthSnapshot) -> str:
    projection = snapshot.projection
    payload = {
        "secteur": snapshot.secteur.value, "devise": snapshot.devise, "niveau": snapshot.niveau.value,
        "periode": snapshot.periode.model_dump(mode="json"), "indice": snapshot.indice,
        "indicateurs": [{"cle": i.cle, "libelle": i.libelle, "valeur": fr(i.valeur, 2) if i.valeur is not None else None,
                        "unite": i.unite} for i in snapshot.indicateurs],
        "alertes": [{"code": a.code, "severite": a.severite.value, "metrique": a.metrique,
                    "libelle": a.libelle_metrique, "valeur": fr(a.valeur, 2) if a.valeur is not None else None,
                    "seuil": fr(a.seuil, 2) if a.seuil is not None else None,
                    "unite": a.unite, "actions": a.plan_action} for a in snapshot.alertes],
        "projection": [{"horizon": f"J+{p.jour}", "solde": fr(p.solde, 2)} for p in projection.points] if projection else None,
        "limites": AVERTISSEMENT,
    }
    return json.dumps(payload, ensure_ascii=False)


def _numbers(text: str) -> set[Decimal]:
    normalized = re.sub(r"(?<=\d)[ \u00a0\u202f](?=\d)", "", text)
    return {Decimal(match.replace(",", ".")) for match in re.findall(r"\d+(?:[.,]\d+)?", normalized)}


def verifier_redaction(raw: str, facts: str, snapshot: BusinessHealthSnapshot) -> RedactionLLM:
    if len(raw.encode("utf-8")) > 32 * 1024 or json_nesting_exceeds(raw):
        raise RedactionIndisponible("Réponse IA trop volumineuse ou trop imbriquée.")
    redaction = RedactionLLM.model_validate_json(raw)
    allowed = _numbers(facts)
    with localcontext(FINANCE_CONTEXT):
        allowed |= {v.quantize(Decimal("1")) for v in tuple(allowed)}
        allowed |= {v.quantize(Decimal("0.1")) for v in tuple(allowed)}
    if not _numbers(redaction.model_dump_json()) <= allowed:
        raise RedactionIndisponible("Chiffre non vérifiable dans la réponse IA.")
    keys = {i.cle for i in snapshot.indicateurs} | {a.metrique for a in snapshot.alertes}
    if any(key not in keys for r in redaction.recommandations for key in r.metriques):
        raise RedactionIndisponible("Métrique inconnue dans la réponse IA.")
    return redaction


def repli(snapshot: BusinessHealthSnapshot, declencheur: TypeDeclencheur, now: datetime, motif: str) -> SyntheseStrategique:
    labels = {"SAIN": "Aucun seuil critique ni de vigilance franchi", "VIGILANCE": "Situation à surveiller",
              "CRITIQUE": "Situation nécessitant une attention prioritaire", "INDETERMINE": "Données insuffisantes"}
    return SyntheseStrategique(
        company_id=snapshot.company_id, empreinte_snapshot=snapshot.empreinte,
        generee_le=now, declencheur=declencheur, source=SourceSynthese.DETERMINISTE, motif_repli=motif,
        resume=f"{labels[snapshot.niveau.value]}. {len(snapshot.alertes)} point(s) d'attention sur les pièces analysées.",
        points_cles=[a.explication for a in snapshot.alertes[:5]],
        recommandations=[Recommandation(
            titre=a.libelle_metrique, action=a.plan_action[0][:400],
            horizon=HorizonAction.IMMEDIAT if a.severite == SeveriteAlerte.CRITICAL else
            HorizonAction.MOIS if a.severite == SeveriteAlerte.WARNING else HorizonAction.TRIMESTRE,
            metriques=[a.metrique],
        ) for a in snapshot.alertes[:5]], avertissement=AVERTISSEMENT,
    )


async def _rediger(facts: str) -> tuple[str, str]:
    from sirius_brain import fast_options, fast_provider
    service, key, endpoint, models = fast_provider()
    if not key:
        raise RedactionIndisponible("Aucun fournisseur IA autorisé n'est configuré.")
    async with AsyncOpenAI(api_key=key, base_url=endpoint, max_retries=0, timeout=20.0) as client:
        response = await client.chat.completions.create(
            model=models[0], messages=[{"role": "system", "content": PROMPT}, {"role": "user", "content": facts}],
            temperature=0.2, response_format={"type": "json_object"}, **fast_options(service, 1400),
        )
    return response.choices[0].message.content or "", models[0]


async def conseiller(db, user_id: str | None, snapshot: BusinessHealthSnapshot,
                     declencheur: TypeDeclencheur, now: datetime, redacteur: Redacteur | None = None) -> SyntheseStrategique:
    from provider_access import metered_scope, owner_allowed
    try:
        user = await db.users.find_one({"user_id": user_id}) if user_id else None
        if not user or user.get("disabled") or not owner_allowed(user):
            return repli(snapshot, declencheur, now, "Compte inactif ou sans droit à la synthèse IA.")
        facts = faits(snapshot)
        async with metered_scope(db, user) as state:
            if state["blocked"]:
                return repli(snapshot, declencheur, now, "Quota IA atteint.")
            raw, model = await (redacteur or _rediger)(facts)
            result = verifier_redaction(raw, facts, snapshot)
        return SyntheseStrategique(
            company_id=snapshot.company_id, empreinte_snapshot=snapshot.empreinte, generee_le=now,
            declencheur=declencheur, source=SourceSynthese.IA, modele=model, resume=result.resume,
            points_cles=result.points_cles,
            recommandations=[Recommandation.model_validate(r.model_dump()) for r in result.recommandations],
            avertissement=AVERTISSEMENT,
        )
    except (RedactionIndisponible, ValidationError, APIError, TimeoutError, sqlite3.Error, PyMongoError) as error:
        motif = str(error) if isinstance(error, RedactionIndisponible) else "Service IA indisponible ou réponse invalide."
        logger.warning("[CERVEAU] Synthèse déterministe : %s", motif)
        return repli(snapshot, declencheur, now, motif)
