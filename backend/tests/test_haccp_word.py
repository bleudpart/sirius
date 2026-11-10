import base64
import uuid
from io import BytesIO

import pytest
from docx import Document
from PIL import Image, ImageDraw

from services.haccp_signature import decode_signature
from services.haccp_word import fill_haccp_template, print_haccp_document


def signature(blank=False):
    image = Image.new("RGBA", (80, 40), (255, 255, 255, 0))
    if not blank:
        ImageDraw.Draw(image).line((5, 30, 30, 10, 70, 25), fill="black", width=2)
    stream = BytesIO()
    image.save(stream, format="PNG")
    return "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode("ascii")


def record(**changes):
    return {
        "titre": "Contrôle des températures",
        "etablissement": "Le Papillon",
        "created_at": "2026-11-10T12:15:00+00:00",
        "operateur": "Camille",
        "colonnes": ["Équipement", "Température", "Observation"],
        "lignes": [["Chambre froide", "3,2 °C", ""]],
        "signature_image": signature(),
        **changes,
    }


def test_word_template_is_filled_and_signature_is_embedded(tmp_path):
    calls = []
    job = uuid.uuid4()
    output = print_haccp_document(
        record(), job, export_directory=tmp_path,
        startfile=lambda path, operation: calls.append((path, operation)),
    )
    assert output.name == f"releve_haccp_{job}.docx"
    assert calls == [(str(output), "print")]
    document = Document(output)
    text = "\n".join(paragraph.text for paragraph in document.paragraphs)
    assert "Contrôle des températures" in text
    assert "Le Papillon" in text and "Camille" in text
    assert "10/11/2026 à 13:15" in text
    assert "{{" not in text
    assert [[cell.text for cell in row.cells] for row in document.tables[0].rows] == [
        ["Équipement", "Chambre froide"], ["Température", "3,2 °C"],
    ]
    assert len(document.inline_shapes) == 1


def test_same_job_never_overwrites_or_prints_twice(tmp_path):
    calls = []
    job = uuid.uuid4()
    send = lambda path, operation: calls.append((path, operation))
    output = print_haccp_document(record(), job, export_directory=tmp_path, startfile=send)
    original = output.read_bytes()
    with pytest.raises(FileExistsError, match="Aucune impression automatique supplémentaire"):
        print_haccp_document(record(), job, export_directory=tmp_path, startfile=send)
    assert output.read_bytes() == original
    assert len(calls) == 1


def test_failed_print_keeps_the_document_and_surfaces_the_error(tmp_path):
    job = uuid.uuid4()

    def fail(_path, _operation):
        raise OSError("Aucune application Word associée")

    with pytest.raises(OSError, match="Document enregistré.*commande d'impression a échoué"):
        print_haccp_document(record(), job, export_directory=tmp_path, startfile=fail)
    assert (tmp_path / f"releve_haccp_{job}.docx").is_file()


@pytest.mark.parametrize("value", ["", "data:image/png;base64,%%%", signature(blank=True)])
def test_invalid_or_blank_signatures_are_rejected(value):
    with pytest.raises(ValueError):
        decode_signature(value)


def test_bad_template_and_mismatched_columns_are_rejected(tmp_path):
    template = tmp_path / "incomplete.docx"
    Document().save(template)
    with pytest.raises(ValueError, match="repères attendus"):
        fill_haccp_template(record(), template)
    with pytest.raises(ValueError, match="intitulés"):
        fill_haccp_template(record(lignes=[["Chambre froide"]]))
