// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// PLANS# — plans 2D cotés de bâtiment : description naturelle → plan à l'échelle,
// surfaces calculées (moteur de géométrie) et export DXF (AutoCAD/LibreCAD/QCAD).
import { useCallback, useEffect, useRef, useState } from "react";
import { X, Ruler, Download, FileDown, Loader2 } from "lucide-react";
import { planToSvg2D } from "@/floorplanSvg";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const S = 100; // échelle SVG : 1 m = 100 unités

function loadPlan() {
  try { return JSON.parse(localStorage.getItem("sirius_floorplan")) || null; } catch { return null; }
}

function planBounds(plan) {
  const pieces = plan?.pieces || [];
  if (!pieces.length) return { x: 0, y: 0, w: 10, h: 8 };
  const xs = pieces.flatMap((p) => [p.x, p.x + p.l]);
  const ys = pieces.flatMap((p) => [p.y, p.y + p.p]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Vues 2D : moteur unique thémable (floorplanSvg.js).
// "couleur" = style HUD ΣIRIUS (défaut) · "pro" = dessin d'architecte pour impression.
function ThemedPlanView({ plan, svgRef, theme }) {
  const hostRef = useRef(null);
  useEffect(() => {
    if (!hostRef.current) return;
    hostRef.current.innerHTML = plan && (plan.pieces || []).length ? planToSvg2D(plan, theme) : "";
    if (svgRef) svgRef.current = hostRef.current.querySelector("svg");
  }, [plan, svgRef, theme]);
  return <div ref={hostRef} className="fp-plan-host" data-testid={"floorplan-svg-" + theme} />;
}

export function FloorPlanSVG({ plan, svgRef }) {
  return <ThemedPlanView plan={plan} svgRef={svgRef} theme="couleur" />;
}

export function FloorPlanPro({ plan, svgRef }) {
  return <ThemedPlanView plan={plan} svgRef={svgRef} theme="pro" />;
}

// Projection isométrique : x = est, y = sud, z = hauteur (m) → coordonnées écran SVG.
const ISO_COS = 0.866, ISO_SIN = 0.5;
const proj = (x, y, z = 0) => [(x - y) * ISO_COS * S, ((x + y) * ISO_SIN - z) * S];
const pts = (corners) => corners.map(([x, y, z]) => proj(x, y, z).join(",")).join(" ");

// Vue 3D isométrique : sols, murs extrudés (hauteur sous plafond), ouvertures et mobilier
// en volume. Peintre : les éléments sont triés du fond (x+y faible) vers l'avant.
export function FloorPlanISO({ plan, svgRef }) {
  if (!plan || !(plan.pieces || []).length) return null;
  const rooms = plan.pieces || [];
  const roomByName = Object.fromEntries(rooms.map((p) => [p.nom, p]));
  const solids = [];

  for (const p of rooms) {
    const { x, y, l, p: d } = p;
    const h = p.hauteur || 2.5;
    // sol
    solids.push({
      depth: x + y - 900, el: (k) => (
        <polygon key={k} className="fp3-floor" points={pts([[x, y, 0], [x + l, y, 0], [x + l, y + d, 0], [x, y + d, 0]])} />
      ),
    });
    // étiquette au sol
    const [lx, ly] = proj(x + l / 2, y + d / 2, 0);
    solids.push({
      depth: x + y - 899, el: (k) => (
        <text key={k} className="fp3-label" x={lx} y={ly} textAnchor="middle">
          {p.nom} · {(l * d).toFixed(1).replace(".", ",")} m²
        </text>
      ),
    });
    // murs : nord, ouest (fond) puis est, sud (avant, plus transparents)
    const walls = [
      { a: [x, y], b: [x + l, y], cls: "fp3-wall-back", mur: "nord" },
      { a: [x, y], b: [x, y + d], cls: "fp3-wall-back", mur: "ouest" },
      { a: [x + l, y], b: [x + l, y + d], cls: "fp3-wall-front", mur: "est" },
      { a: [x, y + d], b: [x + l, y + d], cls: "fp3-wall-front", mur: "sud" },
    ];
    for (const w of walls) {
      const depth = (w.a[0] + w.b[0]) / 2 + (w.a[1] + w.b[1]) / 2;
      solids.push({
        depth, el: (k) => (
          <polygon key={k} className={w.cls}
            points={pts([[...w.a, 0], [...w.b, 0], [...w.b, h], [...w.a, h]])} />
        ),
      });
    }
  }

  // ouvertures : quads lumineux plaqués sur leur mur
  for (const op of plan.ouvertures || []) {
    const room = roomByName[op.piece];
    if (!room) continue;
    const { x, y, l, p: d } = room;
    const h = room.hauteur || 2.5;
    const win = op.type === "fenetre";
    const z0 = win ? 0.95 : 0;
    const z1 = win ? Math.min(1.5, h - 0.3) : Math.min(op.type === "porte" ? 2.1 : 2.2, h - 0.15);
    let a, b;
    if (op.mur === "nord") { a = [x + op.position, y]; b = [x + op.position + op.largeur, y]; }
    else if (op.mur === "sud") { a = [x + op.position, y + d]; b = [x + op.position + op.largeur, y + d]; }
    else if (op.mur === "ouest") { a = [x, y + op.position]; b = [x, y + op.position + op.largeur]; }
    else { a = [x + l, y + op.position]; b = [x + l, y + op.position + op.largeur]; }
    const depth = (a[0] + b[0]) / 2 + (a[1] + b[1]) / 2 + 0.02;
    solids.push({
      depth, el: (k) => (
        <polygon key={k} className={win ? "fp3-window" : "fp3-door"}
          points={pts([[...a, z0], [...b, z0], [...b, z1], [...a, z1]])} />
      ),
    });
  }

  // mobilier : boîtes (3 faces visibles)
  for (const m of plan.mobilier || []) {
    const { x, y, l, p: d } = m;
    const h = 0.75;
    const depth = x + l / 2 + y + d / 2 + 0.01;
    const [tx, ty] = proj(x + l / 2, y + d / 2, h);
    solids.push({
      depth, el: (k) => (
        <g key={k} className="fp3-furniture">
          <polygon className="fp3-f-side" points={pts([[x, y + d, 0], [x + l, y + d, 0], [x + l, y + d, h], [x, y + d, h]])} />
          <polygon className="fp3-f-side2" points={pts([[x + l, y, 0], [x + l, y + d, 0], [x + l, y + d, h], [x + l, y, h]])} />
          <polygon className="fp3-f-top" points={pts([[x, y, h], [x + l, y, h], [x + l, y + d, h], [x, y + d, h]])} />
          <text className="fp3-f-label" x={tx} y={ty - 8} textAnchor="middle">{m.nom}</text>
        </g>
      ),
    });
  }

  solids.sort((s1, s2) => s1.depth - s2.depth);

  // Cadre : projette les 8 coins de l'emprise pour le viewBox
  const b = planBounds(plan);
  const hMax = Math.max(...rooms.map((p) => p.hauteur || 2.5));
  const corners = [
    [b.x, b.y, 0], [b.x + b.w, b.y, 0], [b.x, b.y + b.h, 0], [b.x + b.w, b.y + b.h, 0],
    [b.x, b.y, hMax], [b.x + b.w, b.y, hMax], [b.x, b.y + b.h, hMax], [b.x + b.w, b.y + b.h, hMax],
  ].map(([x, y, z]) => proj(x, y, z));
  const minX = Math.min(...corners.map((c) => c[0])) - 0.8 * S;
  const maxX = Math.max(...corners.map((c) => c[0])) + 0.8 * S;
  const minY = Math.min(...corners.map((c) => c[1])) - 0.8 * S;
  const maxY = Math.max(...corners.map((c) => c[1])) + 0.8 * S;

  return (
    <svg ref={svgRef} viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} className="fp-svg" data-testid="floorplan-svg-3d" xmlns="http://www.w3.org/2000/svg">
      {solids.map((s, i) => s.el(i))}
    </svg>
  );
}

export default function FloorPlanPanel({ keys, initialPrompt, onClose, onSpeak }) {
  const [desc, setDesc] = useState(initialPrompt || "");
  const [plan, setPlan] = useState(loadPlan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState(() => localStorage.getItem("sirius_plan_view") || "2d");
  const svgRef = useRef(null);
  const ranRef = useRef(false);
  const switchView = useCallback((v) => { setView(v); localStorage.setItem("sirius_plan_view", v); }, []);

  const generate = useCallback(async (text) => {
    const description = (text || "").trim();
    if (!description) return;
    setBusy(true); setError("");
    try {
      const resp = await fetch(`${API}/floorplan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, keys: keys || {} }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || "Génération impossible");
      setPlan(data);
      localStorage.setItem("sirius_floorplan", JSON.stringify(data));
      if (onSpeak) {
        const total = data.geometrie?.surface_totale_m2;
        onSpeak(`Plan dessiné : ${data.pieces.length} pièce${data.pieces.length > 1 ? "s" : ""}${total ? `, ${String(total).replace(".", " virgule ")} mètres carrés au total` : ""}.`);
      }
    } catch (e) {
      setError(e.message || "Sirius n'a pas pu dessiner ce plan.");
    } finally {
      setBusy(false);
    }
  }, [keys, onSpeak]);

  useEffect(() => {
    if (initialPrompt && !ranRef.current) { ranRef.current = true; generate(initialPrompt); }
  }, [initialPrompt, generate]);

  const downloadDxf = useCallback(async () => {
    if (!plan) return;
    try {
      const resp = await fetch(`${API}/floorplan/dxf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (!resp.ok) throw new Error("Export DXF impossible");
      const blob = await resp.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(plan.titre || "plan-sirius").replace(/[^\w-]+/g, "-").toLowerCase()}.dxf`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(e.message); }
  }, [plan]);

  const downloadSvg = useCallback(() => {
    if (!svgRef.current) return;
    const blob = new Blob([new XMLSerializer().serializeToString(svgRef.current)], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(plan?.titre || "plan-sirius").replace(/[^\w-]+/g, "-").toLowerCase()}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [plan]);

  const geo = plan?.geometrie;

  return (
    <div className="fp-overlay" role="dialog" aria-label="PLANS — plans 2D ΣIRIUS" data-hud-panel>
      <div className="fp-panel">
        <header className="fp-header">
          <div className="fp-title"><Ruler size={16} /> PLANS# — PLANS 2D/3D &amp; GÉOMÉTRIE</div>
          <div className="fp-view-toggle" data-testid="floorplan-view-toggle">
            <button className={view === "2d" ? "active" : ""} onClick={() => switchView("2d")}>COULEUR</button>
            <button className={view === "pro" ? "active" : ""} onClick={() => switchView("pro")}>PRO</button>
            <button className={view === "3d" ? "active" : ""} onClick={() => switchView("3d")}>3D</button>
          </div>
          <button className="fp-close" onClick={onClose} title="Fermer" data-testid="floorplan-close"><X size={16} /></button>
        </header>

        <div className="fp-input-row">
          <textarea
            className="fp-input"
            value={desc}
            placeholder="Décrivez le plan : « un garage de 6 m sur 4, porte sectionnelle de 3 m au sud, fenêtre à l'est, établi le long du mur nord »"
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); generate(desc); } }}
            rows={2}
            data-testid="floorplan-input"
          />
          <button className="fp-generate" onClick={() => generate(desc)} disabled={busy} data-testid="floorplan-generate">
            {busy ? <Loader2 size={15} className="fp-spin" /> : "DESSINER"}
          </button>
        </div>
        {error && <div className="fp-error" data-testid="floorplan-error">{error}</div>}

        <div className="fp-body">
          <div className="fp-canvas">
            {plan
              ? (view === "3d"
                ? <FloorPlanISO plan={plan} svgRef={svgRef} />
                : view === "pro"
                  ? <FloorPlanPro plan={plan} svgRef={svgRef} />
                  : <FloorPlanSVG plan={plan} svgRef={svgRef} />)
              : <div className="fp-empty">Décrivez une pièce, un garage, un appartement… Sirius trace le plan coté à l'échelle, en couleur, en rendu pro ou en volume 3D.</div>}
          </div>
          {geo && (
            <aside className="fp-side">
              <div className="fp-side-title">{plan.titre}</div>
              <table className="fp-metrics" data-testid="floorplan-metrics">
                <tbody>
                  {geo.pieces.map((p, i) => (
                    <tr key={i}>
                      <td>{p.nom}</td>
                      <td>{String(p.surface_m2).replace(".", ",")} m²</td>
                      <td>{String(p.perimetre_m).replace(".", ",")} m</td>
                    </tr>
                  ))}
                  <tr className="fp-total">
                    <td>TOTAL</td>
                    <td>{String(geo.surface_totale_m2).replace(".", ",")} m²</td>
                    <td>{geo.emprise.largeur_m} × {geo.emprise.profondeur_m} m</td>
                  </tr>
                </tbody>
              </table>
              <div className="fp-actions">
                <button onClick={downloadDxf} title="Fichier AutoCAD / LibreCAD / QCAD" data-testid="floorplan-dxf">
                  <FileDown size={14} /> DXF (AutoCAD)
                </button>
                <button onClick={downloadSvg} data-testid="floorplan-svg-dl"><Download size={14} /> SVG</button>
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
