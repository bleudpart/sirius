import asyncio
import json
from types import SimpleNamespace

import pytest
import sirius_brain


@pytest.mark.parametrize("prompt", ["briefing", "briefing du soir", "brieffing du soir"])
def test_briefing_intent_bypasses_the_general_or_llm_fallback(monkeypatch, prompt):
    class UnexpectedClient:
        @property
        def chat(self):
            raise AssertionError("The briefing intent must be resolved locally.")

    monkeypatch.setattr(sirius_brain, "client", UnexpectedClient())

    result = asyncio.run(sirius_brain.parse_intent(prompt))

    assert result["action"] == "daily_briefing"
    assert result["say"]


def test_briefing_enrichment_uses_the_dedicated_prompt(monkeypatch):
    captured = {}

    class FakeCompletions:
        async def create(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="Briefing complet."))]
            )

    class FakeClient:
        def __init__(self, **kwargs):
            captured["client"] = kwargs
            self.chat = SimpleNamespace(completions=FakeCompletions())

    monkeypatch.setattr(sirius_brain, "AsyncOpenAI", FakeClient)
    monkeypatch.setattr(sirius_brain, "ENV_GROQ_LLM_KEY", "test-groq-key")
    monkeypatch.setattr(sirius_brain, "ENV_K3_KEY", "")
    monkeypatch.setattr(
        sirius_brain,
        "_briefing_cache",
        {"t": 0.0, "key": "", "txt": ""},
    )

    data = {"date": "2026-08-19", "actualites_par_rubrique": [{"label": "Culture", "description": "Contexte " * 3100}]}
    result = asyncio.run(sirius_brain.enrich_briefing(data))

    assert result == "Briefing complet."
    assert captured["client"]["base_url"] == sirius_brain.GROQ_LLM_ENDPOINT
    assert captured["model"] == sirius_brain.GROQ_LLM_PRIMARY
    assert captured["messages"][0]["content"] == sirius_brain.BRIEFING_PROMPT
    assert json.loads(captured["messages"][1]["content"]) == data
    assert captured["max_tokens"] == 2600
    for section in ("MÉTÉO", "MARCHÉS ET CRYPTO", "ACTUALITÉS", "CIEL", "VOTRE JOURNÉE", "SYNTHÈSE"):
        assert section in sirius_brain.BRIEFING_PROMPT
    for section in ("France", "International", "Politique", "Économie", "Sport", "Santé",
                    "Sciences et technologies", "Environnement", "Culture"):
        assert section in sirius_brain.BRIEFING_PROMPT
    assert "650 à 750 mots" in sirius_brain.BRIEFING_PROMPT
