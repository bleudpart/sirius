"""Printable paper templates, explicitly drafts rather than issued invoices."""
from decimal import Decimal
from io import BytesIO
from textwrap import wrap
from xml.sax.saxutils import escape

from PIL import Image, ImageChops
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from email_signature import EMAIL_LOGO, signature_image, signature_lines


def build_scan_pdf(record: dict, *, signature_name: str | None = None, signature_email: str | None = None) -> bytes:
    scan = record["scan"]
    accounting = scan.get("accounting") or {}
    presentation = scan.get("presentation") or {}
    sale = scan["kind"] == "sale"
    classic = presentation.get("template") == "classique"
    accent = colors.HexColor("#222222" if classic else "#946c27")
    band = colors.HexColor("#eeeeee" if classic else "#eaf0f5")
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="ScanBody", fontName="Helvetica", fontSize=10, leading=15, spaceAfter=6))
    styles.add(ParagraphStyle(name="ScanTitle", fontName="Helvetica-Bold", fontSize=22, leading=28, textColor=accent))
    styles.add(ParagraphStyle(name="ScanSmall", fontName="Helvetica", fontSize=8, leading=12))
    styles.add(ParagraphStyle(name="ScanRight", parent=styles["ScanBody"], alignment=TA_RIGHT))
    styles.add(ParagraphStyle(name="ScanSignature", fontName="Helvetica", fontSize=7.5, leading=10))
    width = A4[0] - 80
    signature_line, _, copyright_line, email = signature_lines(signature_name, signature_email)
    signature = Paragraph(
        f'<font color="#a67b2e"><b>{escape(signature_line.replace("Message envoyé", "Document préparé", 1))}</b></font>'
        f'<br/>{escape(email)}<br/><font color="#5b6670">{escape(copyright_line)}</font>',
        styles["ScanSignature"],
    )
    logo_data = signature_image(EMAIL_LOGO)
    if logo_data is None:
        raise FileNotFoundError("L'icône de signature ΣIRIUS est introuvable.")
    with Image.open(BytesIO(logo_data)) as source:
        logo = source.convert("RGB")
        bounds = ImageChops.difference(logo, Image.new("RGB", logo.size, "white")).getbbox()
        if bounds is None:
            raise ValueError("L'icône de signature ΣIRIUS est vide.")
        logo_reader = ImageReader(logo.crop(bounds))

    def paragraph(text, style="ScanBody"):
        return Paragraph(escape(str(text)).replace("\n", "<br/>"), styles[style])

    def money(value):
        if value is None:
            return "Non identifié"
        return f"{Decimal(str(value)):.2f}".replace(".", ",") + " " + accounting.get("currency", "EUR")

    buffer = BytesIO()
    document = SimpleDocTemplate(buffer, pagesize=A4, rightMargin=40, leftMargin=40,
                                 topMargin=40, bottomMargin=140, title="Brouillon de facture" if sale else "Fiche de dépense")
    story = [
        paragraph("FACTURE CLIENT" if sale else "FICHE DE DÉPENSE", "ScanTitle"),
        paragraph("BROUILLON — NON ÉMIS" if sale else "JUSTIFICATIF D'ACHAT — PAS UNE FACTURE FOURNISSEUR", "ScanSmall"),
        Spacer(1, 20),
    ]
    parties = [
        [paragraph("VENDEUR" if sale else "FOURNISSEUR"), paragraph("CLIENT" if sale else "DOSSIER")],
        [paragraph(presentation.get("seller") or accounting.get("supplier") or "Coordonnées à compléter"),
         paragraph((presentation.get("customer") or "Coordonnées à compléter") if sale else record["dossier"])],
    ]
    parties_table = Table(parties, colWidths=[width / 2, width / 2], hAlign="LEFT")
    parties_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), band), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10), ("TOPPADDING", (0, 0), (-1, -1), 10),
    ]))
    story += [parties_table, Spacer(1, 18),
              paragraph(f"Date du ticket : {accounting.get('date') or 'À vérifier'}"),
              paragraph(f"Référence d'origine : {accounting.get('ticket_number') or 'À vérifier'}"),
              paragraph(f"Identifiants fiscaux reproduits :\n{accounting.get('fiscal_identifiers') or 'À compléter depuis le justificatif'}"),
              paragraph(f"Pièce source : {record['original_filename']} · Référence du justificatif : {record['id']}", "ScanSmall"),
              Spacer(1, 12)]
    description = presentation.get("description") or scan.get("text") or "Articles à compléter à partir du ticket joint."
    table_rows = [[paragraph("DÉSIGNATION / ARTICLES À RELIRE")]]
    table_rows += [[paragraph(part)] for line in description.splitlines() if line.strip()
                   for part in wrap(line, width=100)]
    articles = Table(table_rows, colWidths=[width], repeatRows=1, hAlign="LEFT")
    articles.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), band), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, 0), 1, accent),
        ("LINEBELOW", (0, 1), (-1, -1), .4, colors.HexColor("#dddddd")),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story += [articles, Spacer(1, 18)]
    totals = Table([
        [paragraph("Total TTC relu"), paragraph(money(accounting.get("total_ttc")), "ScanRight")],
        [paragraph("Montant TVA relu"), paragraph(money(accounting.get("tva")), "ScanRight")],
    ], colWidths=[width * .6, width * .4])
    totals.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), band), ("TOPPADDING", (0, 0), (-1, -1), 10)]))
    story += [totals, Spacer(1, 18)]
    if scan.get("draft"):
        story += [paragraph("NOTES / BROUILLON RELU"), paragraph(scan["draft"]), Spacer(1, 12)]
    warning = (
        "Document de travail non émis : compléter les mentions obligatoires, vérifier les articles et taux de TVA, "
        "attribuer le numéro dans le registre de facturation et contrôler les doublons avant émission."
        if sale else
        "Cette fiche accompagne le ticket original. Elle ne remplace pas une facture du fournisseur "
        "et n'atteste pas le droit à déduction de TVA."
    )
    story.append(paragraph(warning, "ScanSmall"))

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(accent)
        canvas.line(40, 125, A4[0] - 40, 125)
        canvas.drawImage(logo_reader, 40, 53, width=46, height=46, preserveAspectRatio=True, mask="auto")
        _, signature_height = signature.wrap(width - 60, 90)
        signature.drawOn(canvas, 100, 118 - signature_height)
        canvas.setFillColor(colors.HexColor("#5b6670"))
        canvas.setFont("Helvetica", 8)
        canvas.drawString(40, 26, "Brouillon non émis" if sale else "Justificatif comptable à contrôler")
        canvas.drawRightString(A4[0] - 40, 26, f"Page {doc.page}")
        canvas.restoreState()

    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()
