// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { Printer, FileText, FileDown } from "lucide-react";
import { useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { escapeDocumentText } from "./haccpDocuments";
import HaccpSheetEditor from "./HaccpSheetEditor";

const API = `${API_BASE_URL}/haccp`;
const get = async (path) => {
  const response = await fetch(`${API}${path}`, { credentials: "include" });
  if (!response.ok) throw new Error(`Chargement des relevés refusé (${response.status}). Aucune feuille pré-remplie n'a été produite.`);
  const data = await response.json();
  if (!Array.isArray(data.items)) throw new Error("Liste de relevés invalide. Impression annulée.");
  return data;
};
const dmy = (s) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");
const hm = (s) => (s ? s.slice(11, 16) : "");

export function temperatureSheetKind(equipment) {
  if (["chambre_froide_positive", "chambre_froide_negative"].includes(equipment.type)) return "chambre_froide";
  if (["frigo", "congelateur"].includes(equipment.type) && /chambre\s+froide/i.test(equipment.nom)) return "chambre_froide";
  return equipment.type;
}

export async function loadTemperatureSheetRows(kind) {
  const [eq, tp] = await Promise.all([get("/equipements"), get("/temperatures")]);
  const selected = new Map(eq.items.filter((equipment) => !kind || temperatureSheetKind(equipment) === kind)
    .map((equipment) => [equipment.id, equipment]));
  return tp.items.filter((reading) => !kind || selected.has(reading.equipement_id)).slice(0, 22).reverse().map((reading) => {
    const equipment = selected.get(reading.equipement_id);
    return [dmy(reading.created_at), hm(reading.created_at), equipment?.nom || reading.equipement || "",
      `${reading.valeur}`, equipment ? `${equipment.min} à ${equipment.max}` : "", reading.releve_par || "", ...(kind ? [""] : [])];
  });
}

// Pré-remplissage : transforme les relevés déjà saisis en lignes de tableau
const FILLERS = {
  temp: () => loadTemperatureSheetRows(),
  frigo: () => loadTemperatureSheetRows("frigo"),
  congelateur: () => loadTemperatureSheetRows("congelateur"),
  chambre_froide: () => loadTemperatureSheetRows("chambre_froide"),
  reception: async () => {
    const d = await get("/trace");
    return (d.items || []).slice(0, 18).reverse().map((t) => [
      dmy(t.date_reception || t.created_at), t.fournisseur || "", t.produit || "",
      t.temperature_reception != null ? `${t.temperature_reception}` : "", dmy(t.dlc), "", "", "",
    ]);
  },
  trace: async () => {
    const d = await get("/trace");
    return (d.items || []).slice(0, 16).reverse().map((t) => [
      dmy(t.date_reception || t.created_at), t.produit || "", "", t.lot || "", t.fournisseur || "", dmy(t.dlc), "",
    ]);
  },
  dlc: async () => {
    const d = await get("/trace");
    const etat = { expire: "Expiré", bientot: "À surveiller", ok: "OK" };
    return (d.items || []).filter((t) => t.dlc).slice(0, 20).reverse().map((t) => [
      dmy(t.date_reception || t.created_at), t.produit || "", dmy(t.dlc), etat[t.statut] || "", "", "", "",
    ]);
  },
  nettoyage: async () => {
    const d = await get("/nettoyage/taches");
    return (d.items || []).slice(0, 20).map((t) => [
      t.zone || "", t.produit || "", t.frequence || "", t.responsable || "", "", "",
    ]);
  },
};

export const SHEETS = [
  {
    id: "temp",
    titre: "Feuille de prise de température",
    sous: "Frigos · Congélateurs · Chambres froides",
    colonnes: ["Date", "Heure", "Équipement", "T° relevée (°C)", "T° cible (°C)", "Signature"],
    lignes: 18,
  },
  ...[["frigo", "Feuille de température des réfrigérateurs", "Frigos / froid positif"],
    ["congelateur", "Feuille de température des congélateurs", "Congélateurs / froid négatif"],
    ["chambre_froide", "Feuille de température des chambres froides", "Chambres froides positives et négatives"]].map(([id, titre, sous]) => ({
    id, titre, sous, colonnes: ["Date", "Heure", "Équipement", "T° relevée (°C)", "Plage cible (°C)", "Relevé par / visa", "Anomalie / action corrective"],
    lignes: 18, paysage: true,
    note: "Renseigner la plage adaptée aux produits et au plan de maîtrise sanitaire. Le pré-remplissage reprend au maximum 22 relevés de la liste chargée, filtrés par équipement ; il ne constitue pas un historique complet. Les heures pré-remplies sont celles de l'enregistrement serveur (UTC), pas nécessairement l'heure locale du relevé.",
  })),
  {
    id: "epicerie", titre: "Feuille de stockage épicerie et conserves",
    sous: "Réserve sèche · Épicerie · Conserves",
    colonnes: ["Date", "Produit / fournisseur", "Lot", "DLC / DDM", "Mouvement entrée / sortie", "Quantité / unité", "Emplacement", "État emballage / observation", "Visa"],
    lignes: 14, paysage: true,
    note: "Reprendre les dates et conditions de conservation du fournisseur. Distinguer DLC et DDM, suivre la rotation des lots et les anomalies selon vos procédures. Cette feuille vierge ne calcule pas un stock réel.",
  },
  {
    id: "boitage", titre: "Feuille de mise en boîte des préparations",
    sous: "Conditionnement et traçabilité des préparations",
    colonnes: ["Date / heure", "Préparation", "Lot / origine", "Contenant / quantité", "Date d'ouverture / préparation", "Date limite validée / référence", "Conditions / emplacement de conservation", "Opérateur / visa"],
    lignes: 14, paysage: true,
    note: "La mise en boîte n'est pas une stérilisation et ne prolonge pas une DLC. Renseigner uniquement les limites et conditions validées dans vos procédures et conserver la traçabilité des produits d'origine. Aucun barème de conservation ni procédé de mise en conserve n'est fourni par ce modèle.",
  },
  {
    id: "cuisson",
    titre: "Feuille de contrôle des cuissons",
    sous: "Température à cœur des produits",
    colonnes: ["Date", "Produit", "T° à cœur (°C)", "Durée", "Conforme (Oui/Non)", "Signature"],
    lignes: 16,
  },
  {
    id: "refroidissement",
    titre: "Feuille de refroidissement rapide",
    sous: "De +63 °C à +10 °C en moins de 2 heures",
    colonnes: ["Date", "Plat", "Heure fin cuisson", "T° à 2 h (°C)", "T° à 4 h (°C)", "Conforme (Oui/Non)", "Signature"],
    lignes: 14,
  },
  {
    id: "remise",
    titre: "Feuille de remise en température",
    sous: "De +10 °C à +63 °C en moins d'une heure",
    colonnes: ["Date", "Plat", "T° initiale (°C)", "T° finale (°C)", "Durée", "Conforme (Oui/Non)", "Signature"],
    lignes: 14,
  },
  {
    id: "reception",
    titre: "Feuille de réception des marchandises",
    sous: "Contrôle à la livraison",
    colonnes: ["Date", "Fournisseur", "Produit", "T° (°C)", "DLC", "État emballage", "Conforme (Oui/Non)", "Signature"],
    lignes: 14,
    paysage: true,
  },
  {
    id: "huiles",
    titre: "Feuille de contrôle des huiles de friture",
    sous: "Qualité et renouvellement des bains de friture",
    colonnes: ["Date", "État de l'huile", "Couleur", "Odeur", "Filtration (Oui/Non)", "Changement (Oui/Non)", "Signature"],
    lignes: 14,
  },
  {
    id: "nettoyage",
    titre: "Plan de nettoyage et désinfection",
    sous: "Zones, produits et fréquences",
    colonnes: ["Zone", "Produit utilisé", "Fréquence", "Responsable", "Date", "Signature"],
    lignes: 16,
  },
  {
    id: "trace",
    titre: "Feuille de traçabilité des plats",
    sous: "Production et origine des ingrédients",
    colonnes: ["Date de production", "Plat", "Ingrédients", "N° de lot", "Fournisseur", "DLC", "Signature"],
    lignes: 12,
    paysage: true,
  },
  {
    id: "dlc",
    titre: "Feuille de gestion des DLC / DDM",
    sous: "Rotation et retrait des produits",
    colonnes: ["Date", "Produit", "DLC / DDM", "État", "Rotation (Oui/Non)", "Retrait (Oui/Non)", "Signature"],
    lignes: 16,
  },
  {
    id: "maintenance",
    titre: "Feuille de maintenance des équipements",
    sous: "Entretien préventif et curatif",
    colonnes: ["Date", "Équipement", "Type de maintenance", "État", "Signature"],
    lignes: 16,
  },
];

export function buildSheetHtml(sheet, filledRows = [], metadata) {
  const esc = escapeDocumentText;
  const ths = sheet.colonnes.map((c) => `<th>${esc(c)}</th>`).join("");
  const filled = filledRows.map((r) => `<tr>${sheet.colonnes.map((_, i) => `<td>${esc(r[i]).replace(/\n/g, "<br>") || "&nbsp;"}</td>`).join("")}</tr>`).join("");
  const tds = sheet.colonnes.map(() => "<td>&nbsp;</td>").join("");
  const blanks = metadata ? 0 : Math.max(4, sheet.lignes - filledRows.length);
  const rows = filled + Array.from({ length: blanks }, () => `<tr>${tds}</tr>`).join("");
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>${esc(sheet.titre)}</title>
<style>
  @page { size: A4 ${sheet.paysage ? "landscape" : "portrait"}; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; margin: 0; font-size: 11px; }
  h1 { font-size: 16px; margin: 0 0 2px; text-transform: uppercase; letter-spacing: 0.5px; }
  .sous { font-size: 11px; color: #333; margin: 0 0 10px; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 11px; }
  .meta span { display: inline-block; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #000; padding: 6px 5px; text-align: left; overflow-wrap: anywhere; }
  thead { display: table-header-group; } tr { break-inside: avoid; }
  th { background: #f0f0f0; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; }
  td { height: 22px; }
  .remarques { margin-top: 12px; }
  .remarques b { font-size: 11px; text-transform: uppercase; }
  .remarques .zone { border: 1px solid #000; height: 52px; margin-top: 4px; }
  .sign { display: flex; justify-content: space-between; margin-top: 14px; font-size: 11px; }
  .sign span { display: inline-block; min-width: 40%; }
  .footer { margin-top: 10px; font-size: 8px; color: #555; text-align: right; }
</style>
</head>
<body>
  <h1>${esc(sheet.titre)}</h1>
  <p class="sous">${esc(sheet.sous)} — Document HACCP</p>
  ${sheet.note ? `<p>${esc(sheet.note)}</p>` : ""}
  <div class="meta">
    <span>Établissement : ${metadata ? esc(metadata.etablissement) : "______________________________"}</span>
    <span>Période / semaine : ${metadata ? esc(metadata.periode || "À compléter") : "____ / ____ / ________"}</span>
  </div>
  ${metadata ? `<p>Équipement / zone : ${esc(metadata.equipement || "À compléter")} · Plage cible / consigne : ${esc(metadata.cible || "À compléter")}<br>
Responsable : ${esc(metadata.responsable || "À compléter")}<br>Version : ${esc(metadata.id)} · ${dmy(metadata.created_at)}</p>` : ""}
  <table>
    <thead><tr>${ths}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="remarques">
    <b>Remarques / Actions correctives</b>
    ${metadata ? `<p>${esc(metadata.remarques || "À compléter").replace(/\n/g, "<br>")}</p>` : ""}
    <div class="zone"></div>
  </div>
  <div class="sign">
    <span>Date : ____ / ____ / ________</span>
    <span>Signature du responsable : ______________________</span>
  </div>
  <div class="footer">© 2026 ΣIRIUS Assistant – Daniel Partel</div>
  ${metadata ? "" : "<script>window.onload = () => setTimeout(() => window.print(), 250);</script>"}
</body>
</html>`;
}

export async function printSheet(sheet, prefill = false) {
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) {
    window.dispatchEvent(new CustomEvent("haccp-error", { detail: "Fenêtre d'impression bloquée. Autorisez les fenêtres de SIRIUS puis réessayez." }));
    return false;
  }
  try {
    if (prefill && !FILLERS[sheet.id]) throw new Error("Pré-remplissage indisponible pour cette feuille.");
    const rows = prefill ? await FILLERS[sheet.id]() : [];
    w.document.write(buildSheetHtml(sheet, rows));
    w.document.close();
    return true;
  } catch (error) {
    w.close();
    window.dispatchEvent(new CustomEvent("haccp-error", { detail: error.message || "Pré-remplissage impossible ; aucune feuille n'a été imprimée." }));
    return false;
  }
}

export default function SectionSheets({ onDirtyChange }) {
  const [editing, setEditing] = useState(null);
  if (editing) return <HaccpSheetEditor key={editing.id} sheet={editing} onBack={() => setEditing(null)}
    onDirtyChange={onDirtyChange} loadRows={FILLERS[editing.id]} renderHtml={buildSheetHtml} />;
  return (
    <div className="hc-section" data-testid="haccp-sheets-section">
      <p className="hc-sheets-intro">
        Modèles de feuilles HACCP prêts à imprimer (ou à enregistrer en PDF via la boîte d&apos;impression du navigateur).
        Les feuilles marquées d&apos;un point doré peuvent être pré-remplies avec vos relevés déjà saisis.
        Les modèles réfrigérateurs, congélateurs et chambres froides sont distincts ; le stockage épicerie/conserves
        et la mise en boîte disposent chacun d&apos;une feuille modifiable à l&apos;écran.
        « MODIFIER / REMPLIR » ouvre les cases, permet d&apos;ajouter des lignes et de conserver les versions.
      </p>
      <div className="hc-sheets-grid">
        {SHEETS.map((s) => (
          <div className="hc-sheet-card" key={s.id} data-testid={`haccp-sheet-${s.id}`}>
            <FileText size={16} />
            <div className="hc-sheet-info">
              <b>{s.titre}{FILLERS[s.id] && <i className="hc-sheet-filldot" title="Pré-remplissage disponible" />}</b>
              <span>{s.sous}</span>
            </div>
            <button className="hc-sheet-print" onClick={() => setEditing(s)} data-testid={`haccp-sheet-edit-${s.id}`}>
              MODIFIER / REMPLIR
            </button>
            {FILLERS[s.id] && (
              <button className="hc-sheet-print gold" onClick={() => printSheet(s, true)} data-testid={`haccp-sheet-fill-${s.id}`}>
                <FileDown size={12} /> PRÉ-REMPLIE
              </button>
            )}
            <button className="hc-sheet-print" onClick={() => printSheet(s, false)} data-testid={`haccp-sheet-print-${s.id}`}>
              <Printer size={12} /> VIERGE
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
