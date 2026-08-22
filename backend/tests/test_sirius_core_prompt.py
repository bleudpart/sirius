# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Regression tests for the active SIRIUS production prompt."""

from sirius_brain import SIRIUS_CORE_PROMPT, build_system_prompt


def test_system_prompt_matches_the_current_sirius_production_contract():
    prompt = build_system_prompt(
        profile={"name": "Daniel"},
        memory=["Déployer le module HUD"],
        mode="turbo",
        mood={"label": "concentré"},
    )

    assert prompt.startswith(SIRIUS_CORE_PROMPT)
    assert "assistant vocal intelligent" in SIRIUS_CORE_PROMPT
    assert "STYLE DE COMMUNICATION" in SIRIUS_CORE_PROMPT
    assert "GESTION DE MÉMOIRE" in SIRIUS_CORE_PROMPT
    assert "COMPTE RENDU FINAL" in SIRIUS_CORE_PROMPT
    assert "EXÉCUTION AUTONOME" in SIRIUS_CORE_PROMPT
    assert "SIRIUS Display sans bouton intermédiaire" in SIRIUS_CORE_PROMPT
    assert "commentaire technique reste court" in SIRIUS_CORE_PROMPT
    assert "Contexte utilisateur : ton interlocuteur s'appelle Daniel." in prompt
    assert "Mode d'exécution : turbo." in prompt
    assert "Contexte d'humeur actuel : concentré." in prompt
    assert "Éléments de contexte récents : Déployer le module HUD." in prompt
