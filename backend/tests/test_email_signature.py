from email_signature import COPYRIGHT_LINE, SIGNATURE_LINE, append_signature_text


def test_append_signature_text_adds_sirius_copyright():
    message = append_signature_text("Bonjour,")

    assert SIGNATURE_LINE in message
    assert COPYRIGHT_LINE in message


def test_append_signature_text_does_not_duplicate_copyright():
    message = append_signature_text(append_signature_text("Bonjour,"))

    assert message.count(SIGNATURE_LINE) == 1
    assert message.count(COPYRIGHT_LINE) == 1