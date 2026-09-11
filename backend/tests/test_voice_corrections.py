from voice_corrections import normalize_voice_transcript


def test_normalizes_creator_name_from_common_stt_mistakes():
    assert normalize_voice_transcript("qui est Daniel Pontel") == "qui est Daniel Partel"
    assert normalize_voice_transcript("daniel, parti") == "Daniel Partel"
    assert normalize_voice_transcript("part elle") == "Partel"


def test_does_not_replace_unrelated_parti():
    assert normalize_voice_transcript("le colis est parti") == "le colis est parti"


def test_normalizes_sirius_module_lexicon():
    assert normalize_voice_transcript("serious ouvre argousse") == "SIRIUS ouvre ARGUS"
    assert normalize_voice_transcript("out look envoie un mail") == "Outlook envoie un mail"
