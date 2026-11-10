"""Recrée le modèle Word vierge utilisé pour les relevés HACCP."""

from pathlib import Path

from docx import Document
from docx.shared import Cm, Pt


def build_template(destination: Path) -> None:
    document = Document()
    section = document.sections[0]
    section.top_margin = Cm(1.7)
    section.bottom_margin = Cm(1.7)
    section.left_margin = Cm(1.8)
    section.right_margin = Cm(1.8)
    document.styles["Normal"].font.name = "Calibri"
    document.styles["Normal"].font.size = Pt(11)

    document.add_heading("{{TITRE}}", level=0)
    document.add_paragraph("Établissement : {{ETABLISSEMENT}}")
    document.add_paragraph("Enregistré le : {{ENREGISTRE_LE}}")
    document.add_paragraph("Opérateur : {{OPERATEUR}}")
    document.add_paragraph("{{DONNEES}}")
    document.add_paragraph("Signature manuscrite (non certifiée) :")
    document.add_paragraph("{{SIGNATURE}}")
    section.footer.paragraphs[0].text = "ΣIRIUS — Relevé HACCP"
    document.save(destination)


if __name__ == "__main__":
    build_template(Path(__file__).with_name("template_haccp.docx"))
