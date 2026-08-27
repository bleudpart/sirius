# © 2026 Daniel Partel – SIRIUS Assistant. THÉMIS# : génération PDF + extraction IA de pièces comptables.
import base64
import io
import json
import re

import pymupdf as fitz

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas as pdfcanvas

from sirius_brain import ENV_K3_KEY, K3_MODEL, k3_client

VISION_MODEL = None  # kimi-k3 gère texte + vision

TEMPLATE_STYLES = {
    "antique": {"accent": "#b8860b", "band": "#1a1206", "label": "ANTIQUE OR"},
    "moderne": {"accent": "#0e7490", "band": "#06222b", "label": "MODERNE CYAN"},
    "minimal": {"accent": "#8a6d1f", "band": "#111111", "label": "MINIMAL NOIR & OR"},
}

EXTRACT_PROMPT = (
    "Tu es un assistant comptable. Extrais les informations de cette facture ou pièce comptable. "
    "Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour :\n"
    '{"fournisseur": "nom de l\'émetteur de la facture", "numero": "numéro de la facture", '
    '"date": "date de la facture au format AAAA-MM-JJ", "total_ht": montant hors taxes en nombre, '
    '"tva": montant de la TVA en nombre, "total_ttc": montant toutes taxes comprises en nombre}\n'
    "Si une valeur est introuvable, mets \"\" pour les textes et 0 pour les nombres. "
    "Les nombres utilisent le point décimal, sans symbole monétaire."
)


def _eur(n):
    return f"{float(n or 0):,.2f} €".replace(",", " ").replace(".", ",")


def build_doc_pdf(doc, emetteur=""):
    """Génère un devis/facture PDF professionnel (A4) selon le modèle choisi."""
    style = TEMPLATE_STYLES.get(doc.get("template", "antique"), TEMPLATE_STYLES["antique"])
    accent, band = HexColor(style["accent"]), HexColor(style["band"])
    dark = HexColor("#222222")
    grey = HexColor("#666666")
    buf = io.BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=A4)
    w, h = A4

    kind = "FACTURE" if doc.get("kind") == "facture" else "DEVIS"
    c.setFillColor(band)
    c.rect(0, h - 96, w, 96, stroke=0, fill=1)
    c.setFillColor(accent)
    c.rect(0, h - 100, w, 4, stroke=0, fill=1)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(40, h - 52, emetteur or "SIRIUS ENTERPRISE")
    c.setFillColor(accent)
    c.setFont("Helvetica-Bold", 16)
    c.drawRightString(w - 40, h - 44, f"{kind} {doc.get('number', '')}")
    c.setFillColor(white)
    c.setFont("Helvetica", 9)
    c.drawRightString(w - 40, h - 62, f"Émise le {str(doc.get('created_at', ''))[:10]}")
    if doc.get("due_date"):
        c.drawRightString(w - 40, h - 76, f"Échéance : {doc['due_date']}")
    c.setFont("Helvetica-Oblique", 8)
    c.drawString(40, h - 76, f"Modèle {style['label']} — généré par SIRIUS · THÉMIS")

    y = h - 140
    c.setFillColor(accent)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(40, y, "ADRESSÉ À")
    c.setFillColor(dark)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(40, y - 18, doc.get("client_name") or "Client")
    if doc.get("notes"):
        c.setFont("Helvetica", 9)
        c.setFillColor(grey)
        c.drawString(40, y - 34, str(doc["notes"])[:110])

    y -= 70
    c.setFillColor(accent)
    c.rect(40, y - 6, w - 80, 22, stroke=0, fill=1)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(48, y, "DÉSIGNATION")
    c.drawRightString(w - 220, y, "QTÉ")
    c.drawRightString(w - 140, y, "P.U. HT")
    c.drawRightString(w - 48, y, "TOTAL HT")
    y -= 26
    c.setFont("Helvetica", 10)
    for line in (doc.get("lines") or [])[:28]:
        qty = float(line.get("qty", 1) or 0)
        pu = float(line.get("unit_price", 0) or 0)
        c.setFillColor(dark)
        c.drawString(48, y, str(line.get("label", ""))[:64] or "—")
        c.drawRightString(w - 220, y, f"{qty:g}")
        c.drawRightString(w - 140, y, _eur(pu))
        c.drawRightString(w - 48, y, _eur(qty * pu))
        c.setStrokeColor(HexColor("#dddddd"))
        c.setLineWidth(0.5)
        c.line(40, y - 7, w - 40, y - 7)
        y -= 22
        if y < 180:
            break

    y -= 14
    box_x = w - 250
    c.setFillColor(dark)
    c.setFont("Helvetica", 10)
    c.drawString(box_x, y, "Total HT")
    c.drawRightString(w - 48, y, _eur(doc.get("total_ht")))
    y -= 18
    c.drawString(box_x, y, f"TVA ({float(doc.get('tva', 20) or 0):g} %)")
    c.drawRightString(w - 48, y, _eur(doc.get("tva_amount")))
    y -= 8
    c.setStrokeColor(accent)
    c.setLineWidth(1.2)
    c.line(box_x, y, w - 40, y)
    y -= 20
    c.setFillColor(accent)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(box_x, y, "TOTAL TTC")
    c.drawRightString(w - 48, y, _eur(doc.get("total_ttc")))
    if doc.get("kind") == "facture" and float(doc.get("paid", 0) or 0) > 0:
        y -= 20
        c.setFillColor(grey)
        c.setFont("Helvetica", 10)
        c.drawString(box_x, y, "Déjà réglé")
        c.drawRightString(w - 48, y, _eur(doc.get("paid")))
        y -= 16
        c.setFillColor(dark)
        c.setFont("Helvetica-Bold", 10)
        c.drawString(box_x, y, "Reste à payer")
        c.drawRightString(w - 48, y, _eur(float(doc.get("total_ttc", 0)) - float(doc.get("paid", 0))))

    c.setFillColor(accent)
    c.rect(0, 40, w, 3, stroke=0, fill=1)
    c.setFillColor(grey)
    c.setFont("Helvetica", 8)
    c.drawCentredString(w / 2, 26, f"{kind} {doc.get('number', '')} — statut : {doc.get('status', '')} — document généré par SIRIUS · module THÉMIS")
    c.showPage()
    c.save()
    return buf.getvalue()


def _parse_extraction(raw):
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
    except Exception:
        return {}
    out = {
        "fournisseur": str(data.get("fournisseur") or "").strip()[:120],
        "numero": str(data.get("numero") or "").strip()[:60],
        "date": str(data.get("date") or "").strip()[:10],
    }
    for k in ("total_ht", "tva", "total_ttc"):
        try:
            out[k] = round(float(data.get(k) or 0), 2)
        except (TypeError, ValueError):
            out[k] = 0.0
    return out


async def extract_piece(filename, data, k3_key=None):
    """Lit une pièce comptable (PDF texte, PDF scanné ou image) et en extrait les données via Kimi K3."""
    key = k3_key or ENV_K3_KEY
    if not key:
        raise ValueError("Clé Kimi K3 requise pour la lecture automatique des factures.")
    ext = (filename or "").rsplit(".", 1)[-1].lower()
    text, image_b64 = "", None
    if ext == "pdf":
        pdf = fitz.open(stream=data, filetype="pdf")
        text = "\n".join(page.get_text() for page in list(pdf)[:3]).strip()
        if len(text) < 60:
            pix = pdf[0].get_pixmap(dpi=150)
            image_b64 = base64.b64encode(pix.tobytes("png")).decode()
        pdf.close()
    else:
        image_b64 = base64.b64encode(data).decode()

    client = k3_client(key)
    if image_b64:
        resp = await client.chat.completions.create(
            model=K3_MODEL,
            messages=[{"role": "user", "content": [
                {"type": "text", "text": EXTRACT_PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
            ]}],
            max_tokens=500,
        )
        method = "ocr"
    else:
        resp = await client.chat.completions.create(
            model=K3_MODEL,
            messages=[
                {"role": "system", "content": EXTRACT_PROMPT},
                {"role": "user", "content": f"PIÈCE COMPTABLE :\n{text[:9000]}"},
            ],
            max_tokens=500,
            response_format={"type": "json_object"},
        )
        method = "texte"
    raw = re.sub(r"<think>.*?</think>", "", resp.choices[0].message.content, flags=re.S).strip()
    out = _parse_extraction(raw)
    if not out:
        raise ValueError("Le modèle n'a pas renvoyé de données exploitables.")
    if not out.get("total_ttc") and out.get("total_ht"):
        out["total_ttc"] = round(out["total_ht"] + out.get("tva", 0), 2)
    out["method"] = method
    return out


def build_consult_pdf(module, question, reponse, date_str=""):
    """PDF élégant « antique or » pour un avis de Solon ou un plan de Prométhée."""
    import textwrap
    conf = {
        "SOLON#": ("SOLON", "AVIS JURIDIQUE", "Législateur d'Athènes — droit français"),
        "PROMÉTHÉE#": ("PROMÉTHÉE", "PLAN DE PROJET", "Titan de la prévoyance — gestion de projet"),
    }
    name, kind, sub = conf.get(module, ("PANTHÉON", "CONSULTATION", "SIRIUS"))
    gold, band, dark, grey = HexColor("#b8860b"), HexColor("#1a1206"), HexColor("#222222"), HexColor("#666666")
    buf = io.BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=A4)
    w, h = A4

    def header(page):
        c.setFillColor(band)
        c.rect(0, h - 92, w, 92, stroke=0, fill=1)
        c.setFillColor(gold)
        c.rect(0, h - 96, w, 4, stroke=0, fill=1)
        c.setFillColor(white)
        c.setFont("Helvetica-Bold", 20)
        c.drawString(40, h - 46, f"{name} — {kind}")
        c.setFillColor(gold)
        c.setFont("Helvetica-Oblique", 9)
        c.drawString(40, h - 64, sub)
        c.setFillColor(white)
        c.setFont("Helvetica", 9)
        if date_str:
            c.drawRightString(w - 40, h - 46, f"Consultation du {date_str}")
        c.drawRightString(w - 40, h - 62, "SIRIUS · PANTHÉON")
        c.setFont("Helvetica-Oblique", 8)
        c.setFillColor(grey)
        c.drawRightString(w - 40, 28, f"Page {page}")
        c.setFillColor(gold)
        c.setLineWidth(0.8)
        c.setStrokeColor(gold)
        c.line(40, 40, w - 40, 40)

    # Nettoyage markdown léger
    clean = re.sub(r"[*_`#]+", "", reponse or "").strip()
    q_lines = textwrap.wrap((question or "").strip(), 96) or ["—"]

    page = 1
    header(page)
    y = h - 128
    c.setFillColor(gold)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(40, y, "OBJET DE LA CONSULTATION")
    y -= 16
    c.setFillColor(dark)
    c.setFont("Helvetica-Oblique", 10)
    for ln in q_lines[:6]:
        c.drawString(40, y, ln)
        y -= 14
    y -= 8
    c.setStrokeColor(gold)
    c.setLineWidth(0.8)
    c.line(40, y, w - 40, y)
    y -= 24
    c.setFillColor(gold)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(40, y, kind)
    y -= 18

    c.setFont("Helvetica", 10)
    for para in clean.split("\n"):
        wrapped = textwrap.wrap(para, 100) or [""]
        for ln in wrapped:
            if y < 60:
                c.showPage()
                page += 1
                header(page)
                y = h - 128
                c.setFont("Helvetica", 10)
            c.setFillColor(dark)
            c.drawString(40, y, ln)
            y -= 14
        y -= 4

    c.save()
    buf.seek(0)
    return buf


def build_receipt_pdf(tx):
    """Reçu de paiement élégant au style Thémis (bandeau sombre, or)."""
    gold, band, dark, grey = HexColor("#b8860b"), HexColor("#1a1206"), HexColor("#222222"), HexColor("#666666")
    buf = io.BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=A4)
    w, h = A4
    c.setFillColor(band)
    c.rect(0, h - 100, w, 100, stroke=0, fill=1)
    c.setFillColor(gold)
    c.rect(0, h - 104, w, 4, stroke=0, fill=1)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(40, h - 52, "REÇU DE PAIEMENT")
    c.setFillColor(gold)
    c.setFont("Helvetica-Oblique", 9)
    c.drawString(40, h - 72, "HERMÈS AGORA — SIRIUS · PANTHÉON")
    c.setFillColor(white)
    c.setFont("Helvetica", 9)
    date_pay = (tx.get("updated_at") or "")[:10]
    c.drawRightString(w - 40, h - 52, f"Date : {date_pay}")
    c.drawRightString(w - 40, h - 68, f"Réf. : {tx.get('session_id', '')[-12:]}")

    y = h - 160
    c.setFillColor(gold)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(40, y, "REÇU DE")
    y -= 16
    c.setFillColor(dark)
    c.setFont("Helvetica", 11)
    nom = tx.get("deal_nom", "")
    if tx.get("deal_entreprise"):
        nom += f" — {tx['deal_entreprise']}"
    c.drawString(40, y, nom or "Client")
    if tx.get("deal_email"):
        y -= 14
        c.setFont("Helvetica-Oblique", 9)
        c.setFillColor(grey)
        c.drawString(40, y, tx["deal_email"])

    y -= 36
    c.setStrokeColor(gold)
    c.setLineWidth(0.8)
    c.line(40, y, w - 40, y)
    y -= 30
    pct = tx.get("percent", 100)
    libelle = f"Acompte {pct}%" if pct < 100 else "Règlement intégral"
    c.setFillColor(dark)
    c.setFont("Helvetica", 11)
    c.drawString(40, y, libelle)
    c.setFont("Helvetica-Bold", 11)
    c.drawRightString(w - 40, y, _eur(tx.get("amount", 0) / 100))
    y -= 26
    c.setFillColor(band)
    c.rect(40, y - 14, w - 80, 30, stroke=0, fill=1)
    c.setFillColor(gold)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(52, y - 4, "TOTAL ENCAISSÉ")
    c.setFillColor(white)
    c.drawRightString(w - 52, y - 4, _eur(tx.get("amount", 0) / 100))
    y -= 48
    c.setFillColor(grey)
    c.setFont("Helvetica-Oblique", 9)
    c.drawString(40, y, "Paiement sécurisé par Stripe. Ce reçu atteste de l'encaissement du montant ci-dessus.")

    c.setStrokeColor(gold)
    c.line(40, 40, w - 40, 40)
    c.setFillColor(grey)
    c.setFont("Helvetica-Oblique", 8)
    c.drawRightString(w - 40, 28, "SIRIUS · HERMÈS AGORA")
    c.save()
    buf.seek(0)
    return buf
