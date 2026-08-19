# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Module HACCP : traçabilité, températures, PMS, non-conformités, nettoyage, allergènes, documents."""
import uuid
from datetime import datetime, timezone, date, timedelta
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, StringConstraints
from typing import Optional, List, Annotated

ReqStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

NO_ID = {"_id": 0}

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def today():
    return date.today().isoformat()

TEMP_RANGES = {
    "frigo": (0.0, 4.0),
    "congelateur": (-30.0, -18.0),
    "chaud": (63.0, 110.0),
}

PMS_DEFAULTS = [
    ("Bonnes pratiques d'hygiène (BPH)", "BPH", "Plan de formation du personnel à l'hygiène"),
    ("Bonnes pratiques d'hygiène (BPH)", "BPH", "Tenue vestimentaire et lavage des mains"),
    ("Bonnes pratiques d'hygiène (BPH)", "BPH", "Plan de lutte contre les nuisibles"),
    ("Bonnes pratiques d'hygiène (BPH)", "BPH", "Maintenance des équipements et locaux"),
    ("Procédures HACCP", "CCP", "Contrôle des températures à réception"),
    ("Procédures HACCP", "CCP", "Contrôle des températures de stockage"),
    ("Procédures HACCP", "CCP", "Refroidissement rapide (+63°C → +10°C en moins de 2h)"),
    ("Procédures HACCP", "CCP", "Remise en température (+10°C → +63°C en moins de 1h)"),
    ("Traçabilité", "PROCEDURE", "Archivage des étiquettes fournisseurs (6 mois minimum)"),
    ("Traçabilité", "PROCEDURE", "Procédure de retrait / rappel produit"),
    ("Gestion des non-conformités", "PROCEDURE", "Enregistrement et actions correctives"),
    ("Plan de nettoyage", "PROCEDURE", "Plan de nettoyage et désinfection affiché et suivi"),
]

EQUIP_DEFAULTS = [
    ("Chambre froide positive", "frigo"),
    ("Congélateur", "congelateur"),
    ("Frigo de service", "frigo"),
]

ALLERGENES_14 = ["Gluten", "Crustacés", "Œufs", "Poissons", "Arachides", "Soja", "Lait",
                 "Fruits à coque", "Céleri", "Moutarde", "Sésame", "Sulfites", "Lupin", "Mollusques"]


class TraceIn(BaseModel):
    produit: ReqStr
    lot: Optional[str] = ""
    fournisseur: Optional[str] = ""
    date_reception: Optional[str] = None
    dlc: Optional[str] = None
    temperature_reception: Optional[float] = None
    quantite: Optional[str] = ""
    notes: Optional[str] = ""

class EquipIn(BaseModel):
    nom: ReqStr
    type: str = "frigo"

class TempIn(BaseModel):
    equipement_id: str
    valeur: float
    releve_par: Optional[str] = ""

class PmsPatch(BaseModel):
    statut: str

class NcIn(BaseModel):
    type: str = "autre"
    description: ReqStr
    action_corrective: Optional[str] = ""
    gravite: str = "mineure"

class CleanTaskIn(BaseModel):
    zone: ReqStr
    surface: Optional[str] = ""
    produit: Optional[str] = ""
    frequence: str = "quotidien"
    responsable: Optional[str] = ""

class CleanLogIn(BaseModel):
    tache_id: str
    fait_par: Optional[str] = ""

class AllergeneIn(BaseModel):
    plat: ReqStr
    allergenes: List[str] = []

class DocIn(BaseModel):
    nom: ReqStr
    categorie: str = "autre"
    date_emission: Optional[str] = None
    date_expiration: Optional[str] = None
    notes: Optional[str] = ""


def trace_status(item):
    dlc = item.get("dlc")
    if not dlc:
        return "ok"
    try:
        d = date.fromisoformat(dlc)
    except ValueError:
        return "ok"
    if d < date.today():
        return "expire"
    if d <= date.today() + timedelta(days=2):
        return "bientot"
    return "ok"


def doc_status(item):
    exp = item.get("date_expiration")
    if not exp:
        return "valide"
    try:
        d = date.fromisoformat(exp)
    except ValueError:
        return "valide"
    if d < date.today():
        return "expire"
    if d <= date.today() + timedelta(days=30):
        return "bientot"
    return "valide"


FREQ_DAYS = {"quotidien": 1, "hebdomadaire": 7, "mensuel": 30}


def make_haccp_router(db):
    r = APIRouter(prefix="/haccp")

    # ---------- 1. Traçabilité & étiquetage ----------
    @r.get("/trace")
    async def list_trace():
        items = await db.haccp_trace.find({}, NO_ID).sort("created_at", -1).to_list(300)
        for it in items:
            it["statut"] = trace_status(it)
        return {"items": items}

    @r.post("/trace")
    async def add_trace(body: TraceIn):
        doc = body.model_dump()
        doc.update({"id": str(uuid.uuid4()), "created_at": now_iso(),
                    "date_reception": doc.get("date_reception") or today()})
        await db.haccp_trace.insert_one(dict(doc))
        doc["statut"] = trace_status(doc)
        return doc

    @r.delete("/trace/{item_id}")
    async def del_trace(item_id: str):
        await db.haccp_trace.delete_one({"id": item_id})
        return {"ok": True}

    # ---------- 2. Températures ----------
    @r.get("/equipements")
    async def list_equip():
        items = await db.haccp_equip.find({}, NO_ID).to_list(100)
        if not items:
            for nom, typ in EQUIP_DEFAULTS:
                doc = {"id": str(uuid.uuid4()), "nom": nom, "type": typ, "created_at": now_iso()}
                await db.haccp_equip.insert_one(dict(doc))
                items.append(doc)
        for it in items:
            lo, hi = TEMP_RANGES.get(it["type"], (0, 4))
            it["min"], it["max"] = lo, hi
            last = await db.haccp_temp.find({"equipement_id": it["id"]}, NO_ID).sort("created_at", -1).to_list(1)
            it["dernier_releve"] = last[0] if last else None
        return {"items": items}

    @r.post("/equipements")
    async def add_equip(body: EquipIn):
        if body.type not in TEMP_RANGES:
            raise HTTPException(status_code=400, detail="Type invalide (frigo, congelateur, chaud)")
        doc = {"id": str(uuid.uuid4()), "nom": body.nom, "type": body.type, "created_at": now_iso()}
        await db.haccp_equip.insert_one(dict(doc))
        lo, hi = TEMP_RANGES[body.type]
        doc.update({"min": lo, "max": hi, "dernier_releve": None})
        return doc

    @r.delete("/equipements/{item_id}")
    async def del_equip(item_id: str):
        await db.haccp_equip.delete_one({"id": item_id})
        await db.haccp_temp.delete_many({"equipement_id": item_id})
        return {"ok": True}

    @r.get("/temperatures")
    async def list_temp(equipement_id: Optional[str] = None):
        q = {"equipement_id": equipement_id} if equipement_id else {}
        items = await db.haccp_temp.find(q, NO_ID).sort("created_at", -1).to_list(120)
        return {"items": items}

    @r.post("/temperatures")
    async def add_temp(body: TempIn):
        eq = await db.haccp_equip.find_one({"id": body.equipement_id}, NO_ID)
        if not eq:
            raise HTTPException(status_code=404, detail="Équipement introuvable")
        lo, hi = TEMP_RANGES.get(eq["type"], (0, 4))
        doc = {"id": str(uuid.uuid4()), "equipement_id": body.equipement_id, "equipement": eq["nom"],
               "valeur": body.valeur, "releve_par": body.releve_par or "",
               "conforme": lo <= body.valeur <= hi, "created_at": now_iso()}
        await db.haccp_temp.insert_one(dict(doc))
        if not doc["conforme"]:
            nc = {"id": str(uuid.uuid4()), "type": "température",
                  "description": f"{eq['nom']} : {body.valeur}°C hors plage [{lo} ; {hi}]°C",
                  "action_corrective": "", "gravite": "majeure", "statut": "ouverte",
                  "created_at": now_iso(), "cloture_le": None, "auto": True}
            await db.haccp_nc.insert_one(dict(nc))
        return doc

    # ---------- 3. Plan de maîtrise sanitaire ----------
    @r.get("/pms")
    async def list_pms():
        items = await db.haccp_pms.find({}, NO_ID).sort("categorie", 1).to_list(200)
        if not items:
            for cat, code, intitule in PMS_DEFAULTS:
                doc = {"id": str(uuid.uuid4()), "categorie": cat, "code": code, "intitule": intitule,
                       "statut": "a_verifier", "derniere_revision": None, "created_at": now_iso()}
                await db.haccp_pms.insert_one(dict(doc))
                items.append(doc)
        return {"items": items}

    @r.patch("/pms/{item_id}")
    async def patch_pms(item_id: str, body: PmsPatch):
        if body.statut not in ("en_place", "a_mettre_a_jour", "a_verifier"):
            raise HTTPException(status_code=400, detail="Statut invalide")
        res = await db.haccp_pms.update_one(
            {"id": item_id}, {"$set": {"statut": body.statut, "derniere_revision": today()}})
        if not res.matched_count:
            raise HTTPException(status_code=404, detail="Élément introuvable")
        return {"ok": True, "statut": body.statut, "derniere_revision": today()}

    # ---------- 4. Non-conformités ----------
    @r.get("/nc")
    async def list_nc():
        items = await db.haccp_nc.find({}, NO_ID).sort("created_at", -1).to_list(300)
        return {"items": items}

    @r.post("/nc")
    async def add_nc(body: NcIn):
        doc = body.model_dump()
        doc.update({"id": str(uuid.uuid4()), "statut": "ouverte", "cloture_le": None,
                    "auto": False, "created_at": now_iso()})
        await db.haccp_nc.insert_one(dict(doc))
        return doc

    @r.patch("/nc/{item_id}/cloture")
    async def close_nc(item_id: str, body: Optional[dict] = None):
        action = (body or {}).get("action_corrective", "")
        upd = {"statut": "cloturee", "cloture_le": now_iso()}
        if action:
            upd["action_corrective"] = action
        res = await db.haccp_nc.update_one({"id": item_id}, {"$set": upd})
        if not res.matched_count:
            raise HTTPException(status_code=404, detail="Non-conformité introuvable")
        return {"ok": True}

    @r.delete("/nc/{item_id}")
    async def del_nc(item_id: str):
        await db.haccp_nc.delete_one({"id": item_id})
        return {"ok": True}

    # ---------- 5. Nettoyage & désinfection ----------
    @r.get("/nettoyage/taches")
    async def list_clean():
        items = await db.haccp_clean.find({}, NO_ID).to_list(200)
        for it in items:
            last = await db.haccp_clean_log.find({"tache_id": it["id"]}, NO_ID).sort("created_at", -1).to_list(1)
            it["dernier_nettoyage"] = last[0]["created_at"] if last else None
            days = FREQ_DAYS.get(it.get("frequence", "quotidien"), 1)
            if not last:
                it["a_faire"] = True
            else:
                done = datetime.fromisoformat(last[0]["created_at"])
                it["a_faire"] = (datetime.now(timezone.utc) - done) >= timedelta(days=days)
        return {"items": items}

    @r.post("/nettoyage/taches")
    async def add_clean(body: CleanTaskIn):
        doc = body.model_dump()
        doc.update({"id": str(uuid.uuid4()), "created_at": now_iso()})
        await db.haccp_clean.insert_one(dict(doc))
        doc.update({"dernier_nettoyage": None, "a_faire": True})
        return doc

    @r.delete("/nettoyage/taches/{item_id}")
    async def del_clean(item_id: str):
        await db.haccp_clean.delete_one({"id": item_id})
        await db.haccp_clean_log.delete_many({"tache_id": item_id})
        return {"ok": True}

    @r.post("/nettoyage/logs")
    async def add_clean_log(body: CleanLogIn):
        doc = {"id": str(uuid.uuid4()), "tache_id": body.tache_id,
               "fait_par": body.fait_par or "", "created_at": now_iso()}
        await db.haccp_clean_log.insert_one(dict(doc))
        return doc

    # ---------- 6. Allergènes ----------
    @r.get("/allergenes")
    async def list_allerg():
        items = await db.haccp_allerg.find({}, NO_ID).sort("plat", 1).to_list(300)
        return {"items": items, "liste_14": ALLERGENES_14}

    @r.post("/allergenes")
    async def add_allerg(body: AllergeneIn):
        doc = {"id": str(uuid.uuid4()), "plat": body.plat,
               "allergenes": [a for a in body.allergenes if a in ALLERGENES_14],
               "created_at": now_iso()}
        await db.haccp_allerg.insert_one(dict(doc))
        return doc

    @r.delete("/allergenes/{item_id}")
    async def del_allerg(item_id: str):
        await db.haccp_allerg.delete_one({"id": item_id})
        return {"ok": True}

    # ---------- 7. Documentation obligatoire ----------
    @r.get("/documents")
    async def list_docs():
        items = await db.haccp_docs.find({}, NO_ID).sort("created_at", -1).to_list(200)
        for it in items:
            it["statut"] = doc_status(it)
        return {"items": items}

    @r.post("/documents")
    async def add_doc(body: DocIn):
        doc = body.model_dump()
        doc.update({"id": str(uuid.uuid4()), "created_at": now_iso()})
        await db.haccp_docs.insert_one(dict(doc))
        doc["statut"] = doc_status(doc)
        return doc

    @r.delete("/documents/{item_id}")
    async def del_doc(item_id: str):
        await db.haccp_docs.delete_one({"id": item_id})
        return {"ok": True}

    # ---------- Vue d'ensemble ----------
    @r.get("/overview")
    async def overview():
        traces = await db.haccp_trace.find({}, NO_ID).to_list(300)
        dlc_alertes = sum(1 for t in traces if trace_status(t) in ("expire", "bientot"))
        nc_ouvertes = await db.haccp_nc.count_documents({"statut": "ouverte"})
        docs = await db.haccp_docs.find({}, NO_ID).to_list(200)
        docs_alertes = sum(1 for d in docs if doc_status(d) in ("expire", "bientot"))
        start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        temp_nc = await db.haccp_temp.count_documents({"conforme": False, "created_at": {"$gte": start}})
        return {"dlc_alertes": dlc_alertes, "nc_ouvertes": nc_ouvertes,
                "docs_alertes": docs_alertes, "temp_non_conformes_jour": temp_nc}

    return r
