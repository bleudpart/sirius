import asyncio
import base64

import pytest
from fastapi import HTTPException

from google import genai
import server


def test_task_image_rejects_unsupported_reference_type():
    request = server.TaskImageRequest(
        prompt="Transforme cette image",
        reference_image=base64.b64encode(b"image").decode(),
        reference_mime="image/gif",
    )

    with pytest.raises(HTTPException) as raised:
        asyncio.run(server.task_image(request))

    assert raised.value.status_code == 400


def test_task_image_rejects_invalid_reference_data():
    request = server.TaskImageRequest(
        prompt="Transforme cette image",
        reference_image="pas-du-base64",
        reference_mime="image/png",
    )

    with pytest.raises(HTTPException) as raised:
        asyncio.run(server.task_image(request))

    assert raised.value.status_code == 400


def test_task_image_sends_reference_to_gemini(monkeypatch):
    captured = {}

    class FakeOutputImage:
        data = "generated"
        mime_type = "image/png"

    class FakeInteraction:
        output_image = FakeOutputImage()
        output_text = "Rendu terminé"

    class FakeInteractions:
        async def create(self, **kwargs):
            captured["kwargs"] = kwargs
            return FakeInteraction()

    class FakeAio:
        interactions = FakeInteractions()

    class FakeClient:
        def __init__(self, **_kwargs):
            self.aio = FakeAio()

    monkeypatch.setenv("GEMINI_API_KEY", "configured-for-test")
    monkeypatch.setattr(genai, "Client", FakeClient)
    encoded = base64.b64encode(b"\x89PNG\r\n\x1a\nreference-image").decode()
    request = server.TaskImageRequest(
        prompt="Conserve Zeus et agrandis le décor",
        reference_image=encoded,
        reference_mime="image/png",
    )

    result = asyncio.run(server.task_image(request))

    assert result["image"] == "generated"
    assert result["mime"] == "image/png"
    kwargs = captured["kwargs"]
    assert kwargs["model"] == "gemini-3.1-flash-image"
    input_parts = kwargs["input"]
    assert input_parts[0] == {"type": "text", "text": request.prompt}
    assert input_parts[1] == {"type": "image", "mime_type": "image/png", "data": encoded}
