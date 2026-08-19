// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { Printer, FileText, FileDown } from "lucide-react";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api/haccp";
const get = (path) => fetch(`${API}${path}`).then((r) => r.json());
const dmy = (s) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");
const hm = (s) => (s ? s.slice(11, 16) : "");

// Pré-remplissage : transforme les relevés déjà saisis en lignes de tableau
const FILLERS = {
  temp: async () => {
    const [eq, tp] = await Promise.all([get("/equipements"), get("/temperatures")]);
    const cibles = Object.fromEntries((eq.items || []).map((e) => [e.id, `${e.min} à ${e.max}`]));
    return (tp.items || []).slice(0, 22).reverse().map((t) => [
      dmy(t.created_at), hm(t.created_at), t.equipement || "", `${t.valeur}`, cibles[t.equipement_id] || "", t.releve_par || "",
    ]);
  },
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

const SHEETS = [
  {
    id: "temp",
    titre: "Feuille de prise de température",
    sous: "Frigos · Congélateurs · Chambres froides",
    colonnes: ["Date", "Heure", "Équipement", "T° relevée (°C)", "T° cible (°C)", "Signature"],
    lignes: 18,
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

function buildSheetHtml(sheet, filledRows = []) {
  const ths = sheet.colonnes.map((c) => `<th>${c}</th>`).join("");
  const esc = (v) => String(v ?? "").replace(/</g, "&lt;");
  const filled = filledRows.map((r) => `<tr>${sheet.colonnes.map((_, i) => `<td>${esc(r[i]) || "&nbsp;"}</td>`).join("")}</tr>`).join("");
  const tds = sheet.colonnes.map(() => "<td>&nbsp;</td>").join("");
  const blanks = Math.max(4, sheet.lignes - filledRows.length);
  const rows = filled + Array.from({ length: blanks }, () => `<tr>${tds}</tr>`).join("");
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>${sheet.titre}</title>
<style>
  @page { size: A4 ${sheet.paysage ? "landscape" : "portrait"}; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; margin: 0; font-size: 11px; }
  h1 { font-size: 16px; margin: 0 0 2px; text-transform: uppercase; letter-spacing: 0.5px; }
  .sous { font-size: 11px; color: #333; margin: 0 0 10px; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 11px; }
  .meta span { display: inline-block; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #000; padding: 6px 5px; text-align: left; }
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
  <h1>${sheet.titre}</h1>
  <p class="sous">${sheet.sous} — Document HACCP</p>
  <div class="meta">
    <span>Établissement : ______________________________</span>
    <span>Semaine du : ____ / ____ / ________</span>
  </div>
  <table>
    <thead><tr>${ths}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="remarques">
    <b>Remarques / Actions correctives</b>
    <div class="zone"></div>
  </div>
  <div class="sign">
    <span>Date : ____ / ____ / ________</span>
    <span>Signature du responsable : ______________________</span>
  </div>
  <div class="footer">© 2026 SIRIUS Assistant – Daniel Partel</div>
  <script>window.onload = () => setTimeout(() => window.print(), 250);</script>
</body>
</html>`;
}

export async function printSheet(sheet, prefill = false) {
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) return;
  let rows = [];
  if (prefill && FILLERS[sheet.id]) {
    try { rows = await FILLERS[sheet.id](); } catch { rows = []; }
  }
  w.document.write(buildSheetHtml(sheet, rows));
  w.document.close();
}

export default function SectionSheets() {
  return (
    <div className="hc-section" data-testid="haccp-sheets-section">
      <p className="hc-sheets-intro">
        Modèles de feuilles HACCP prêts à imprimer (ou à enregistrer en PDF via la boîte d&apos;impression du navigateur).
        Les feuilles marquées d&apos;un point doré peuvent être pré-remplies avec vos relevés déjà saisis.
      </p>
      <div className="hc-sheets-grid">
        {SHEETS.map((s) => (
          <div className="hc-sheet-card" key={s.id} data-testid={`haccp-sheet-${s.id}`}>
            <FileText size={16} />
            <div className="hc-sheet-info">
              <b>{s.titre}{FILLERS[s.id] && <i className="hc-sheet-filldot" title="Pré-remplissage disponible" />}</b>
              <span>{s.sous}</span>
            </div>
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
