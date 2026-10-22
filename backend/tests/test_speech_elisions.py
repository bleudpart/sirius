import pytest

from speech_text import speakable_text


@pytest.mark.parametrize("text", [
    "L'oiseau", "L ’ oiseau", "L\u200b’\u200boiseau", "l＇ oiseau",
])
def test_elided_article_stays_attached_for_all_remote_providers(text):
    assert speakable_text(text) == "l'oiseau"
    assert speakable_text(speakable_text(text)) == "l'oiseau"


def test_elisions_do_not_rewrite_a_letter_or_a_pronoun():
    assert speakable_text("La lettre L. Elle observe l ’ oiseau et c ’ est beau.") == (
        "La lettre L. Elle observe l'oiseau et c'est beau."
    )
