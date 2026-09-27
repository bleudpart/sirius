from io import BytesIO
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

SOURCE = Path(__file__).resolve().parents[1] / "ACCORD-CONFIDENTIALITE-TESTEUR-SIRIUS.pdf"
OUTPUT = SOURCE.with_name("ACCORD-CONFIDENTIALITE-TESTEUR-SIRIUS-PARTEL.pdf")
PAGE_WIDTH = 594.95996
PAGE_HEIGHT = 841.91998


def draw_wrapped(c, text, x, y, max_width, font="Helvetica", size=7.5, leading=9):
    words = text.split()
    line = ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if stringWidth(candidate, font, size) <= max_width:
            line = candidate
        else:
            c.drawString(x, y, line)
            y -= leading
            line = word
    if line:
        c.drawString(x, y, line)
        y -= leading
    return y


def make_overlay(page_number):
    stream = BytesIO()
    c = canvas.Canvas(stream, pagesize=(PAGE_WIDTH, PAGE_HEIGHT))
    c.setFillColorRGB(0.08, 0.08, 0.08)
    c.setFont("Helvetica", 8)

    if page_number == 1:
        # Fill the existing editor fields without inventing a legal status or SIREN.
        c.drawString(130, PAGE_HEIGHT - 234, "319 boulevard de la Boissière")
        c.drawString(130, PAGE_HEIGHT - 245, "93110 Seine-Saint-Denis")
        c.drawString(130, PAGE_HEIGHT - 276, "danielpartel@hotmail.com")
        c.drawString(130, PAGE_HEIGHT - 287, "danielsirius.pro2026@gmail.com")
        c.drawString(130, PAGE_HEIGHT - 298, "Tél. : 06 60 66 74 36")

    c.setStrokeColorRGB(0.65, 0.65, 0.65)
    c.setLineWidth(0.35)
    c.line(34, 39, PAGE_WIDTH - 34, 39)
    c.setFillColorRGB(0.25, 0.25, 0.25)
    c.setFont("Helvetica", 6.8)
    c.drawString(34, 27, "© 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.")
    c.drawRightString(PAGE_WIDTH - 34, 27, f"Page {page_number}")
    c.setFont("Helvetica", 6.5)
    draw_wrapped(
        c,
        "Contact : danielpartel@hotmail.com | danielsirius.pro2026@gmail.com | 06 60 66 74 36 | Store : sirius-assistant.fr",
        34,
        15,
        PAGE_WIDTH - 68,
        size=6.5,
        leading=7,
    )
    c.save()
    stream.seek(0)
    return PdfReader(stream).pages[0]


def main():
    reader = PdfReader(str(SOURCE))
    writer = PdfWriter()
    for number, page in enumerate(reader.pages, start=1):
        page.merge_page(make_overlay(number))
        writer.add_page(page)
    with OUTPUT.open("wb") as output:
        writer.write(output)
    print(OUTPUT)


if __name__ == "__main__":
    main()
