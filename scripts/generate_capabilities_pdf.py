from pathlib import Path
import re
import argparse

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import ListFlowable, ListItem, PageBreak, Paragraph, SimpleDocTemplate, Spacer

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "GUIDE-CAPACITES-SIRIUS.md"
OUTPUT = ROOT / "GUIDE-CAPACITES-SIRIUS.pdf"

for name, path in (("Arial", r"C:\Windows\Fonts\arial.ttf"), ("Arial-Bold", r"C:\Windows\Fonts\arialbd.ttf")):
    if Path(path).exists():
        pdfmetrics.registerFont(TTFont(name, path))
FONT = "Arial" if "Arial" in pdfmetrics.getRegisteredFontNames() else "Helvetica"
BOLD = "Arial-Bold" if "Arial-Bold" in pdfmetrics.getRegisteredFontNames() else "Helvetica-Bold"

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="CoverTitle", parent=styles["Title"], fontName=BOLD, fontSize=27, leading=32, alignment=TA_CENTER, textColor=colors.HexColor("#c8a96b"), spaceAfter=12))
styles.add(ParagraphStyle(name="CoverSub", parent=styles["Normal"], fontName=FONT, fontSize=12, leading=18, alignment=TA_CENTER, textColor=colors.HexColor("#40566a"), spaceAfter=8))
styles.add(ParagraphStyle(name="H1Custom", parent=styles["Heading1"], fontName=BOLD, fontSize=17, leading=21, textColor=colors.HexColor("#12344d"), spaceBefore=18, spaceAfter=9, keepWithNext=True))
styles.add(ParagraphStyle(name="H2Custom", parent=styles["Heading2"], fontName=BOLD, fontSize=12.5, leading=16, textColor=colors.HexColor("#856526"), spaceBefore=12, spaceAfter=6, keepWithNext=True))
styles.add(ParagraphStyle(name="BodyCustom", parent=styles["BodyText"], fontName=FONT, fontSize=9.2, leading=13, textColor=colors.HexColor("#263746"), spaceAfter=5))
styles.add(ParagraphStyle(name="BulletCustom", parent=styles["BodyText"], fontName=FONT, fontSize=9, leading=12.5, leftIndent=14, firstLineIndent=-7, bulletIndent=2, textColor=colors.HexColor("#263746"), spaceAfter=2))
styles.add(ParagraphStyle(name="Meta", parent=styles["Normal"], fontName=FONT, fontSize=9, leading=14, alignment=TA_CENTER, textColor=colors.HexColor("#64798a")))


def escape(text):
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"`(.+?)`", r"<font name='Courier'>\1</font>", text)
    return text


def footer(canvas, document):
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(colors.HexColor("#d8c49a"))
    canvas.setLineWidth(0.4)
    canvas.line(18 * mm, 14 * mm, width - 18 * mm, 14 * mm)
    canvas.setFont(FONT, 7)
    canvas.setFillColor(colors.HexColor("#657784"))
    canvas.drawString(18 * mm, 9 * mm, "© 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.")
    canvas.drawRightString(width - 18 * mm, 9 * mm, f"Page {document.page}")
    canvas.restoreState()


def build(source=SOURCE, output=OUTPUT, language="fr"):
    english = language == "en"
    subtitle = "Complete capability inventory" if english else "Inventaire complet des capacités"
    version = "Reference version: 1.0.24" if english else "Version de référence : 1.0.24"
    descriptor = "Personal assistant, Enterprise platform and business modules" if english else "Assistant personnel, plateforme Entreprise et modules métier"
    intro = "This document describes available functions, configurable integrations and limitations to know before professional use." if english else "Ce document décrit les fonctions disponibles, les intégrations configurables et les limites à connaître avant un usage professionnel."
    story = [Spacer(1, 30 * mm), Paragraph("ΣIRIUS Assistant", styles["CoverTitle"]), Paragraph(subtitle, styles["CoverSub"]), Spacer(1, 8 * mm), Paragraph(version, styles["Meta"]), Paragraph(descriptor, styles["Meta"]), Spacer(1, 12 * mm), Paragraph(intro, styles["BodyCustom"]), PageBreak()]
    lines = source.read_text(encoding="utf-8").splitlines()
    bullets = []

    def flush():
        nonlocal bullets
        if bullets:
            story.append(ListFlowable([ListItem(Paragraph(escape(item), styles["BulletCustom"]), bulletColor=colors.HexColor("#c8a96b")) for item in bullets], bulletType="bullet", start="circle", leftIndent=14))
            story.append(Spacer(1, 3))
            bullets = []

    for line in lines:
        raw = line.strip()
        if not raw or raw.startswith("**Version") or raw.startswith("**Éditeur") or raw.startswith("**Site"):
            continue
        if raw.startswith("# "):
            continue
        if raw.startswith("## "):
            flush()
            story.append(Paragraph(escape(raw[3:]), styles["H1Custom"]))
        elif raw.startswith("### "):
            flush()
            story.append(Paragraph(escape(raw[4:]), styles["H2Custom"]))
        elif raw.startswith("- "):
            bullets.append(raw[2:])
        elif raw.startswith("**Statut"):
            flush()
            story.append(Paragraph(escape(raw), styles["BodyCustom"]))
        else:
            flush()
            story.append(Paragraph(escape(raw), styles["BodyCustom"]))
    flush()

    doc = SimpleDocTemplate(str(output), pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm, topMargin=18 * mm, bottomMargin=20 * mm, title="ΣIRIUS Assistant - Capabilities", author="Daniel Partel")
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--language", choices=("fr", "en"), default="fr")
    args = parser.parse_args()
    build(args.source, args.output, args.language)
