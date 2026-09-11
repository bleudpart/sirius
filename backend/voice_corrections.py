# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Corrections ciblées et extensibles des transcriptions vocales fréquentes."""

from __future__ import annotations

import re


def normalize_voice_transcript(text: str) -> str:
    if not text:
        return ""
    corrected = str(text)
    replacements = (
        (r"\bdaniel\s*[,;:]?\s*pontel\b", "Daniel Partel"),
        (r"\bdaniel\s*[,;:]?\s*parti\b", "Daniel Partel"),
        (r"\bdaniel\s*[,;:]?\s*part\s+elle\b", "Daniel Partel"),
        (r"\bpontel\b", "Partel"),
        (r"\bpart\s+elle\b", "Partel"),
        (r"\bserious\b", "SIRIUS"),
        (r"\bsyrius\b", "SIRIUS"),
        (r"\bcirius\b", "SIRIUS"),
        (r"\bsirus\b", "SIRIUS"),
        (r"\bcyrus\b", "SIRIUS"),
        (r"\bs[ée]rieux\b", "SIRIUS"),
        (r"\bargousse\b", "ARGUS"),
        (r"\bargus\b", "ARGUS"),
        (r"\bargue us\b", "ARGUS"),
        (r"\batlace\b", "ATLAS"),
        (r"\bathlas\b", "ATLAS"),
        (r"\boracle divin\b", "Oracle Divin"),
        (r"\bnummarius\b", "Nummarius"),
        (r"\bnumarius\b", "Nummarius"),
        (r"\bth[ée]mis\b", "Thémis"),
        (r"\bpant[ée]on\b", "Panthéon"),
        (r"\bh[ée]phaistos\b", "Héphaïstos"),
        (r"\bh[ée]racl[eè]s\b", "Héraclès"),
        (r"\bpythagor[eé]\b", "Pythagore"),
        (r"\bcaliop[eé]\b", "Calliope"),
        (r"\bprom[ée]th[ée]\b", "Prométhée"),
        (r"\bherm[èe]s\b", "Hermès"),
        (r"\bagora\b", "Agora"),
        (r"\bout look\b", "Outlook"),
        (r"\bhot mail\b", "Hotmail"),
    )
    for pattern, replacement in replacements:
        corrected = re.sub(pattern, replacement, corrected, flags=re.IGNORECASE)
    return corrected
