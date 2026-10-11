from voice_corrections import normalize_voice_transcript
import pytest


def test_normalizes_creator_name_from_common_stt_mistakes():
    assert normalize_voice_transcript("qui est Daniel Pontel") == "qui est Daniel Partel"
    assert normalize_voice_transcript("daniel, parti") == "Daniel Partel"
    assert normalize_voice_transcript("part elle") == "Partel"


def test_does_not_replace_unrelated_parti():
    assert normalize_voice_transcript("le colis est parti") == "le colis est parti"


def test_normalizes_sirius_module_lexicon():
    assert normalize_voice_transcript("serious ouvre argousse") == "SIRIUS ouvre ARGUS"
    assert normalize_voice_transcript("out look envoie un mail") == "Outlook envoie un mail"


def test_normalizes_briefing_transcription_typo():
    assert normalize_voice_transcript("brieffing du soir") == "briefing du soir"


@pytest.mark.parametrize("text", ["authenticité", "les authenticités", "Sirius, les authenticités du jour",
                                 "donne-moi l'authenticité du jour"])
def test_news_command_sound_alike_is_corrected(text):
    assert "actualités" in normalize_voice_transcript(text)


@pytest.mark.parametrize("text", ["définis authenticité", "vérifie l'authenticité de ce document",
                                 "je m'intéresse à l'authenticité"])
def test_actual_authenticity_requests_are_preserved(text):
    assert normalize_voice_transcript(text) == text
