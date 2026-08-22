"""Detection locale des intentions Productivite & Travail."""

import re
import unicodedata


def _normalize(value: str) -> str:
    return "".join(
        character
        for character in unicodedata.normalize("NFD", (value or "").lower())
        if unicodedata.category(character) != "Mn"
    )


def parse_productivity_intent(prompt: str) -> dict | None:
    raw = (prompt or "").strip()
    command = _normalize(raw)
    if not command:
        return None

    tab = ""
    if re.search(r"\b(?:document(?:s)?|doc(?:s)?|pdf|analyse(?:r|s)?)\b", command):
        tab = "documents"
    elif re.search(r"\b(?:code|bug|erreur|corrige|debug|log)\b", command):
        tab = "code"
    elif re.search(r"\b(?:note(?:s)?|memo(?:s)?|memoire de travail)\b", command):
        tab = "notes"
    elif re.search(r"\b(?:tache(?:s)?|todo(?:s)?|a faire|priorite(?:s)?|echeance(?:s)?)\b", command):
        tab = "tasks"
    elif re.search(r"\b(?:rapport(?:s)?|compte rendu|synthese de travail)\b", command):
        tab = "reports"
    if not tab:
        return None

    action = "open"
    if re.search(r"\b(?:creer|ajoute|nouvelle|nouveau)\b", command):
        action = "create"
    elif re.search(r"\b(?:liste|montre|affiche|ouvre)\b", command):
        action = "list"

    return {
        "action": "productivity_control",
        "productivity": {"tab": tab, "command": action, "text": raw[:240]},
        "say": "J'ouvre le module Productivite et Travail.",
    }
