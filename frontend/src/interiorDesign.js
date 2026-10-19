// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// PLANS — mode INTÉRIEUR : ambiances, métrés de finition, budget et fiche projet.
// Logique pure (aucun accès réseau) : testable et partagée par FloorPlan.jsx.

export const INTERIOR_STORAGE_KEY = "sirius_interior";

export const AMBIANCES = [
  {
    id: "japandi", nom: "Japandi", accroche: "Sérénité, bois clair et lignes basses",
    palette: { murs: "#EDE6DB", accent: "#3E4A3D", sol: "#C8A97E", bois: "#A7825A", textile: "#D9CBB5", metal: "#2B2B2B" },
    sol: { nom: "Parquet chêne naturel", prix: [45, 75] }, peinture: [14, 24], kelvin: 2700,
    matieres: ["Chêne", "Lin lavé", "Céramique mate", "Papier washi"],
    conseils: ["Peu d'objets, tous utiles.", "Mobilier bas et rangements fermés.", "Touches de vert sauge."],
  },
  {
    id: "scandinave", nom: "Scandinave", accroche: "Lumineux, doux et chaleureux",
    palette: { murs: "#F4F2EE", accent: "#8FA9B8", sol: "#E2D3BC", bois: "#D2B48C", textile: "#E9E4DA", metal: "#B9B9B9" },
    sol: { nom: "Chêne blanchi", prix: [40, 65] }, peinture: [12, 22], kelvin: 3000,
    matieres: ["Bouleau", "Laine bouclée", "Coton", "Rotin"],
    conseils: ["Maximiser la lumière naturelle.", "Textiles superposés pour la chaleur.", "Bleu poudré en accent."],
  },
  {
    id: "industriel", nom: "Industriel", accroche: "Brut, graphique et caractère d'atelier",
    palette: { murs: "#CFCBC5", accent: "#B5532F", sol: "#8E8C88", bois: "#6B4A33", textile: "#5A5550", metal: "#1E1E1E" },
    sol: { nom: "Béton ciré", prix: [70, 120] }, peinture: [15, 28], kelvin: 3000,
    matieres: ["Acier noir", "Brique", "Cuir vieilli", "Bois recyclé"],
    conseils: ["Verrière atelier pour séparer sans fermer.", "Suspensions métal au-dessus des tables.", "Rouille en accent."],
  },
  {
    id: "contemporain", nom: "Contemporain", accroche: "Épuré, précis et élégant",
    palette: { murs: "#F2F2F0", accent: "#1F3A5F", sol: "#BDB8B1", bois: "#8C735A", textile: "#D7D4CF", metal: "#C9A86A" },
    sol: { nom: "Grès cérame grand format", prix: [45, 90] }, peinture: [16, 30], kelvin: 3000,
    matieres: ["Laque mate", "Laiton brossé", "Verre fumé", "Velours"],
    conseils: ["Grands aplats et rangements intégrés.", "Bleu nuit sur un mur d'accent.", "Laiton en petites touches."],
  },
  {
    id: "mediterraneen", nom: "Méditerranéen", accroche: "Chaux, soleil et terre cuite",
    palette: { murs: "#F6EFE3", accent: "#C46A3F", sol: "#B8643F", bois: "#9A7350", textile: "#EADCC3", metal: "#5E4B3C" },
    sol: { nom: "Tomettes terre cuite", prix: [50, 95] }, peinture: [18, 32], kelvin: 2700,
    matieres: ["Enduit à la chaux", "Terre cuite", "Osier", "Lin brut"],
    conseils: ["Murs à la chaux pour la matière.", "Formes arrondies et niches.", "Terracotta et olivier."],
  },
  {
    id: "artdeco", nom: "Art déco", accroche: "Géométrie, laiton et profondeur",
    palette: { murs: "#E9E1D3", accent: "#1E4D3A", sol: "#9C6B43", bois: "#5C3A21", textile: "#2F4F45", metal: "#C9A227" },
    sol: { nom: "Parquet point de Hongrie", prix: [80, 140] }, peinture: [18, 34], kelvin: 2700,
    matieres: ["Velours émeraude", "Laiton", "Marbre", "Noyer"],
    conseils: ["Motifs géométriques et arrondis.", "Velours profond sur l'assise.", "Miroirs et laiton pour la lumière."],
  },
];

export const PHOTO_AMBIANCE_ID = "photo";

const WET_ROOM = /(salle\s*(de\s*)?bains?|salle\s*d'eau|\bsdb\b|\bwc\b|toilettes?|douche|buanderie|cellier)/i;
const LUX_RULES = [
  [/(bureau|atelier|cuisine|kitchenette|garage)/i, 400, "travail"],
  [/(salle\s*(de\s*)?bains?|salle\s*d'eau|douche)/i, 300, "salle d'eau"],
  [/(s[ée]jour|salon|living|salle\s*[àa]\s*manger|pi[eè]ce\s*de\s*vie)/i, 250, "séjour"],
  [/(chambre|dressing)/i, 150, "repos"],
  [/(couloir|entr[ée]e|d[ée]gagement|hall|wc|toilettes)/i, 120, "passage"],
];
const OPENING_HEIGHT = { porte: 2.04, fenetre: 1.25, passage: 2.1, porte_garage: 2.0 };
const LITERS_PER_M2 = 1 / 10;
const POT_LITERS = 2.5;
const SKIRTING_EUR = [6, 14];
const LIGHT_EUR_PER_1000_LM = [25, 60];
const WET_FLOOR = { nom: "Carrelage antidérapant", prix: [35, 70] };

const round = (value, step = 0.1) => Math.round(value / step) * step;
const num = (value) => Number((Number(value) || 0).toFixed(2));

export function findAmbiance(id, photoPalette = null) {
  if (id === PHOTO_AMBIANCE_ID && photoPalette) return photoAmbiance(photoPalette);
  return AMBIANCES.find((item) => item.id === id) || AMBIANCES[0];
}

export function isWetRoom(name) {
  return WET_ROOM.test(name || "");
}

export function roomLighting(name) {
  const rule = LUX_RULES.find(([pattern]) => pattern.test(name || ""));
  return rule ? { lux: rule[1], usage: rule[2] } : { lux: 200, usage: "polyvalent" };
}

function hexToRgb(hex) {
  const value = parseInt(String(hex).slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function saturation(hex) {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

// Palette extraite d'une photo par l'IA → palette d'ambiance cohérente :
// la teinte la plus claire pour les murs, la plus saturée pour l'accent, une teinte médiane pour le sol.
export function photoAmbiance(inspiration) {
  const colors = (inspiration?.palette || []).filter((c) => /^#[0-9A-F]{6}$/i.test(c));
  if (!colors.length) return AMBIANCES[0];
  const byLight = [...colors].sort((a, b) => luminance(b) - luminance(a));
  const murs = byLight[0];
  const rest = colors.filter((c) => c !== murs);
  const accent = [...(rest.length ? rest : colors)].sort((a, b) => saturation(b) - saturation(a))[0];
  const mid = byLight[Math.floor(byLight.length / 2)] || murs;
  const dark = byLight[byLight.length - 1];
  return {
    id: PHOTO_AMBIANCE_ID, nom: inspiration.style || "Ma photo", accroche: "Palette tirée de votre photo",
    palette: { murs, accent, sol: mid, bois: dark, textile: byLight[1] || murs, metal: dark },
    sol: { nom: "Revêtement assorti à la photo", prix: [40, 90] }, peinture: [14, 28], kelvin: 3000,
    matieres: inspiration.matieres?.length ? inspiration.matieres : ["Selon la photo"],
    conseils: inspiration.analyse ? [inspiration.analyse] : [],
  };
}

export function roomOpenings(plan, room) {
  return (plan?.ouvertures || []).filter((op) => op.piece === room.nom);
}

export function computeRoomFinishes(room, plan, { hauteur, couches = 2, ambiance } = {}) {
  const h = Number(hauteur) || Number(room.hauteur) || 2.5;
  const l = Number(room.l) || 0, p = Number(room.p) || 0;
  const coats = Math.min(3, Math.max(1, Math.round(Number(couches) || 2)));
  const style = ambiance || AMBIANCES[0];
  const surface = l * p;
  const perimeter = 2 * (l + p);
  const openings = roomOpenings(plan, room);
  const openingArea = openings.reduce((sum, op) =>
    sum + (Number(op.largeur) || 0) * Math.min(h, OPENING_HEIGHT[op.type] || 2.0), 0);
  const doorWidth = openings.filter((op) => op.type !== "fenetre")
    .reduce((sum, op) => sum + (Number(op.largeur) || 0), 0);
  const walls = Math.max(0, perimeter * h - openingArea);
  const paintLiters = (walls + surface) * coats * LITERS_PER_M2;
  const pots = Math.ceil(paintLiters / POT_LITERS);
  const wet = isWetRoom(room.nom);
  const floor = wet ? WET_FLOOR : style.sol;
  const floorOrder = surface * 1.1;
  const skirting = wet ? 0 : Math.max(0, perimeter - doorWidth) * 1.05;
  const light = roomLighting(room.nom);
  const lumens = Math.round(surface * light.lux / 50) * 50;
  const paintLitersBought = pots * POT_LITERS;
  const budget = [0, 1].map((i) => Math.round(
    paintLitersBought * style.peinture[i]
    + floorOrder * floor.prix[i]
    + skirting * SKIRTING_EUR[i]
    + (lumens / 1000) * LIGHT_EUR_PER_1000_LM[i],
  ));
  return {
    piece: room.nom,
    hauteur: num(h),
    couches: coats,
    surface_sol: num(surface),
    perimetre: num(perimeter),
    murs_nets: num(walls),
    plafond: num(surface),
    peinture_litres: num(round(paintLiters)),
    pots_2_5l: pots,
    sol: { nom: floor.nom, commande_m2: num(round(floorOrder)) },
    plinthes_ml: num(round(skirting)),
    eclairage: { lux: light.lux, usage: light.usage, lumens, kelvin: style.kelvin },
    budget_eur: { min: budget[0], max: budget[1] },
  };
}

export function computeInteriorTotals(finishes) {
  return finishes.reduce((total, f) => ({
    surface_sol: num(total.surface_sol + f.surface_sol),
    murs_nets: num(total.murs_nets + f.murs_nets),
    pots_2_5l: total.pots_2_5l + f.pots_2_5l,
    sol_m2: num(total.sol_m2 + f.sol.commande_m2),
    plinthes_ml: num(total.plinthes_ml + f.plinthes_ml),
    lumens: total.lumens + f.eclairage.lumens,
    budget_min: total.budget_min + f.budget_eur.min,
    budget_max: total.budget_max + f.budget_eur.max,
  }), { surface_sol: 0, murs_nets: 0, pots_2_5l: 0, sol_m2: 0, plinthes_ml: 0, lumens: 0, budget_min: 0, budget_max: 0 });
}

export function planKey(plan) {
  return JSON.stringify((plan?.pieces || []).map((p) => [p.nom, p.x, p.y, p.l, p.p]));
}

export function emptyInterior(plan) {
  const first = plan?.pieces?.[0]?.nom || "";
  return { planKey: planKey(plan), ambiance: AMBIANCES[0].id, piece: first, couches: 2, hauteur: "", pieces: {}, achats: [] };
}

// État intérieur persistant, réinitialisé si le plan change de géométrie.
export function loadInterior(plan, storage = typeof localStorage !== "undefined" ? localStorage : null) {
  try {
    const saved = JSON.parse(storage?.getItem(INTERIOR_STORAGE_KEY) || "null");
    if (saved && saved.planKey === planKey(plan)) {
      const names = (plan?.pieces || []).map((p) => p.nom);
      return { ...emptyInterior(plan), ...saved, piece: names.includes(saved.piece) ? saved.piece : names[0] || "" };
    }
  } catch { /* état illisible : on repart de zéro */ }
  return emptyInterior(plan);
}

export function saveInterior(state, storage = typeof localStorage !== "undefined" ? localStorage : null) {
  try { storage?.setItem(INTERIOR_STORAGE_KEY, JSON.stringify(state)); } catch { /* quota plein : non bloquant */ }
}

export function roomAmbiance(state, roomName) {
  const room = state.pieces?.[roomName] || {};
  const id = room.ambiance || state.ambiance;
  return findAmbiance(id, id === PHOTO_AMBIANCE_ID ? room.inspiration || state.inspiration : null);
}

// Remplace le mobilier dont le centre est dans la pièce par la proposition de l'IA.
export function applyInteriorProposal(plan, roomName, furniture) {
  const room = (plan?.pieces || []).find((p) => p.nom === roomName);
  if (!room) return plan;
  const inside = (m) => {
    const cx = m.x + m.l / 2, cy = m.y + m.p / 2;
    return cx >= room.x && cx <= room.x + room.l && cy >= room.y && cy <= room.y + room.p;
  };
  return { ...plan, mobilier: [...(plan.mobilier || []).filter((m) => !inside(m)), ...(furniture || [])] };
}

export function mergePurchases(current, incoming, roomName) {
  const seen = new Set(current.map((a) => `${a.piece}|${a.article}`.toLowerCase()));
  const added = (incoming || [])
    .filter((a) => !seen.has(`${roomName}|${a.article}`.toLowerCase()))
    .map((a) => ({ ...a, piece: roomName, fait: false }));
  return [...current, ...added];
}

// Détecte la pièce et l'ambiance citées dans une demande (texte ou voix).
export function parseInteriorRequest(text, plan) {
  const low = (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const strip = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const rooms = [...(plan?.pieces || [])].sort((a, b) => b.nom.length - a.nom.length);
  const piece = rooms.find((p) => low.includes(strip(p.nom)))?.nom || "";
  const aliases = { "art deco": "artdeco", "scandi": "scandinave", "medit": "mediterraneen", "moderne": "contemporain", "loft": "industriel", "japonais": "japandi", "zen": "japandi" };
  let ambiance = AMBIANCES.find((a) => low.includes(strip(a.nom)))?.id || "";
  if (!ambiance) ambiance = Object.entries(aliases).find(([alias]) => low.includes(alias))?.[1] || "";
  return { piece, ambiance };
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fr = (value) => String(value).replace(".", ",");
const eur = (value) => `${Math.round(value).toLocaleString("fr-FR")} €`;

export function interiorReportHtml(plan, state, finishes, svgMarkup = "") {
  const totals = computeInteriorTotals(finishes);
  const purchases = state.achats || [];
  const purchaseTotal = purchases.reduce((sum, a) => sum + (a.budget_eur || 0) * (a.quantite || 1), 0);
  const roomsHtml = finishes.map((f) => {
    const style = roomAmbiance(state, f.piece);
    const room = state.pieces?.[f.piece] || {};
    const swatches = Object.values(style.palette).map((c) =>
      `<span class="sw" style="background:${escapeHtml(c)}" title="${escapeHtml(c)}"></span>`).join("");
    return `<section class="room"><h2>${escapeHtml(f.piece)} <small>${escapeHtml(style.nom)}</small></h2>
<div class="swatches">${swatches}</div>
<table><tr><td>Sol</td><td>${fr(f.surface_sol)} m² · ${escapeHtml(f.sol.nom)} (${fr(f.sol.commande_m2)} m² à commander)</td></tr>
<tr><td>Murs nets</td><td>${fr(f.murs_nets)} m² · ${f.pots_2_5l} pot(s) de 2,5 L (${f.couches} couche${f.couches > 1 ? "s" : ""}, plafond inclus)</td></tr>
<tr><td>Plinthes</td><td>${f.plinthes_ml ? `${fr(f.plinthes_ml)} ml` : "Plinthes carrelées"}</td></tr>
<tr><td>Éclairage</td><td>${f.eclairage.lumens.toLocaleString("fr-FR")} lm · ${f.eclairage.kelvin} K</td></tr>
<tr><td>Budget finitions</td><td>${eur(f.budget_eur.min)} – ${eur(f.budget_eur.max)}</td></tr></table>
${room.conseils?.length ? `<ul>${room.conseils.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>` : ""}
${room.notes ? `<p class="notes">${escapeHtml(room.notes)}</p>` : ""}</section>`;
  }).join("");
  const purchasesHtml = purchases.length ? `<section><h2>Liste d'achats</h2><table>${purchases.map((a) =>
    `<tr><td>${a.fait ? "✔" : "☐"}</td><td>${escapeHtml(a.article)}${a.piece ? ` <small>(${escapeHtml(a.piece)})</small>` : ""}</td><td>× ${a.quantite || 1}</td><td>${eur((a.budget_eur || 0) * (a.quantite || 1))}</td></tr>`).join("")}
<tr class="total"><td></td><td>Total indicatif</td><td></td><td>${eur(purchaseTotal)}</td></tr></table></section>` : "";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(plan?.titre || "Projet intérieur")} — ΣIRIUS</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;margin:32px auto;max-width:900px;color:#1d2730;padding:0 18px}
h1{font-weight:300;letter-spacing:.08em;border-bottom:2px solid #1f3a5f;padding-bottom:8px}h2{font-weight:500;margin:26px 0 8px}h2 small{font-weight:300;color:#667}
.swatches{display:flex;gap:6px;margin:6px 0 10px}.sw{width:34px;height:34px;border-radius:8px;border:1px solid #0002}
table{width:100%;border-collapse:collapse}td{padding:6px 8px;border-bottom:1px solid #e5e7ea;vertical-align:top}td:first-child{color:#556;width:160px}
.total td{font-weight:600}.notes{background:#f5f2ea;padding:10px;border-radius:8px}.plan svg{max-width:100%;height:auto}
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.summary div{background:#f3f5f8;border-radius:10px;padding:10px}.summary b{display:block;font-size:1.25em}
footer{margin-top:30px;color:#889;font-size:.85em}@media print{body{margin:0}}</style></head><body>
<h1>${escapeHtml(plan?.titre || "Projet intérieur")}</h1>
<div class="summary"><div><b>${fr(totals.surface_sol)} m²</b>surface</div><div><b>${totals.pots_2_5l}</b>pots de peinture</div><div><b>${fr(totals.sol_m2)} m²</b>de sol</div><div><b>${eur(totals.budget_min)} – ${eur(totals.budget_max)}</b>finitions</div></div>
${svgMarkup ? `<div class="plan">${svgMarkup}</div>` : ""}
${roomsHtml}${purchasesHtml}
<footer>Fiche générée par ΣIRIUS — métrés et budgets indicatifs, à confirmer avec vos artisans et fournisseurs.</footer></body></html>`;
}
