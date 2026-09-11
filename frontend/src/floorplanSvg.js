// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Rendu 2D des plans PLANS# : moteur unique thémable.
// Thème "couleur" : style HUD ΣIRIUS (fond sombre, dalles bleutées, murs cyan, symboles néon).
// Thème "pro"     : dessin d'architecte (papier clair, murs pochés noirs).
// Dans les deux cas : symboles normalisés (portes en arc, fenêtres triple trait,
// douche/WC/lavabo/lit/canapé/cuisine…), cotations en chaîne, flèche nord, cartouche.
// Module pur (chaîne SVG) : utilisé par le HUD React ET par les pages de démo.

const S = 100;          // 1 m = 100 unités SVG
const W = 0.15;         // épaisseur de mur (m)
const H = W / 2;

export const THEMES = {
  couleur: {
    paper: "#061422",          // fond de la feuille
    floor: "rgba(30, 90, 140, 0.30)", // dalle des pièces
    wall: "#bfe9ff",           // murs
    ink: "#dff4ff",            // texte principal (noms de pièces)
    inkSoft: "#7fc4e8",        // texte secondaire (surfaces)
    symbol: "#8fd6f5",         // traits des symboles mobilier
    symbolFill: "rgba(20, 60, 95, 0.55)",  // fond des symboles
    door: "#ffd27f",           // portes / garage
    window: "#6fe3ff",         // fenêtres
    dim: "#ff8d7a",            // cotations
    dimText: "#ffb5a6",
    opLabel: "#ffe9b0",        // largeurs d'ouvertures
    grid: "rgba(80, 170, 230, 0.10)",
    cartouche: "rgba(8, 30, 50, 0.85)",
    cartoucheLine: "#4fd0ff",
    north: "#9fe4ff",
    halo: "rgba(6, 20, 34, 0.9)",  // halo derrière les textes
    tech: "#b8ff9e",               // symboles électriques
    techWater: "#7fb8ff",          // symboles plomberie / VMC
  },
  pro: {
    paper: "#fbfaf4",
    floor: "#ffffff",
    wall: "#161616",
    ink: "#161616",
    inkSoft: "#5a5a5a",
    symbol: "#3d3d3d",
    symbolFill: "#ffffff",
    door: "#161616",
    window: "#161616",
    dim: "#8a1f1f",
    dimText: "#8a1f1f",
    opLabel: "#1f5f8b",
    grid: "rgba(0, 0, 0, 0.05)",
    cartouche: "#ffffff",
    cartoucheLine: "#161616",
    north: "#161616",
    halo: "#ffffff",
    tech: "#1c7a1c",
    techWater: "#1f5f8b",
  },
};

const fmt = (v) => v.toFixed(2).replace(".", ",");
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const line = (x1, y1, x2, y2, stroke, sw, extra = "") =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" ${extra}/>`;
const rect = (x, y, w, h, attrs) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${attrs}/>`;
const text = (x, y, size, fill, t, extra = "") =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-family="Segoe UI, Arial, sans-serif" ${extra}>${esc(t)}</text>`;

function bounds(plan) {
  const xs = plan.pieces.flatMap((p) => [p.x, p.x + p.l]);
  const ys = plan.pieces.flatMap((p) => [p.y, p.y + p.p]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function openingSpan(op, r) {
  const { x, y, l, p } = r, { position: pos, largeur: w } = op;
  if (op.mur === "nord") return { x1: x + pos, y1: y, x2: x + pos + w, y2: y, h: true, into: 1 };
  if (op.mur === "sud") return { x1: x + pos, y1: y + p, x2: x + pos + w, y2: y + p, h: true, into: -1 };
  if (op.mur === "ouest") return { x1: x, y1: y + pos, x2: x, y2: y + pos + w, h: false, into: 1 };
  return { x1: x + l, y1: y + pos, x2: x + l, y2: y + pos + w, h: false, into: -1 };
}

// ---- symboles de mobilier / équipement (traits fins, reconnaissables) ----
function furnitureSymbol(m, T) {
  const n = (m.nom || "").toLowerCase();
  const x = m.x * S, y = m.y * S, w = m.l * S, h = m.p * S;
  const cx = x + w / 2, cy = y + h / 2;
  const st = `fill="none" stroke="${T.symbol}" stroke-width="2"`;
  const stF = `fill="${T.symbolFill}" stroke="${T.symbol}" stroke-width="2"`;
  let inner = "";
  if (/wc|toilet/.test(n)) {
    inner = rect(x, y, w, h * 0.35, stF) +
      `<ellipse cx="${cx}" cy="${y + h * 0.65}" rx="${w * 0.42}" ry="${h * 0.33}" ${stF}/>`;
  } else if (/douche/.test(n)) {
    inner = rect(x, y, w, h, stF) + line(x, y, x + w, y + h, T.symbol, 1.5) +
      line(x + w, y, x, y + h, T.symbol, 1.5) + `<circle cx="${cx}" cy="${cy}" r="5" ${st}/>`;
  } else if (/baignoire/.test(n)) {
    inner = rect(x, y, w, h, stF) +
      `<rect x="${x + 8}" y="${y + 8}" width="${w - 16}" height="${h - 16}" rx="${Math.min(w, h) * 0.28}" ${st}/>` +
      `<circle cx="${x + w * 0.18}" cy="${cy}" r="4" ${st}/>`;
  } else if (/lavabo|evier|évier|vasque/.test(n)) {
    inner = rect(x, y, w, h, stF) +
      `<ellipse cx="${cx}" cy="${cy}" rx="${w * 0.32}" ry="${h * 0.3}" ${st}/>` +
      `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${T.symbol}"/>`;
  } else if (/lit/.test(n)) {
    const head = Math.min(w, h) * 0.22;
    const vertical = h >= w;
    inner = rect(x, y, w, h, stF) +
      (vertical ? rect(x + 4, y + 4, w - 8, head, st) : rect(x + 4, y + 4, head, h - 8, st)) +
      (vertical ? line(x, y + head + 10, x + w, y + head + 10, T.symbol, 1.5)
                : line(x + head + 10, y, x + head + 10, y + h, T.symbol, 1.5));
  } else if (/canap|sofa/.test(n)) {
    const b = Math.min(w, h) * 0.22;
    inner = rect(x, y, w, h, stF) +
      (h >= w ? rect(x, y, b, h, st) : rect(x, y, w, b, st)) +
      (h >= w ? rect(x, y, w, b, st) + rect(x, y + h - b, w, b, st)
              : rect(x, y, b, h, st) + rect(x + w - b, y, b, h, st));
  } else if (/cuisini|plaque|feux/.test(n)) {
    const r = Math.min(w, h) * 0.18;
    inner = rect(x, y, w, h, stF) +
      [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]]
        .map(([fx, fy]) => `<circle cx="${x + w * fx}" cy="${y + h * fy}" r="${r}" ${st}/>`).join("");
  } else if (/frigo|réfrig|refrig/.test(n)) {
    inner = rect(x, y, w, h, stF) + line(x, y, x + w, y + h, T.symbol, 1.5) +
      text(cx, cy + 4, 13, T.symbol, "RF", 'text-anchor="middle"');
  } else if (/plan de travail|meuble|comptoir/.test(n)) {
    inner = rect(x, y, w, h, stF) +
      `<ellipse cx="${x + w * 0.75}" cy="${cy}" rx="${Math.min(w * 0.14, 22)}" ry="${Math.min(h * 0.3, 18)}" ${st}/>`;
  } else if (/table/.test(n)) {
    inner = rect(x, y, w, h, stF) +
      `<rect x="${x + 6}" y="${y + 6}" width="${w - 12}" height="${h - 12}" ${st}/>`;
  } else {
    inner = rect(x, y, w, h, stF);
  }
  const label = /wc|douche|lavabo|evier|évier|frigo|cuisini/.test(n)
    ? "" : text(cx, y + h + 15, 13, T.inkSoft, m.nom, 'text-anchor="middle"');
  return `<g>${inner}${label}</g>`;
}

// ---- symboles techniques (électricité NF C 15-100 stylisée + fluides) ----
const TECH_DEFS = {
  prise:            { c: "elec", label: "prise 16A" },
  prise_20a:        { c: "elec", label: "prise 20A" },
  interrupteur:     { c: "elec", label: "interrupteur" },
  point_lumineux:   { c: "elec", label: "point lumineux (DCL)" },
  radiateur:        { c: "elec", label: "radiateur" },
  tableau_electrique: { c: "elec", label: "tableau électrique" },
  arrivee_eau:      { c: "eau", label: "arrivée d'eau" },
  evacuation_eau:   { c: "eau", label: "évacuation" },
  vmc:              { c: "eau", label: "VMC" },
};

function techSymbol(item, T) {
  const x = item.x * S, y = item.y * S;
  const elec = T.tech, eau = T.techWater;
  const st = (c) => `fill="none" stroke="${c}" stroke-width="2"`;
  switch (item.type) {
    case "prise":
      return `<g><circle cx="${x}" cy="${y}" r="9" ${st(elec)}/>` +
        line(x - 9, y, x - 15, y, elec, 2) + line(x + 9, y, x + 15, y, elec, 2) + `</g>`;
    case "prise_20a":
      return `<g><circle cx="${x}" cy="${y}" r="9" ${st(elec)}/>` +
        line(x - 9, y, x - 15, y, elec, 2) + line(x + 9, y, x + 15, y, elec, 2) +
        text(x, y - 13, 11, elec, "20A", 'text-anchor="middle"') + `</g>`;
    case "interrupteur":
      return `<g><circle cx="${x}" cy="${y}" r="7" ${st(elec)}/>` +
        line(x + 5, y - 5, x + 14, y - 14, elec, 2) + `</g>`;
    case "point_lumineux":
      return `<g><circle cx="${x}" cy="${y}" r="10" ${st(elec)}/>` +
        line(x - 7, y - 7, x + 7, y + 7, elec, 2) + line(x + 7, y - 7, x - 7, y + 7, elec, 2) + `</g>`;
    case "radiateur":
      return `<g>${rect(x - 30, y - 8, 60, 16, st(elec))}` +
        [x - 15, x, x + 15].map((vx) => line(vx, y - 8, vx, y + 8, elec, 1.5)).join("") + `</g>`;
    case "tableau_electrique":
      return `<g>${rect(x - 12, y - 14, 24, 28, st(elec))}` +
        text(x, y + 5, 12, elec, "TE", 'text-anchor="middle" font-weight="700"') + `</g>`;
    case "arrivee_eau":
      return `<g><circle cx="${x}" cy="${y}" r="8" ${st(eau)}/>` +
        `<path d="M ${x} ${y - 4} q 4 4 0 8 q -4 -4 0 -8" fill="${eau}"/></g>`;
    case "evacuation_eau":
      return `<g><circle cx="${x}" cy="${y}" r="8" ${st(eau)}/>` +
        `<path d="M ${x - 4} ${y - 3} L ${x + 4} ${y - 3} L ${x} ${y + 5} Z" fill="${eau}"/></g>`;
    case "vmc":
      return `<g><circle cx="${x}" cy="${y}" r="9" ${st(eau)}/>` +
        `<path d="M ${x} ${y} m -5 0 a 5 5 0 1 1 5 5" ${st(eau)}/>` +
        text(x, y - 13, 10, eau, "VMC", 'text-anchor="middle"') + `</g>`;
    default:
      return "";
  }
}


function chainDims(coords, fixed, horizontal, offset, T) {
  if (coords.length < 2) return "";
  const c = T.dim;
  let out = "";
  const lineAt = fixed + offset;
  const a = coords[0], b = coords[coords.length - 1];
  out += horizontal
    ? line(a * S, lineAt * S, b * S, lineAt * S, c, 1.5)
    : line(lineAt * S, a * S, lineAt * S, b * S, c, 1.5);
  for (const v of coords) {
    out += horizontal
      ? line(v * S, fixed * S, v * S, lineAt * S, c, 1, 'opacity="0.55"') +
        line(v * S - 5, lineAt * S + 5, v * S + 5, lineAt * S - 5, c, 2)
      : line(fixed * S, v * S, lineAt * S, v * S, c, 1, 'opacity="0.55"') +
        line(lineAt * S - 5, v * S + 5, lineAt * S + 5, v * S - 5, c, 2);
  }
  for (let i = 0; i < coords.length - 1; i++) {
    const mid = (coords[i] + coords[i + 1]) / 2, d = coords[i + 1] - coords[i];
    if (d < 0.25) continue;
    out += horizontal
      ? text(mid * S, lineAt * S - 7, 17, T.dimText, fmt(d), 'text-anchor="middle" font-weight="600"')
      : text(lineAt * S - 7, mid * S, 17, T.dimText, fmt(d), `text-anchor="middle" font-weight="600" transform="rotate(-90 ${lineAt * S - 7} ${mid * S})"`);
  }
  return out;
}

export function planToSvg2D(plan, theme = "couleur") {
  const T = THEMES[theme] || THEMES.couleur;
  const b = bounds(plan);
  const rooms = Object.fromEntries(plan.pieces.map((p) => [p.nom, p]));

  // marges : cotations (haut/gauche), cartouche + légende (bas)
  const usedTypes = [...new Set((plan.technique || []).map((t) => t.type))].filter((t) => TECH_DEFS[t]);
  const legendH = usedTypes.length ? usedTypes.length * 0.32 + 0.55 : 0;
  const MT = 1.5, ML = 1.5, MR = 1.0, MB = Math.max(1.7, legendH + 0.3);
  const vb = `${(b.x - ML) * S} ${(b.y - MT) * S} ${(b.w + ML + MR) * S} ${(b.h + MT + MB) * S}`;
  let svg = `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">`;
  svg += rect((b.x - ML) * S, (b.y - MT) * S, (b.w + ML + MR) * S, (b.h + MT + MB) * S, `fill="${T.paper}"`);

  // grille 1 m
  for (let gx = Math.floor(b.x - ML); gx <= Math.ceil(b.x + b.w + MR); gx++)
    svg += line(gx * S, (b.y - MT) * S, gx * S, (b.y + b.h + MB) * S, T.grid, 1);
  for (let gy = Math.floor(b.y - MT); gy <= Math.ceil(b.y + b.h + MB); gy++)
    svg += line((b.x - ML) * S, gy * S, (b.x + b.w + MR) * S, gy * S, T.grid, 1);

  // sols
  for (const p of plan.pieces) svg += rect(p.x * S, p.y * S, p.l * S, p.p * S, `fill="${T.floor}"`);

  // murs pochés : anneau plein par pièce (les murs mitoyens fusionnent)
  for (const p of plan.pieces) {
    const ox = (p.x - H) * S, oy = (p.y - H) * S, ow = (p.l + W) * S, oh = (p.p + W) * S;
    const ix = (p.x + H) * S, iy = (p.y + H) * S, iw = (p.l - W) * S, ih = (p.p - W) * S;
    svg += `<path fill-rule="evenodd" fill="${T.wall}" d="M${ox},${oy} h${ow} v${oh} h${-ow} z M${ix},${iy} h${iw} v${ih} h${-iw} z"/>`;
  }

  // ouvertures : trouée + symbole
  for (const op of plan.ouvertures || []) {
    const r = rooms[op.piece];
    if (!r) continue;
    const s = openingSpan(op, r);
    const g = W * 1.3;
    svg += s.h
      ? rect(s.x1 * S, (s.y1 - g / 2) * S, (s.x2 - s.x1) * S, g * S, `fill="${T.paper}"`)
      : rect((s.x1 - g / 2) * S, s.y1 * S, g * S, (s.y2 - s.y1) * S, `fill="${T.paper}"`);

    const wpx = op.largeur * S;
    if (op.type === "fenetre") {
      for (const off of [-0.05, 0, 0.05]) {
        svg += s.h
          ? line(s.x1 * S, (s.y1 + off) * S, s.x2 * S, (s.y2 + off) * S, T.window, 2)
          : line((s.x1 + off) * S, s.y1 * S, (s.x2 + off) * S, s.y2 * S, T.window, 2);
      }
    } else if (op.type === "porte") {
      if (s.h) {
        const leafY = (s.y1 + s.into * op.largeur) * S;
        svg += line(s.x1 * S, s.y1 * S, s.x1 * S, leafY, T.door, 3);
        svg += `<path d="M ${s.x2 * S} ${s.y2 * S} A ${wpx} ${wpx} 0 0 ${s.into > 0 ? 1 : 0} ${s.x1 * S} ${leafY}" fill="none" stroke="${T.door}" stroke-width="1.5" stroke-dasharray="7 5"/>`;
      } else {
        const leafX = (s.x1 + s.into * op.largeur) * S;
        svg += line(s.x1 * S, s.y1 * S, leafX, s.y1 * S, T.door, 3);
        svg += `<path d="M ${s.x2 * S} ${s.y2 * S} A ${wpx} ${wpx} 0 0 ${s.into > 0 ? 0 : 1} ${leafX} ${s.y1 * S}" fill="none" stroke="${T.door}" stroke-width="1.5" stroke-dasharray="7 5"/>`;
      }
    } else if (op.type === "passage") {
      svg += s.h
        ? line(s.x1 * S, s.y1 * S, s.x2 * S, s.y2 * S, T.door, 2, 'stroke-dasharray="4 6"')
        : line(s.x1 * S, s.y1 * S, s.x2 * S, s.y2 * S, T.door, 2, 'stroke-dasharray="4 6"');
    } else {
      svg += line(s.x1 * S, s.y1 * S, s.x2 * S, s.y2 * S, T.door, 5, 'stroke-dasharray="14 8"');
    }
    // largeur de l'ouverture
    const lx = ((s.x1 + s.x2) / 2 + (s.h ? 0 : 0.24 * (op.mur === "ouest" ? -1 : 1))) * S;
    const ly = ((s.y1 + s.y2) / 2 + (s.h ? 0.26 * (op.mur === "nord" ? -1 : 1.2) : 0)) * S;
    svg += text(lx, ly, 15, T.opLabel, fmt(op.largeur), 'text-anchor="middle" font-style="italic"');
  }

  // mobilier / équipements
  for (const m of plan.mobilier || []) svg += furnitureSymbol(m, T);

  // couche technique : symboles électricité + fluides
  for (const item of plan.technique || []) svg += techSymbol(item, T);

  // étiquettes de pièces (halo : lisibles même sur le mobilier)
  for (const p of plan.pieces) {
    const cx = (p.x + p.l / 2) * S, cy = (p.y + p.p / 2) * S;
    const halo = `paint-order="stroke" stroke="${T.halo}" stroke-width="7"`;
    svg += text(cx, cy - 4, 22, T.ink, p.nom.toUpperCase(), `text-anchor="middle" font-weight="700" letter-spacing="1" ${halo}`);
    svg += text(cx, cy + 18, 16, T.inkSoft, `${fmt(p.l * p.p)} m²`, `text-anchor="middle" ${halo}`);
    // dimensions intérieures + hauteur sous plafond
    svg += text(cx, cy + 38, 13, T.inkSoft, `${fmt(p.l)} × ${fmt(p.p)}${p.hauteur ? ` · hsp ${fmt(p.hauteur)}` : ""}`, `text-anchor="middle" ${halo}`);
  }

  // cotations en chaîne (haut + gauche) et totaux
  const uniq = (arr) => [...new Set(arr.map((v) => Math.round(v * 100) / 100))].sort((a, b2) => a - b2);
  const xs = uniq(plan.pieces.flatMap((p) => [p.x, p.x + p.l]));
  const ys = uniq(plan.pieces.flatMap((p) => [p.y, p.y + p.p]));
  svg += chainDims(xs, b.y, true, -0.55, T);
  svg += chainDims([xs[0], xs[xs.length - 1]], b.y, true, -1.05, T);
  svg += chainDims(ys, b.x, false, -0.55, T);
  svg += chainDims([ys[0], ys[ys.length - 1]], b.x, false, -1.05, T);

  // flèche nord
  const nx = (b.x + b.w + 0.55) * S, ny = (b.y - 0.85) * S;
  svg += `<circle cx="${nx}" cy="${ny}" r="26" fill="none" stroke="${T.north}" stroke-width="1.5"/>`;
  svg += `<path d="M ${nx} ${ny - 18} L ${nx - 8} ${ny + 12} L ${nx} ${ny + 4} L ${nx + 8} ${ny + 12} Z" fill="${T.north}"/>`;
  svg += text(nx, ny - 32, 16, T.north, "N", 'text-anchor="middle" font-weight="700"');

  // légende des symboles techniques présents sur le plan
  if (usedTypes.length) {
    const lh = 0.32; // interligne (m)
    const lgH = (usedTypes.length * lh + 0.35);
    const lgX = (b.x - ML + 0.15) * S, lgY = (b.y + b.h + MB - lgH - 0.15) * S;
    svg += rect(lgX, lgY, 2.6 * S, lgH * S, `fill="${T.cartouche}" stroke="${T.cartoucheLine}" stroke-width="1.5"`);
    svg += text(lgX + 10, lgY + 22, 13, T.ink, "LÉGENDE", 'font-weight="700" letter-spacing="2"');
    usedTypes.forEach((kind, i) => {
      const sy = lgY + 42 + i * lh * S;
      // le radiateur est large : symbole réduit dans la légende
      svg += kind === "radiateur"
        ? `<g transform="translate(${lgX + 32} ${sy}) scale(0.55) translate(${-(lgX + 32)} ${-sy})">${techSymbol({ type: kind, x: (lgX + 32) / S, y: sy / S }, T)}</g>`
        : techSymbol({ type: kind, x: (lgX + 26) / S, y: sy / S }, T);
      svg += text(lgX + 66, sy + 5, 13, T.inkSoft, TECH_DEFS[kind].label);
    });
  }

  // cartouche
  const cw = 3.6, ch = 1.0;
  const tx = (b.x + b.w + MR - cw) * S, ty = (b.y + b.h + MB - ch - 0.15) * S;
  svg += rect(tx, ty, cw * S, ch * S, `fill="${T.cartouche}" stroke="${T.cartoucheLine}" stroke-width="2"`);
  svg += line(tx, ty + 32, tx + cw * S, ty + 32, T.cartoucheLine, 1);
  svg += line(tx, ty + 64, tx + cw * S, ty + 64, T.cartoucheLine, 1);
  svg += text(tx + 10, ty + 22, 15, T.ink, "ΣIRIUS — PLANS#", 'font-weight="700" letter-spacing="2"');
  svg += text(tx + 10, ty + 54, 15, T.ink, plan.titre || "Plan");
  const today = new Date().toLocaleDateString("fr-FR");
  const total = plan.geometrie?.surface_totale_m2 ?? plan.pieces.reduce((t, p) => t + p.l * p.p, 0);
  svg += text(tx + 10, ty + 86, 13, T.inkSoft, `Échelle 1:100 · ${today} · surfaces : ${fmt(total)} m²`);

  return svg + "</svg>";
}
