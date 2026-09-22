# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Regression tests for the active ΣIRIUS production prompt."""

from sirius_brain import SIRIUS_CORE_PROMPT, build_system_prompt


def test_system_prompt_matches_the_current_sirius_production_contract():
    prompt = build_system_prompt(
        profile={"name": "Daniel"},
        memory=["Déployer le module HUD"],
        mode="turbo",
        mood={"label": "concentré"},
        environment={"active_tasks": ["Briefing du jour"], "display_open": True, "activity": "intense"},
    )

    assert prompt.startswith(SIRIUS_CORE_PROMPT)
    assert "assistant vocal intelligent" in SIRIUS_CORE_PROMPT
    assert "STYLE DE COMMUNICATION" in SIRIUS_CORE_PROMPT
    assert "Tu connais ton environnement de travail" in SIRIUS_CORE_PROMPT
    assert "les tâches en cours" in SIRIUS_CORE_PROMPT
    assert "DÉCISION, SOLUTIONS ET OUTILS" in SIRIUS_CORE_PROMPT
    assert "tu choisis toi-même la solution la plus utile" in SIRIUS_CORE_PROMPT
    assert "une alternative concrète et réalisable" in SIRIUS_CORE_PROMPT
    assert "PRÉSENCE OPÉRATIONNELLE" in SIRIUS_CORE_PROMPT
    assert "un constat précis" in SIRIUS_CORE_PROMPT
    assert "ne prétends jamais avoir observé" in SIRIUS_CORE_PROMPT
    assert "RÉACTIVITÉ NATURELLE" in SIRIUS_CORE_PROMPT
    assert "jamais avec un scénario figé" in SIRIUS_CORE_PROMPT
    assert "N'interviens pas pour remplir le silence" in SIRIUS_CORE_PROMPT
    assert "l'ÉTAT OPÉRATIONNEL DU HUD est fourni" in SIRIUS_CORE_PROMPT
    assert "donne d'abord la décision utile" in SIRIUS_CORE_PROMPT
    assert "GESTION DE MÉMOIRE" in SIRIUS_CORE_PROMPT
    assert "COMPTE RENDU DES TÂCHES" in SIRIUS_CORE_PROMPT
    assert "EXÉCUTION AUTONOME" in SIRIUS_CORE_PROMPT
    assert "ΣIRIUS Display sans bouton intermédiaire" in SIRIUS_CORE_PROMPT
    assert "commentaire technique reste court" in SIRIUS_CORE_PROMPT
    # Charte de proactivité : initiative encadrée par les niveaux d'autonomie.
    assert "PROACTIVITÉ" in SIRIUS_CORE_PROMPT
    assert "NIVEAUX D’AUTONOMIE" in SIRIUS_CORE_PROMPT
    assert "Exécution directe" in SIRIUS_CORE_PROMPT
    assert "validation finale" in SIRIUS_CORE_PROMPT
    assert "Confirmation obligatoire" in SIRIUS_CORE_PROMPT
    assert "RÈGLES DE COMMUNICATION" in SIRIUS_CORE_PROMPT
    assert "Contexte utilisateur : ton interlocuteur s'appelle Daniel." in prompt
    assert "Mode d'exécution : turbo." in prompt
    assert "Contexte d'humeur actuel : concentré." in prompt
    assert "ÉTAT OPÉRATIONNEL DU HUD" in prompt
    assert "tâches en cours : Briefing du jour" in prompt
    assert "ΣIRIUS Display ouvert" in prompt
    assert "MÉMOIRE PERSISTANTE" in prompt
    assert "- Déployer le module HUD" in prompt
