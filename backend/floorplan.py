# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""PLANS# — plans 2D cotés de bâtiment (style croquis d'architecte) + moteur de géométrie.

Le cerveau convertit une description en langage naturel en géométrie structurée
(pièces, ouvertures, mobilier). Le moteur de géométrie calcule surfaces, périmètres
et volumes ; l'export DXF s'ouvre dans AutoCAD, LibreCAD, QCAD…

Convention : x,y = coin haut-gauche en mètres, y vers le bas, nord = haut.
"""

import io
import json
import logging
import os

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

logger = logging.getLogger("sirius.plans")

WALL = 0.15  # épaisseur de mur dessinée (m)


# =========================================================
# MOTEUR DE GÉOMÉTRIE
# =========================================================

def room_metrics(piece: dict) -> dict:
    """Surface, périmètre et volume (si hauteur connue) d'une pièce rectangulaire."""
    length = max(0.0, float(piece.get("l") or 0))
    depth = max(0.0, float(piece.get("p") or 0))
    height = float(piece.get("hauteur") or 0) or None
    metrics = {
        "surface_m2": round(length * depth, 2),
        "perimetre_m": round(2 * (length + depth), 2),
    }
    if height:
        metrics["volume_m3"] = round(length * depth * height, 2)
        metrics["surface_murs_m2"] = round(2 * (length + depth) * height, 2)
    return metrics


def plan_metrics(plan: dict) -> dict:
    """Métriques de géométrie du plan complet : par pièce + totaux + emprise."""
    pieces = plan.get("pieces") or []
    per_room = []
    total = 0.0
    for piece in pieces:
        m = room_metrics(piece)
        per_room.append({"nom": piece.get("nom") or "Pièce", **m})
        total += m["surface_m2"]
    xs = [float(p.get("x") or 0) for p in pieces] + [float(p.get("x") or 0) + float(p.get("l") or 0) for p in pieces]
    ys = [float(p.get("y") or 0) for p in pieces] + [float(p.get("y") or 0) + float(p.get("p") or 0) for p in pieces]
    emprise = {
        "largeur_m": round(max(xs) - min(xs), 2) if xs else 0,
        "profondeur_m": round(max(ys) - min(ys), 2) if ys else 0,
    }
    return {"pieces": per_room, "surface_totale_m2": round(total, 2), "emprise": emprise}


def _clamp_openings(plan: dict) -> dict:
    """Ancre chaque ouverture à sa pièce et borne position/largeur à la longueur du mur."""
    rooms = {(p.get("nom") or "").strip().lower(): p for p in plan.get("pieces") or []}
    valid = []
    for op in plan.get("ouvertures") or []:
        room = rooms.get((op.get("piece") or "").strip().lower())
        if not room:
            room = next(iter(rooms.values()), None)
        if not room:
            continue
        wall = (op.get("mur") or "sud").strip().lower()
        if wall not in ("nord", "sud", "est", "ouest"):
            wall = "sud"
        wall_len = float(room.get("l") or 0) if wall in ("nord", "sud") else float(room.get("p") or 0)
        width = min(max(0.4, float(op.get("largeur") or 0.9)), max(0.4, wall_len - 0.1))
        position = float(op.get("position") if op.get("position") is not None else (wall_len - width) / 2)
        position = min(max(0.0, position), max(0.0, wall_len - width))
        valid.append({
            "type": (op.get("type") or "porte").strip().lower(),
            "piece": room.get("nom") or "Pièce",
            "mur": wall, "position": round(position, 2), "largeur": round(width, 2),
        })
    # Déduplication : deux ouvertures de même type qui se chevauchent sur le même mur.
    deduped = []
    for op in valid:
        duplicate = any(
            o["type"] == op["type"] and o["piece"] == op["piece"] and o["mur"] == op["mur"]
            and not (op["position"] + op["largeur"] <= o["position"] or o["position"] + o["largeur"] <= op["position"])
            for o in deduped
        )
        if not duplicate:
            deduped.append(op)
    plan["ouvertures"] = deduped
    return plan


def _shared_wall(a: dict, b: dict):
    """Mur partagé entre deux pièces adjacentes : (mur de a, début, longueur) ou None."""
    ax1, ay1, ax2, ay2 = a["x"], a["y"], a["x"] + a["l"], a["y"] + a["p"]
    bx1, by1, bx2, by2 = b["x"], b["y"], b["x"] + b["l"], b["y"] + b["p"]
    eps = 0.01
    # a à gauche de b (mur est de a) / a à droite (mur ouest)
    for wall, edge_a, edge_b in (("est", ax2, bx1), ("ouest", ax1, bx2)):
        if abs(edge_a - edge_b) < eps:
            top, bottom = max(ay1, by1), min(ay2, by2)
            if bottom - top >= 0.8:
                return wall, top - ay1, bottom - top
    # a au-dessus de b (mur sud de a) / a en dessous (mur nord)
    for wall, edge_a, edge_b in (("sud", ay2, by1), ("nord", ay1, by2)):
        if abs(edge_a - edge_b) < eps:
            left, right = max(ax1, bx1), min(ax2, bx2)
            if right - left >= 0.8:
                return wall, left - ax1, right - left
    return None


def _opening_span(op: dict, room: dict):
    """Segment absolu (x1,y1,x2,y2) d'une ouverture sur le mur de sa pièce."""
    x, y, l, p = room["x"], room["y"], room["l"], room["p"]
    pos, w = op["position"], op["largeur"]
    if op["mur"] == "nord":
        return (x + pos, y, x + pos + w, y)
    if op["mur"] == "sud":
        return (x + pos, y + p, x + pos + w, y + p)
    if op["mur"] == "ouest":
        return (x, y + pos, x, y + pos + w)
    return (x + l, y + pos, x + l, y + pos + w)


def _rooms_served_by_doors(plan: dict) -> set:
    """Pièces desservies par une porte/passage — y compris celles de l'autre côté
    d'un mur partagé : une porte entre séjour et chambre dessert les deux."""
    pieces = plan.get("pieces") or []
    by_name = {p["nom"]: p for p in pieces}
    served = set()
    eps = 0.05
    for op in plan.get("ouvertures") or []:
        if op["type"] == "fenetre":
            continue
        room = by_name.get(op["piece"])
        if not room:
            continue
        served.add(op["piece"])
        x1, y1, x2, y2 = _opening_span(op, room)
        for other in pieces:
            if other["nom"] == op["piece"]:
                continue
            ox1, oy1, ox2, oy2 = other["x"], other["y"], other["x"] + other["l"], other["y"] + other["p"]
            on_v = abs(x1 - x2) < eps and (abs(x1 - ox1) < eps or abs(x1 - ox2) < eps) and y1 >= oy1 - eps and y2 <= oy2 + eps
            on_h = abs(y1 - y2) < eps and (abs(y1 - oy1) < eps or abs(y1 - oy2) < eps) and x1 >= ox1 - eps and x2 <= ox2 + eps
            if on_v or on_h:
                served.add(other["nom"])
    return served


def _ensure_access(plan: dict) -> dict:
    """Filet de sécurité : toute pièce sans accès reçoit une porte.

    De préférence sur un mur partagé avec une pièce voisine (porte intérieure),
    sinon sur son mur sud (accès extérieur). Le plan reste toujours habitable
    même si le cerveau a oublié des portes.
    """
    pieces = plan.get("pieces") or []
    served = _rooms_served_by_doors(plan)
    for piece in pieces:
        if piece["nom"] in served:
            continue
        added = False
        for other in pieces:
            if other is piece:
                continue
            shared = _shared_wall(piece, other)
            if shared:
                wall, start, length = shared
                width = min(0.9, length - 0.1)
                plan["ouvertures"].append({
                    "type": "porte", "piece": piece["nom"], "mur": wall,
                    "position": round(start + (length - width) / 2, 2), "largeur": round(width, 2),
                })
                added = True
                break
        if not added:
            width = min(0.9, piece["l"] - 0.2)
            plan["ouvertures"].append({
                "type": "porte", "piece": piece["nom"], "mur": "sud",
                "position": round((piece["l"] - width) / 2, 2), "largeur": round(width, 2),
            })
        served.add(piece["nom"])
    return plan


TECH_TYPES = frozenset((
    "prise", "prise_20a", "interrupteur", "point_lumineux", "radiateur",
    "tableau_electrique", "arrivee_eau", "evacuation_eau", "vmc",
))


def _clamp_technique(plan: dict) -> dict:
    """Valide la couche technique : type connu, point ramené dans sa pièce."""
    rooms = {(p.get("nom") or "").strip().lower(): p for p in plan.get("pieces") or []}
    valid = []
    for item in (plan.get("technique") or [])[:80]:
        kind = (item.get("type") or "").strip().lower()
        if kind not in TECH_TYPES:
            continue
        room = rooms.get((item.get("piece") or "").strip().lower()) or next(iter(rooms.values()), None)
        if not room:
            continue
        x = min(max(float(item.get("x") or 0), room["x"] + 0.05), room["x"] + room["l"] - 0.05)
        y = min(max(float(item.get("y") or 0), room["y"] + 0.05), room["y"] + room["p"] - 0.05)
        valid.append({"type": kind, "piece": room["nom"], "x": round(x, 2), "y": round(y, 2)})
    plan["technique"] = valid
    return plan


# Filet de sécurité : le LLM répond parfois avec des noms anglais malgré la consigne.
# Traduction mot-à-mot (insensible à la casse, sur des noms courts type "Bedroom 2").
_EN_FR_NAMES = {
    "bedroom": "chambre", "bathroom": "salle de bain", "kitchen": "cuisine",
    "living room": "séjour", "living": "séjour", "lounge": "salon", "dining room": "salle à manger",
    "dining": "salle à manger", "hallway": "couloir", "hall": "entrée", "entrance": "entrée",
    "garage": "garage", "office": "bureau", "toilet": "wc", "wc": "wc", "closet": "placard",
    "corridor": "couloir", "laundry": "buanderie", "laundry room": "buanderie", "pantry": "cellier",
    "balcony": "balcon", "terrace": "terrasse", "master bedroom": "chambre parentale",
    "guest room": "chambre d'amis", "study": "bureau", "attic": "grenier", "basement": "sous-sol",
    "utility room": "cellier", "storage": "rangement", "storage room": "rangement",
    "bed": "lit", "sofa": "canapé", "couch": "canapé", "table": "table", "chair": "chaise",
    "desk": "bureau", "wardrobe": "armoire", "shelf": "étagère", "shower": "douche",
    "bathtub": "baignoire", "sink": "évier", "counter": "plan de travail", "fridge": "frigo",
    "refrigerator": "frigo", "stove": "cuisinière", "oven": "four", "washing machine": "lave-linge",
}


def _translate_name(name: str) -> str:
    """Traduit un nom de pièce/mobilier anglais courant vers le français ; sinon inchangé."""
    raw = (name or "").strip()
    if not raw:
        return raw
    low = raw.lower()
    if low in _EN_FR_NAMES:
        fr = _EN_FR_NAMES[low]
        return fr[:1].upper() + fr[1:] if raw[:1].isupper() else fr
    # variantes numérotées : "Bedroom 2" -> "Chambre 2"
    parts = raw.rsplit(" ", 1)
    if len(parts) == 2 and parts[1].isdigit() and parts[0].lower() in _EN_FR_NAMES:
        fr = _EN_FR_NAMES[parts[0].lower()]
        fr = fr[:1].upper() + fr[1:] if parts[0][:1].isupper() else fr
        return f"{fr} {parts[1]}"
    return raw


def normalize_plan(plan: dict) -> dict:
    """Nettoie la structure produite par le cerveau et calcule la géométrie."""
    if not isinstance(plan, dict) or not (plan.get("pieces") or []):
        raise ValueError("Plan vide : aucune pièce détectée.")
    pieces = []
    for piece in plan["pieces"][:20]:
        length, depth = float(piece.get("l") or 0), float(piece.get("p") or 0)
        if length <= 0.2 or depth <= 0.2:
            continue
        pieces.append({
            "nom": _translate_name((piece.get("nom") or "Pièce").strip()[:40]),
            "x": round(float(piece.get("x") or 0), 2), "y": round(float(piece.get("y") or 0), 2),
            "l": round(length, 2), "p": round(depth, 2),
            **({"hauteur": round(float(piece["hauteur"]), 2)} if piece.get("hauteur") else {}),
        })
    if not pieces:
        raise ValueError("Aucune pièce exploitable (dimensions manquantes).")
    mobilier = []
    for item in (plan.get("mobilier") or [])[:30]:
        length, depth = float(item.get("l") or 0), float(item.get("p") or 0)
        if length <= 0.05 or depth <= 0.05:
            continue
        mobilier.append({
            "nom": _translate_name((item.get("nom") or "Élément").strip()[:40]),
            "x": round(float(item.get("x") or 0), 2), "y": round(float(item.get("y") or 0), 2),
            "l": round(length, 2), "p": round(depth, 2),
        })
    result = {
        "titre": _translate_name((plan.get("titre") or "Plan ΣIRIUS").strip()[:80]),
        "unite": "m",
        "pieces": pieces,
        "mobilier": mobilier,
        "ouvertures": plan.get("ouvertures") or [],
        "technique": plan.get("technique") or [],
    }
    result = _clamp_openings(result)
    result = _ensure_access(result)
    result = _clamp_openings(result)  # borne aussi les portes ajoutées
    result = _clamp_technique(result)
    result["geometrie"] = plan_metrics(result)
    return result


# =========================================================
# GÉNÉRATION PAR LE CERVEAU (description → plan structuré)
# =========================================================

PLAN_PROMPT = """Tu es l'architecte de ΣIRIUS. Tu convertis une description en plan 2D structuré.
Réponds UNIQUEMENT avec un objet JSON valide :
{"titre": "...", "pieces": [{"nom": "...", "x": 0, "y": 0, "l": 6, "p": 4, "hauteur": 2.5}],
 "ouvertures": [{"type": "porte|fenetre|porte_garage|passage", "piece": "...", "mur": "nord|sud|est|ouest", "position": 1.5, "largeur": 0.9}],
 "mobilier": [{"nom": "...", "x": 0.1, "y": 0.1, "l": 2.0, "p": 0.6}],
 "technique": [{"type": "prise|prise_20a|interrupteur|point_lumineux|radiateur|tableau_electrique|arrivee_eau|evacuation_eau|vmc", "piece": "...", "x": 0.2, "y": 0.2}]}

Règles :
- TOUS les noms (pièces, mobilier, titre) sont en FRANÇAIS.
- Unité : mètres. x,y = coin haut-gauche de chaque rectangle ; y augmente vers le bas ; nord = haut du plan.
- Les pièces adjacentes partagent leurs murs (coordonnées contiguës, pas de chevauchement).
- position = distance depuis le coin gauche (murs nord/sud) ou haut (murs est/ouest) du mur de la pièce.
- Largeurs réalistes : porte 0.9, porte_garage 2.4-3.0, fenetre 1.0-1.6, passage 1.0-1.5.
- ACCÈS OBLIGATOIRE : chaque pièce a AU MOINS une porte ou un passage (vers une pièce voisine ou l'extérieur). Aucune pièce ne doit être inaccessible.
- FENÊTRES : chaque pièce de vie (séjour, chambre, cuisine, bureau) a au moins une fenêtre sur un mur donnant sur l'extérieur. Salle de bain/WC : petite fenêtre (0.6) si un mur est extérieur.
- Une seule porte d'entrée depuis l'extérieur, placée logiquement.
- ÉQUIPEMENTS OBLIGATOIRES (dans mobilier, dimensions réelles) :
  * cuisine/kitchenette → plan de travail avec évier (l≈1.8-2.4, p≈0.6), frigo (0.6×0.6), cuisinière (0.6×0.6)
  * salle de bain → douche (0.9×0.9) ou baignoire (1.7×0.75), lavabo (0.6×0.45), WC (0.4×0.65) si pas de WC séparé
  * WC séparé → cuvette WC (0.4×0.65)
  * chambre → lit (1.4-1.6 × 1.9-2.0), pas 2×0.6
- Pour un logement (appartement, maison, studio) : inclure TOUTES les fonctions essentielles même si non listées — coin cuisine ou cuisine, salle d'eau, WC (séparé ou intégré). Ne jamais livrer un logement sans cuisine ni WC.
- COUCHE TECHNIQUE (norme NF C 15-100 simplifiée, positions absolues en mètres, collées aux murs) :
  * prise : 3-5 par pièce de vie, 1-2 en pièce d'eau (loin des points d'eau), le long des murs
  * prise_20a : cuisine (frigo, plaques, four) et lave-linge
  * interrupteur : à côté de CHAQUE porte, côté poignée (~0.2 m du bord)
  * point_lumineux : au centre de chaque pièce
  * radiateur : sous chaque fenêtre (sauf cuisine si plan de travail)
  * tableau_electrique : près de la porte d'entrée
  * arrivee_eau / evacuation_eau : à chaque équipement sanitaire (évier, lavabo, douche, baignoire, WC)
  * vmc : salle de bain, WC et cuisine
- hauteur (plafond) : TOUJOURS l'indiquer (2.5 par défaut si non précisée).
- Le mobilier est posé À L'INTÉRIEUR de sa pièce (coordonnées absolues).
- hauteur (plafond) uniquement si mentionnée ou déductible, sinon omettre.
- Si la description est vague, propose un agencement raisonnable et réaliste."""


def _extract_json(raw: str) -> dict:
    """Parse le JSON du cerveau, même entouré de texte ou de clôtures Markdown."""
    raw = (raw or "").strip()
    try:
        return json.loads(raw)
    except Exception:
        pass
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        return json.loads(raw[start:end + 1])
    raise ValueError("Réponse du cerveau sans JSON exploitable.")


async def generate_floorplan(description: str, keys: dict = None) -> dict:
    from openai import AsyncOpenAI
    from sirius_brain import ENV_GROQ_LLM_KEY, GROQ_LLM_ENDPOINT, GROQ_LLM_PRIMARY

    api_key = ENV_GROQ_LLM_KEY or (keys or {}).get("groq") or ""
    if not api_key:
        raise ValueError("Clé GROQ absente : impossible de générer le plan.")
    client = AsyncOpenAI(api_key=api_key, base_url=GROQ_LLM_ENDPOINT, max_retries=0, timeout=40.0)
    last_error = None
    for attempt in range(2):
        try:
            # 1re tentative : mode JSON strict. 2e : sans contrainte (le mode strict de
            # l'API échoue parfois à vide), avec extraction manuelle du JSON.
            kwargs = {"response_format": {"type": "json_object"}} if attempt == 0 else {}
            resp = await client.chat.completions.create(
                model=GROQ_LLM_PRIMARY,
                messages=[
                    {"role": "system", "content": PLAN_PROMPT},
                    {"role": "user", "content": description[:2000]},
                ],
                max_tokens=8000,
                temperature=0.2 if attempt == 0 else 0.3,
                **kwargs,
            )
            raw = (resp.choices[0].message.content or "").strip()
            return normalize_plan(_extract_json(raw))
        except ValueError:
            raise
        except Exception as error:
            last_error = error
            logger.warning("[PLANS] tentative %d échouée : %r", attempt + 1, error)
    raise last_error


# =========================================================
# EXPORT DXF (AutoCAD, LibreCAD, QCAD…)
# =========================================================

def _dxf_dimension(msp, x1, y1, x2, y2, offset, text):
    """Cote manuelle (lignes + repères + texte) : rendue partout, sans style DIM."""
    horizontal = abs(y1 - y2) < 1e-9
    if horizontal:
        ya = y1 + offset
        msp.add_line((x1, y1), (x1, ya), dxfattribs={"layer": "COTES"})
        msp.add_line((x2, y2), (x2, ya), dxfattribs={"layer": "COTES"})
        msp.add_line((x1, ya), (x2, ya), dxfattribs={"layer": "COTES"})
        tx, ty, rot = (x1 + x2) / 2, ya + 0.12, 0
    else:
        xa = x1 + offset
        msp.add_line((x1, y1), (xa, y1), dxfattribs={"layer": "COTES"})
        msp.add_line((x2, y2), (xa, y2), dxfattribs={"layer": "COTES"})
        msp.add_line((xa, y1), (xa, y2), dxfattribs={"layer": "COTES"})
        tx, ty, rot = xa + 0.12, (y1 + y2) / 2, 90
    msp.add_text(text, height=0.22, rotation=rot, dxfattribs={"layer": "COTES"}).set_placement((tx, ty))


def plan_to_dxf(plan: dict) -> bytes:
    import ezdxf

    doc = ezdxf.new("R2010", setup=True)
    for name, color in (("MURS", 7), ("OUVERTURES", 5), ("MOBILIER", 8), ("COTES", 1), ("TEXTE", 3), ("ELEC", 2), ("PLOMBERIE", 4)):
        doc.layers.add(name, color=color)
    msp = doc.modelspace()

    def Y(y):  # DXF a l'axe Y vers le haut ; le plan l'a vers le bas.
        return -y

    for piece in plan.get("pieces") or []:
        x, y, l, p = piece["x"], piece["y"], piece["l"], piece["p"]
        msp.add_lwpolyline(
            [(x, Y(y)), (x + l, Y(y)), (x + l, Y(y + p)), (x, Y(y + p))],
            close=True, dxfattribs={"layer": "MURS", "const_width": WALL},
        )
        metrics = room_metrics(piece)
        label = f"{piece['nom']} — {metrics['surface_m2']} m2"
        msp.add_text(label, height=0.25, dxfattribs={"layer": "TEXTE"}).set_placement((x + 0.3, Y(y + 0.45)))
        _dxf_dimension(msp, x, Y(y), x + l, Y(y), 0.6, f"{l:.2f} m")
        _dxf_dimension(msp, x, Y(y), x, Y(y + p), -0.6, f"{p:.2f} m")

    rooms = {p["nom"]: p for p in plan.get("pieces") or []}
    for op in plan.get("ouvertures") or []:
        room = rooms.get(op["piece"])
        if not room:
            continue
        x, y, l, p = room["x"], room["y"], room["l"], room["p"]
        pos, w, wall = op["position"], op["largeur"], op["mur"]
        if wall == "nord":
            a, b = (x + pos, Y(y)), (x + pos + w, Y(y))
        elif wall == "sud":
            a, b = (x + pos, Y(y + p)), (x + pos + w, Y(y + p))
        elif wall == "ouest":
            a, b = (x, Y(y + pos)), (x, Y(y + pos + w))
        else:
            a, b = (x + l, Y(y + pos)), (x + l, Y(y + pos + w))
        style = {"layer": "OUVERTURES"}
        if op["type"] == "fenetre":
            msp.add_line(a, b, dxfattribs=style)
        else:
            msp.add_line(a, b, dxfattribs={**style, "linetype": "DASHED"})
        msp.add_text(op["type"], height=0.15, dxfattribs={"layer": "OUVERTURES"}).set_placement(
            ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.05))

    for item in plan.get("mobilier") or []:
        x, y, l, p = item["x"], item["y"], item["l"], item["p"]
        msp.add_lwpolyline(
            [(x, Y(y)), (x + l, Y(y)), (x + l, Y(y + p)), (x, Y(y + p))],
            close=True, dxfattribs={"layer": "MOBILIER"},
        )
        msp.add_text(item["nom"], height=0.15, dxfattribs={"layer": "MOBILIER"}).set_placement((x + 0.05, Y(y + 0.25)))

    msp.add_text(plan.get("titre") or "Plan ΣIRIUS", height=0.4, dxfattribs={"layer": "TEXTE"}).set_placement((0, 1.0))

    # Couche technique : symboles électriques (calque ELEC) et fluides (calque PLOMBERIE)
    _TECH_DXF = {
        "prise": ("ELEC", "P"), "prise_20a": ("ELEC", "P20"), "interrupteur": ("ELEC", "I"),
        "point_lumineux": ("ELEC", "DCL"), "radiateur": ("ELEC", "RAD"), "tableau_electrique": ("ELEC", "TE"),
        "arrivee_eau": ("PLOMBERIE", "EF"), "evacuation_eau": ("PLOMBERIE", "EU"), "vmc": ("PLOMBERIE", "VMC"),
    }
    for item in plan.get("technique") or []:
        layer, label = _TECH_DXF.get(item["type"], ("ELEC", "?"))
        cx, cy = item["x"], Y(item["y"])
        msp.add_circle((cx, cy), 0.12, dxfattribs={"layer": layer})
        msp.add_text(label, height=0.12, dxfattribs={"layer": layer}).set_placement((cx + 0.16, cy - 0.05))

    buffer = io.StringIO()
    doc.write(buffer)
    return buffer.getvalue().encode("utf-8")


# =========================================================
# ROUTES API
# =========================================================

class PlanRequest(BaseModel):
    description: str
    keys: dict = {}


class PlanDxfRequest(BaseModel):
    plan: dict


def make_floorplan_router(rate_ok) -> APIRouter:
    router = APIRouter(prefix="/floorplan", tags=["plans"])

    @router.post("")
    async def create_plan(req: PlanRequest, request: Request):
        desc = (req.description or "").strip()
        if not desc:
            raise HTTPException(status_code=400, detail="Description vide")
        if not rate_ok(request.client.host if request.client else "?", limit=10):
            raise HTTPException(status_code=429, detail="Trop de requêtes, patientez un instant.")
        try:
            return await generate_floorplan(desc, keys=req.keys or {})
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error))
        except Exception as error:
            logger.error("[PLANS] génération échouée : %r", error)
            raise HTTPException(status_code=500, detail="Sirius n'a pas pu dessiner ce plan, réessayez.")

    @router.post("/dxf")
    async def export_dxf(req: PlanDxfRequest):
        try:
            data = plan_to_dxf(normalize_plan(req.plan))
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error))
        except Exception as error:
            logger.error("[PLANS] export DXF échoué : %r", error)
            raise HTTPException(status_code=500, detail="Export DXF impossible.")
        return Response(
            content=data, media_type="application/dxf",
            headers={"Content-Disposition": 'attachment; filename="plan-sirius.dxf"'},
        )

    return router
