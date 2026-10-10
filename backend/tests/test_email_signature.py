import base64
from email.message import EmailMessage

import email_signature
from email_signature import (
    COPYRIGHT_LINE,
    EMAIL_LOGO,
    SIGNATURE_CID,
    SIGNATURE_LINE,
    add_signature_to_message,
    append_signature_text,
    graph_reply_signature,
    graph_signature,
    signature_identity,
    signature_image,
)


def test_append_signature_text_adds_sirius_copyright():
    message = append_signature_text("Bonjour,")

    assert SIGNATURE_LINE in message
    assert COPYRIGHT_LINE in message
    assert "M. Daniel Partel" in SIGNATURE_LINE
    assert "M. Daniel Partel" in COPYRIGHT_LINE


def test_append_signature_text_does_not_duplicate_copyright():
    message = append_signature_text(append_signature_text("Bonjour,"))

    assert message.count(SIGNATURE_LINE) == 1
    assert message.count(COPYRIGHT_LINE) == 1


def test_email_signature_embeds_readable_inline_logo_and_text_fallback():
    message = add_signature_to_message(EmailMessage(), "Bonjour,\nVoici votre document.")
    parts = list(message.walk())
    html = next(part.get_content() for part in parts if part.get_content_type() == "text/html")
    image = next(part for part in parts if part.get_content_type() == "image/png")
    plain = next(part.get_content() for part in parts if part.get_content_type() == "text/plain")

    assert SIGNATURE_LINE in plain and COPYRIGHT_LINE in plain
    assert f"cid:{SIGNATURE_CID}" in html
    assert 'width="96" height="96"' in html
    assert "width:96px;height:96px;" in html
    assert f'font-size:14px;font-weight:700;line-height:1.5;color:#a67b2e;">{SIGNATURE_LINE}</div>' in html
    assert image["Content-ID"] == f"<{SIGNATURE_CID}>"
    assert image.get_filename() == EMAIL_LOGO


def test_inline_signature_coexists_with_pdf_attachment():
    message = add_signature_to_message(EmailMessage(), "Bonjour.")
    message.add_attachment(b"%PDF-1.4 test", maintype="application", subtype="pdf", filename="document.pdf")
    parts = list(message.walk())

    assert any(part.get_content_type() == "image/png" for part in parts)
    assert any(part.get_content_type() == "application/pdf" and part.get_filename() == "document.pdf" for part in parts)


def test_graph_signature_uses_inline_logo_attachment():
    body, attachments = graph_signature("Bonjour,\nVoici votre document.")

    assert body["contentType"] == "HTML"
    assert f"cid:{SIGNATURE_CID}" in body["content"]
    assert 'width="96" height="96"' in body["content"]
    assert "width:96px;height:96px;" in body["content"]
    assert f'font-size:14px;font-weight:700;line-height:1.5;color:#a67b2e;">{SIGNATURE_LINE}</div>' in body["content"]
    assert len(attachments) == 1
    assert attachments[0]["isInline"] is True
    assert attachments[0]["contentId"] == SIGNATURE_CID
    assert base64.b64decode(attachments[0]["contentBytes"]) == signature_image()


def test_graph_reply_keeps_original_thread_below_signed_response():
    body, attachments = graph_reply_signature(
        "Merci pour ces éléments.",
        {"contentType": "HTML", "content": "<blockquote>Message précédent</blockquote>"},
    )

    assert body["content"].index("Merci pour ces éléments.") < body["content"].index(SIGNATURE_LINE)
    assert body["content"].index(SIGNATURE_LINE) < body["content"].index("Message précédent")
    assert len(attachments) == 1


def test_graph_signature_remains_readable_when_brand_image_is_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(email_signature, "SIGNATURE_ASSET_DIR", tmp_path)

    body, attachments = graph_signature("Bonjour.")

    assert SIGNATURE_LINE in body["content"]
    assert COPYRIGHT_LINE in body["content"]
    assert f"cid:{SIGNATURE_CID}" not in body["content"]
    assert attachments == []


def test_profile_signature_identity_is_independent_of_login_email():
    identity = signature_identity({
        "name": "Compte de Camille",
        "email": "login@example.net",
        "preferences": {
            "signature_name": "Camille Martin",
            "signature_email": "camille@example.fr",
        },
    })
    message = append_signature_text("Bonjour.", **identity)
    body, attachments = graph_signature("Bonjour.", **identity)

    assert "Camille Martin" in message
    assert "camille@example.fr" in message
    assert "login@example.net" not in message
    assert "Camille Martin" in body["content"]
    assert "mailto:camille@example.fr" in body["content"]
    assert len(attachments) == 1


def test_internal_local_account_email_uses_public_signature_default():
    identity = signature_identity({"name": "Daniel Partel", "email": "daniel@sirius.local"})

    assert identity["signature_name"] == "M. Daniel Partel"
    assert identity["signature_email"] == "danielsirius.pro2026@gmail.com"