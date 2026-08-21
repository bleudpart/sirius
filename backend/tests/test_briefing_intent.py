import asyncio
from types import SimpleNamespace

import sirius_brain


def test_briefing_intent_bypasses_the_general_or_llm_fallback(monkeypatch):
    class UnexpectedClient:
        @property
        def chat(self):
            raise AssertionError("The briefing intent must be resolved locally.")

    monkeypatch.setattr(sirius_brain, "client", UnexpectedClient())

    result = asyncio.run(sirius_brain.parse_intent("briefing"))

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

    result = asyncio.run(sirius_brain.enrich_briefing({"date": "2026-08-19"}))

    assert result == "Briefing complet."
    assert captured["client"]["base_url"] == sirius_brain.GROQ_LLM_ENDPOINT
    assert captured["model"] == sirius_brain.GROQ_LLM_PRIMARY
    assert captured["messages"][0]["content"] == sirius_brain.BRIEFING_PROMPT
    for section in ("MÉTÉO", "MARCHÉS ET CRYPTO", "ACTUALITÉS", "CIEL", "VOTRE JOURNÉE", "SYNTHÈSE"):
        assert section in sirius_brain.BRIEFING_PROMPT
