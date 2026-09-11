# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Signature SIRIUS ajoutée automatiquement aux e-mails envoyés (Outlook, Gmail)."""

SIGNATURE_TEXT = (
    "\n\n—\n"
    "Sirius"
)

SIGNATURE_HTML = """
<div style="margin-top:22px;padding-top:12px;border-top:1px solid #2a3b45;
            font-family:'Segoe UI',Arial,sans-serif;">
  <div style="font-size:13px;font-weight:600;color:#67e8f9;">Sirius</div>
</div>
""".strip()


def append_signature_text(body: str) -> str:
    """Ajoute la signature texte, sans la dupliquer si déjà présente (ex: réponse à
    une réponse déjà signée dans le même fil)."""
    body = body or ""
    if "Sirius" in body or "ΣIRIUS HUD" in body or "S I R I U S" in body or "Σ I R I U S" in body:
        return body
    return body.rstrip() + SIGNATURE_TEXT


def append_signature_html(body_html: str) -> str:
    body_html = body_html or ""
    if "SIRIUS" in body_html.upper() or "ΣIRIUS" in body_html.upper():
        return body_html
    return body_html.rstrip() + "\n" + SIGNATURE_HTML
