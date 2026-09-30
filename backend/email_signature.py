# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Signatures SIRIUS intégrées aux e-mails envoyés (Outlook, Gmail)."""

import base64
import re
from email.message import EmailMessage
from html import escape
from pathlib import Path

SIGNATURE_ASSET_DIR = Path(__file__).resolve().parent / "static"
EMAIL_LOGO = "signature-email.png"
WORKSPACE_LOGO = "signature-workspace.png"
SIGNATURE_CID = "sirius-email-signature"

DEFAULT_SIGNATURE_NAME = "M. Daniel Partel"
DEFAULT_SIGNATURE_EMAIL = "danielsirius.pro2026@gmail.com"
SIGNATURE_LINE = f"Message envoyé par ΣIRIUS, assistant de {DEFAULT_SIGNATURE_NAME}"
EMAIL_ADDRESS = DEFAULT_SIGNATURE_EMAIL
EMAIL_LINE = f"E-mail : {EMAIL_ADDRESS}"
COPYRIGHT_LINE = f"© 2026 ΣIRIUS par {DEFAULT_SIGNATURE_NAME} — Tous droits réservés."


def signature_identity(user=None):
    user = user or {}
    preferences = user.get("preferences") if isinstance(user.get("preferences"), dict) else {}
    raw_email = preferences.get("signature_email") or user.get("email") or DEFAULT_SIGNATURE_EMAIL
    raw_name = preferences.get("signature_name") or user.get("name") or DEFAULT_SIGNATURE_NAME
    email = raw_email.strip() if isinstance(raw_email, str) else DEFAULT_SIGNATURE_EMAIL
    name = raw_name.strip() if isinstance(raw_name, str) else DEFAULT_SIGNATURE_NAME
    if not preferences.get("signature_email") and email.lower().endswith("@sirius.local"):
        email = DEFAULT_SIGNATURE_EMAIL
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        email = DEFAULT_SIGNATURE_EMAIL
    if not preferences.get("signature_name") and name == "Daniel Partel":
        name = DEFAULT_SIGNATURE_NAME
    return {"signature_name": name[:120] or DEFAULT_SIGNATURE_NAME, "signature_email": email[:254]}


async def load_signature_identity(db, user_id):
    user = await db.users.find_one(
        {"user_id": user_id},
        {"_id": 0, "name": 1, "email": 1, "preferences": 1},
    )
    return signature_identity(user)


def signature_lines(signature_name=None, signature_email=None):
    name = (signature_name or DEFAULT_SIGNATURE_NAME).strip()[:120] or DEFAULT_SIGNATURE_NAME
    email = (signature_email or DEFAULT_SIGNATURE_EMAIL).strip()[:254]
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        email = DEFAULT_SIGNATURE_EMAIL
    return (
        f"Message envoyé par ΣIRIUS, assistant de {name}",
        f"E-mail : {email}",
        f"© 2026 ΣIRIUS par {name} — Tous droits réservés.",
        email,
    )


def _signature_markup(*, include_image=True, signature_name=None, signature_email=None):
    signature_line, _, copyright_line, email = signature_lines(signature_name, signature_email)
    image = (
        f'<td style="padding:0 14px 0 0;vertical-align:middle;"><img src="cid:{SIGNATURE_CID}" '
        'width="64" height="64" alt="ΣIRIUS — Votre assistant privilégié" '
        'style="display:block;width:64px;height:64px;border:0;outline:none;text-decoration:none;"></td>'
        if include_image else ""
    )
    separator = "border-left:2px solid #a67b2e;" if include_image else ""
    padding = "14px" if include_image else "0"
    safe_email = escape(email, quote=True)
    return f"""
<table role="presentation" cellpadding="0" cellspacing="0" border="0"
       style="margin-top:18px;border-collapse:collapse;font-family:Arial,sans-serif;color:#07141f;">
  <tr>
    {image}
    <td style="padding:0 0 0 {padding};vertical-align:middle;{separator}">
      <div style="font-size:13px;font-weight:600;line-height:1.5;color:#07141f;">{escape(signature_line)}</div>
      <div style="padding-top:3px;font-size:11px;line-height:1.5;overflow-wrap:anywhere;">
        <a href="mailto:{safe_email}" style="color:#07141f;text-decoration:none;">{safe_email}</a>
      </div>
      <div style="padding-top:4px;font-size:11px;line-height:1.5;color:#5b6670;">{escape(copyright_line)}</div>
    </td>
  </tr>
</table>
""".strip()


SIGNATURE_HTML = _signature_markup()


def signature_image(name=EMAIL_LOGO):
    path = SIGNATURE_ASSET_DIR / name
    try:
        return path.read_bytes()
    except OSError:
        return None


def _escaped_message(body):
    return escape(body or "").replace("\r\n", "\n").replace("\n", "<br>\n")


def build_signature_html(body: str, *, include_image=True, signature_name=None, signature_email=None) -> str:
    body = body or ""
    _, _, copyright_line, _ = signature_lines(signature_name, signature_email)
    message = f'<div style="font-family:Arial,sans-serif;line-height:1.5">{_escaped_message(body)}</div>'
    if copyright_line in body:
        return message
    signature = _signature_markup(
        include_image=include_image,
        signature_name=signature_name,
        signature_email=signature_email,
    )
    return f"{message}\n{signature}"


def add_signature_to_message(
    message: EmailMessage,
    body: str,
    *,
    signature_name=None,
    signature_email=None,
) -> EmailMessage:
    """Add a readable text fallback and an email-client-safe inline logo."""
    _, _, copyright_line, _ = signature_lines(signature_name, signature_email)
    message.set_content(append_signature_text(body, signature_name=signature_name, signature_email=signature_email))
    image = signature_image()
    html_body = build_signature_html(
        body,
        include_image=image is not None,
        signature_name=signature_name,
        signature_email=signature_email,
    )
    message.add_alternative(html_body, subtype="html")
    html_part = message.get_body(preferencelist=("html",))
    if image and copyright_line not in (body or ""):
        html_part.add_related(
            image,
            maintype="image",
            subtype="png",
            cid=f"<{SIGNATURE_CID}>",
            disposition="inline",
            filename=EMAIL_LOGO,
        )
    return message


def graph_signature(body: str, *, signature_name=None, signature_email=None):
    """Return an HTML Microsoft Graph body and its inline file attachment."""
    image = signature_image()
    content = build_signature_html(
        body,
        include_image=image is not None,
        signature_name=signature_name,
        signature_email=signature_email,
    )
    attachments = []
    _, _, copyright_line, _ = signature_lines(signature_name, signature_email)
    if image and copyright_line not in (body or ""):
        attachments.append({
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": EMAIL_LOGO,
            "contentType": "image/png",
            "contentBytes": base64.b64encode(image).decode("ascii"),
            "isInline": True,
            "contentId": SIGNATURE_CID,
        })
    return {"contentType": "HTML", "content": content}, attachments


def graph_reply_signature(reply: str, quoted_body: dict | None, *, signature_name=None, signature_email=None):
    """Preserve the quoted Outlook thread below the new signed reply."""
    body, attachments = graph_signature(
        reply,
        signature_name=signature_name,
        signature_email=signature_email,
    )
    quoted_body = quoted_body or {}
    quoted = quoted_body.get("content") or ""
    if (quoted_body.get("contentType") or "").lower() == "text":
        quoted = f'<div>{_escaped_message(quoted)}</div>'
    if quoted:
        body["content"] += (
            '<div style="margin-top:18px;border-top:1px solid #d9dee3;padding-top:10px;">'
            f"{quoted}</div>"
        )
    return body, attachments


def append_signature_text(body: str, *, signature_name=None, signature_email=None) -> str:
    """Ajoute la signature texte, sans la dupliquer si déjà présente (ex: réponse à
    une réponse déjà signée dans le même fil)."""
    body = body or ""
    signature_line, email_line, copyright_line, _ = signature_lines(signature_name, signature_email)
    if signature_line not in body and copyright_line not in body:
        return body.rstrip() + f"\n\n—\n{signature_line}\n{email_line}\n{copyright_line}"
    missing = [line for line in (signature_line, email_line, copyright_line) if line not in body]
    if not missing:
        return body
    return body.rstrip() + "\n" + "\n".join(missing)


def append_signature_html(body_html: str, *, signature_name=None, signature_email=None) -> str:
    body_html = body_html or ""
    signature_line, email_line, copyright_line, _ = signature_lines(signature_name, signature_email)
    if copyright_line in body_html:
        return body_html
    if signature_line in body_html:
        missing = "" if email_line in body_html else f'<div>{escape(email_line)}</div>'
        return body_html.rstrip() + missing + f'\n<div style="margin-top:4px;font-size:11px;color:#8fa8b2;">{escape(copyright_line)}</div>'
    return body_html.rstrip() + "\n" + _signature_markup(
        signature_name=signature_name,
        signature_email=signature_email,
    )
