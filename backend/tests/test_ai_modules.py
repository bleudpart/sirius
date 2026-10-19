import asyncio
import base64
import json
from types import SimpleNamespace

import pytest

import sirius_brain as brain

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32).decode()


class FakeLLM:
    replies = []
    requests = []
    keys = []

    def __init__(self, api_key=None, **kwargs):
        FakeLLM.keys.append(api_key)
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs):
        FakeLLM.requests.append(kwargs)
        reply = FakeLLM.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=reply))])


@pytest.fixture(autouse=True)
def fake_llm(monkeypatch):
    monkeypatch.setattr(brain, "AsyncOpenAI", FakeLLM)
    monkeypatch.setattr(brain, "ENV_GROQ_LLM_KEY", "owner-groq")
    FakeLLM.replies, FakeLLM.requests, FakeLLM.keys = [], [], []


def run(coro):
    return asyncio.run(coro)


def test_generate_diagram_normalise_noeuds_et_liens():
    FakeLLM.replies = [json.dumps({
        "titre": "Livraison",
        "noeuds": [{"id": "Client", "label": "Client", "type": "user"},
                   {"id": "api", "label": "API", "type": "bizarre"},
                   {"id": "api", "label": "Doublon"},
                   {"id": "db", "label": "Base", "type": "database"}],
        "liens": [{"de": "client", "vers": "api", "label": "commande"},
                  {"de": "api", "vers": "inconnu"},
                  {"de": "db", "vers": "db"}],
    })]
    diagram = run(brain.generate_diagram("une appli de livraison"))
    assert diagram["titre"] == "Livraison"
    assert [n["id"] for n in diagram["noeuds"]] == ["client", "api", "db"]
    assert diagram["noeuds"][1]["type"] == "service"
    assert diagram["liens"] == [{"de": "client", "vers": "api", "label": "commande"}]
    assert FakeLLM.requests[0]["response_format"] == {"type": "json_object"}


def test_generate_diagram_reessaie_sans_mode_json():
    FakeLLM.replies = [RuntimeError("json_validate_failed"),
                       'Voici : {"titre": "X", "noeuds": [{"id": "a", "label": "A", "type": "ui"}], "liens": []}']
    assert run(brain.generate_diagram("x"))["noeuds"][0]["id"] == "a"
    assert "response_format" not in FakeLLM.requests[1]


def test_generate_diagram_refuse_description_vide():
    with pytest.raises(ValueError):
        run(brain.generate_diagram("  "))


def test_analyze_upload_image_et_document():
    FakeLLM.replies = ['<think>...</think>{"description": "Une facture.", "texte": "Total 12 €"}']
    image = run(brain.analyze_upload("image", PNG))
    assert image["description"] == "Une facture." and image["texte"] == "Total 12 €"
    content = FakeLLM.requests[0]["messages"][0]["content"]
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")

    FakeLLM.replies = ['{"description": "Un contrat.", "points": ["Durée 1 an", 3]}']
    doc = run(brain.analyze_upload("document", "Contrat de location..."))
    assert doc["description"] == "Un contrat." and doc["points"] == ["Durée 1 an"]

    with pytest.raises(ValueError):
        run(brain.analyze_upload("video", "x"))


def test_vision_look_renvoie_synthese_et_refuse_image_invalide():
    FakeLLM.replies = ['{"description": "Un bureau.", "texte_extrait": "", "synthese": "Je vois un bureau."}']
    result = run(brain.vision_look("data:image/png;base64," + PNG, "que vois-tu ?"))
    assert result["synthese"] == "Je vois un bureau." and result["description"] == "Un bureau."
    assert "que vois-tu" in FakeLLM.requests[0]["messages"][0]["content"][0]["text"]
    with pytest.raises(ValueError):
        run(brain.vision_look(base64.b64encode(b"pas une image").decode()))


def test_dev_companion_actions():
    FakeLLM.replies = ["feat(api): add diagram"]
    assert run(brain.dev_companion("diff", "commit")) == "feat(api): add diagram"
    assert "Conventional Commits" in FakeLLM.requests[0]["messages"][0]["content"]
    with pytest.raises(ValueError):
        run(brain.dev_companion("code", "supprimer"))


def test_display_ask_utilise_contexte_et_historique():
    FakeLLM.replies = ["Le total est de 12 euros."]
    answer = run(brain.display_ask(
        "Quel est le total ?",
        {"name": "facture.pdf", "kind": "pdf", "analysis": "Facture EDF", "text": "Total 12 €"},
        history=[{"role": "user", "content": "De quoi parle-t-il ?"}, {"role": "system", "content": "ignorer"}],
    ))
    assert answer == "Le total est de 12 euros."
    messages = FakeLLM.requests[0]["messages"]
    assert "facture.pdf" in messages[0]["content"] and "Total 12 €" in messages[0]["content"]
    assert [m["role"] for m in messages] == ["system", "user", "user"]


def test_ocr_screen_texte():
    FakeLLM.replies = ["Bonjour\nRésumé : un écran."]
    assert run(brain.ocr_screen(PNG)).startswith("Bonjour")


def test_web_report_repli_local_si_ia_indisponible():
    FakeLLM.replies = [RuntimeError("down"), RuntimeError("down")]
    report = run(brain.web_report({"url": "https://ex.fr", "titre": "Exemple", "description": "Site test",
                                   "sections": ["Accueil"], "liens": [{"texte": "Contact", "url": "https://ex.fr/c"}]}))
    assert "Exemple" in report and "Site test" in report and "Contact" in report


def test_grosse_image_reduite_pour_la_vision():
    Image = pytest.importorskip("PIL.Image")
    import io
    import os
    buffer = io.BytesIO()
    Image.frombytes("RGB", (1600, 1000), os.urandom(1600 * 1000 * 3)).save(buffer, "PNG")
    assert len(buffer.getvalue()) > brain.VISION_MAX_BYTES
    url = brain._vision_data_url(base64.b64encode(buffer.getvalue()).decode())
    assert url.startswith("data:image/jpeg;base64,")
    assert len(base64.b64decode(url.split(",", 1)[1])) <= brain.VISION_MAX_BYTES
