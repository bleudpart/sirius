"""Création et lancement d'impression d'un relevé Word sur le PC Windows."""

import os
import uuid
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

from docx import Document
from docx.shared import Cm

from runtime_paths import project_dir
from services.haccp_signature import decode_signature


EXPORT_DIRECTORY = Path(r"C:\Sirius\exports")
PARIS = ZoneInfo("Europe/Paris")


def template_path() -> Path:
    return project_dir() / "backend" / "templates" / "template_haccp.docx"


def _record_time(value: str) -> str:
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError("La date d'enregistrement du relevé est invalide.") from error
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(PARIS).strftime("%d/%m/%Y à %H:%M")


def _required_text(record: dict, key: str) -> str:
    value = record.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Le champ {key} du relevé est requis.")
    return value


def _add_tables(document, marker, columns: list[str], rows: list[list[str]]) -> None:
    if not columns or not rows or any(len(row) != len(columns) for row in rows):
        raise ValueError("Les données du relevé ne correspondent pas aux intitulés.")
    anchor = marker._p
    for row in rows:
        table = document.add_table(rows=0, cols=2)
        table.style = "Table Grid"
        for column, value in zip(columns, row):
            if not isinstance(column, str) or not isinstance(value, str):
                raise ValueError("Les champs du relevé doivent être du texte.")
            if not value.strip():
                continue
            cells = table.add_row().cells
            cells[0].text = column
            cells[1].text = value
        if not table.rows:
            raise ValueError("Le relevé ne contient aucune donnée.")
        anchor.addnext(table._tbl)
        anchor = table._tbl
    marker._element.getparent().remove(marker._element)


def fill_haccp_template(record: dict, template: Path | None = None):
    source = template if template is not None else template_path()
    document = Document(source)
    replacements = {
        "{{TITRE}}": _required_text(record, "titre"),
        "{{ETABLISSEMENT}}": _required_text(record, "etablissement"),
        "{{ENREGISTRE_LE}}": _record_time(_required_text(record, "created_at")),
        "{{OPERATEUR}}": _required_text(record, "operateur"),
    }
    columns = record.get("colonnes")
    rows = record.get("lignes")
    if not isinstance(columns, list) or not isinstance(rows, list) or any(not isinstance(row, list) for row in rows):
        raise ValueError("Le tableau du relevé est invalide.")
    signature = decode_signature(_required_text(record, "signature_image"))
    markers = {key: [] for key in (*replacements, "{{DONNEES}}", "{{SIGNATURE}}")}
    for paragraph in document.paragraphs:
        for key in markers:
            if key in paragraph.text:
                markers[key].append(paragraph)
    if any(len(paragraphs) != 1 for paragraphs in markers.values()):
        raise ValueError("Le modèle Word HACCP ne contient pas tous les repères attendus.")
    for key, value in replacements.items():
        paragraph = markers[key][0]
        paragraph.text = paragraph.text.replace(key, value)
    data_paragraph = markers["{{DONNEES}}"][0]
    signature_paragraph = markers["{{SIGNATURE}}"][0]
    if data_paragraph.text.strip() != "{{DONNEES}}" or signature_paragraph.text.strip() != "{{SIGNATURE}}":
        raise ValueError("Les repères de données et de signature doivent être seuls dans leur paragraphe.")
    _add_tables(document, data_paragraph, columns, rows)
    signature_paragraph.text = ""
    signature_paragraph.add_run().add_picture(BytesIO(signature), width=Cm(4))
    return document


def print_haccp_document(
    record: dict,
    job_id: uuid.UUID,
    *,
    export_directory: Path = EXPORT_DIRECTORY,
    template: Path | None = None,
    startfile: Callable[[str, str], None] | None = None,
) -> Path:
    if startfile is None:
        if os.name != "nt":
            raise OSError("L'impression Word est disponible uniquement sur le PC Windows.")
        startfile = os.startfile
    document = fill_haccp_template(record, template)
    export_directory.mkdir(parents=True, exist_ok=True)
    output = export_directory / f"releve_haccp_{job_id}.docx"
    try:
        stream = output.open("xb")
    except FileExistsError as error:
        raise FileExistsError(
            f"Ce travail possède déjà un document : {output}. Aucune impression automatique supplémentaire."
        ) from error
    written = False
    try:
        with stream:
            document.save(stream)
            stream.flush()
            os.fsync(stream.fileno())
        written = True
    finally:
        if not written:
            output.unlink(missing_ok=True)
    try:
        startfile(str(output), "print")
    except OSError as error:
        raise OSError(
            f"Document enregistré dans {output}, mais la commande d'impression a échoué. Vérifiez le PC avant de réessayer."
        ) from error
    return output
