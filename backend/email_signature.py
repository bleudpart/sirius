# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Signature SIRIUS ajoutée automatiquement aux e-mails envoyés (Outlook, Gmail)."""

SIGNATURE_LINE = "Message envoyé par ΣIRIUS, assistant de Daniel Partel"
COPYRIGHT_LINE = "© 2026 ΣIRIUS par Daniel Partel — Tous droits réservés."

SIGNATURE_TEXT = f"\n\n—\n{SIGNATURE_LINE}\n{COPYRIGHT_LINE}"

SIGNATURE_HTML = f"""
<div style="margin-top:22px;padding-top:12px;border-top:1px solid #2a3b45;
            font-family:'Segoe UI',Arial,sans-serif;">
  <div style="font-size:13px;font-weight:600;color:#67e8f9;">{SIGNATURE_LINE}</div>
    <div style="margin-top:4px;font-size:11px;color:#8fa8b2;">{COPYRIGHT_LINE}</div>
</div>
""".strip()


def append_signature_text(body: str) -> str:
    """Ajoute la signature texte, sans la dupliquer si déjà présente (ex: réponse à
    une réponse déjà signée dans le même fil)."""
    body = body or ""
    if COPYRIGHT_LINE in body:
        return body
    if SIGNATURE_LINE in body:
        return body.rstrip() + "\n" + COPYRIGHT_LINE
    return body.rstrip() + SIGNATURE_TEXT


def append_signature_html(body_html: str) -> str:
    body_html = body_html or ""
    if COPYRIGHT_LINE in body_html:
        return body_html
    if SIGNATURE_LINE in body_html:
        return body_html.rstrip() + f'\n<div style="margin-top:4px;font-size:11px;color:#8fa8b2;">{COPYRIGHT_LINE}</div>'
    return body_html.rstrip() + "\n" + SIGNATURE_HTML
