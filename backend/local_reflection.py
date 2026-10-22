"""Bounded structural checks, not an LLM critic or a factual verification service."""

import re

from fastapi import HTTPException


class ReflectedResponseError(HTTPException):
    def __init__(self, report):
        super().__init__(502, "Réponse refusée par les contrôles locaux : " + " ".join(report["issues"]))
        self.reflection = report


def _text_issues(value):
    issues = []
    if not value.lstrip("\ufeff").strip():
        issues.append("Réponse vide.")
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
        issues.append("Caractères de contrôle inattendus.")
    if re.search(r"</?(?:think|analysis|tool_call|function_call)\b", value, re.I):
        issues.append("Balise de raisonnement interne ou d'appel d'outil inattendue.")
    fence = None
    for line in value.lstrip("\ufeff").splitlines():
        marker = re.match(r"^\s*(`{3,}|~{3,})(.*)$", line)
        if not marker:
            continue
        token, suffix = marker.groups()
        if fence is None:
            fence = token
        elif token[0] == fence[0] and len(token) >= len(fence) and not suffix.strip():
            fence = None
    if fence is not None:
        issues.append("Bloc de code non fermé ; fermeture non inventée.")
    return issues


def reflect_text(value):
    report = {
        "scope": "Structure du texte seulement ; exactitude des faits et pertinence non vérifiées.",
        "state": "BLOCKED", "checks": [], "repairs": [], "issues": [],
        "passes": 1, "max_passes": 2, "extra_api_calls": 0,
    }
    if not isinstance(value, str):
        report["issues"].append("Texte attendu.")
        raise ReflectedResponseError(report)
    report["checks"].append("type")
    if len(value) > 12000:
        report["issues"].append("Texte supérieur à 12 000 caractères ; aucune troncature automatique.")
        raise ReflectedResponseError(report)
    report["checks"].extend(["length", "non_empty", "control_characters", "internal_tags", "code_fences"])
    for number in (1, 2):
        report["passes"] = number
        report["issues"] = _text_issues(value)
        if report["issues"]:
            raise ReflectedResponseError(report)
        normalized = value.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").strip()
        if normalized == value:
            report["state"] = "REPAIRED" if report["repairs"] else "CHECKED"
            return value, report
        if number == 2:
            break
        report["repairs"].append("Espaces de bord, BOM et fins de ligne normalisés, sans réécriture du contenu.")
        value = normalized
    report["issues"].append("Normalisation non stabilisée en deux passes ; résultat non validé.")
    raise ReflectedResponseError(report)


def reflect_api_error(error):
    """Explain next steps without changing parameters or repeating an uncertain effect."""
    status = error.status_code if isinstance(error, HTTPException) else getattr(error, "status_code", None)
    if isinstance(error, ReflectedResponseError):
        return error.reflection
    if status in (401, 403):
        category, advice = "authorization", "Vérifier les droits ou la clé du fournisseur ; aucun changement de fournisseur."
    elif status == 429:
        category, advice = "quota", "Vérifier les quotas avant une nouvelle demande explicite."
    elif status in (400, 404, 409, 422):
        category, advice = "request_or_state", "Relire les entrées et l'état du même parcours ; aucun paramètre corrigé à l'aveugle."
    else:
        category, advice = "unconfirmed", "Consulter les traces du même parcours avant toute reprise ; l'appel a pu être traité."
    return {
        "state": "BLOCKED", "scope": "Diagnostic local de l'erreur, pas vérification de son effet distant.",
        "category": category, "http_status": status, "advice": advice,
        "automatic_retry": False, "extra_api_calls": 0,
    }
