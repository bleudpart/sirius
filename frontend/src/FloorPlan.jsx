// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// PLANS# — Architecture & Intérieur.
// STRUCTURE : description, dictée ou plan scanné/photographié → plan coté à l'échelle,
// surfaces calculées (moteur de géométrie) et export DXF (AutoCAD/LibreCAD/QCAD).
// INTÉRIEUR : ambiances, aménagement proposé par l'IA (texte, voix ou photo d'inspiration),
// métrés de finition, éclairage, budget, notes, liste d'achats et fiche projet.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X, Ruler, Download, FileDown, Loader2, Mic, Square, ImagePlus, FileText, Building2, Sofa,
  Sparkles, Trash2, Lightbulb, PaintBucket, Palette,
} from "lucide-react";
import { planToSvg2D } from "@/floorplanSvg";
import { API_BASE_URL } from "@/lib/api";
import { loadApiKeys } from "@/apiKeyStorage";
import {
  AMBIANCES, PHOTO_AMBIANCE_ID, applyInteriorProposal, computeInteriorTotals, computeRoomFinishes,
  interiorReportHtml, loadInterior, mergePurchases, parseInteriorRequest, photoAmbiance, planKey,
  roomAmbiance, saveInterior, findAmbiance,
} from "@/interiorDesign";

const S = 100; // échelle SVG : 1 m = 100 unités
const MODE_KEY = "sirius_plan_mode";
const PLAN_KEY = "sirius_floorplan";
const DICTATION_MAX_MS = 30000;
const IMAGE_MAX_SIDE = 1600;
const PDF_MAX_BYTES = 12 * 1024 * 1024;
const IMPORT_ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";

function loadPlan() {
  try { return JSON.parse(localStorage.getItem(PLAN_KEY)) || null; } catch { return null; }
}

function storePlan(plan) {
  try { localStorage.setItem(PLAN_KEY, JSON.stringify(plan)); } catch { /* quota plein : non bloquant */ }
}

const fr = (value) => String(value).replace(".", ",");
const eur = (value) => `${Math.round(value).toLocaleString("fr-FR")} €`;
const slug = (text) => (text || "plan-sirius").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "plan-sirius";

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Lecture du fichier impossible."));
    reader.readAsDataURL(file);
  });
}

// Réduit l'image (≈ 1600 px, JPEG) avant l'envoi : plus rapide, et sous la limite serveur.
function downscaleImage(dataUrl, maxSide = IMAGE_MAX_SIDE) {
  return new Promise((resolve) => {
    const img = new Image();
    const fallback = setTimeout(() => resolve(dataUrl), 5000);
    img.onload = () => {
      clearTimeout(fallback);
      try {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(dataUrl); return; }
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      } catch { resolve(dataUrl); }
    };
    img.onerror = () => { clearTimeout(fallback); resolve(dataUrl); };
    img.src = dataUrl;
  });
}

export async function readImportFile(file) {
  if (!file) return null;
  if (file.type === "application/pdf") {
    if (file.size > PDF_MAX_BYTES) throw new Error("PDF trop lourd : 12 Mo maximum.");
    return { dataUrl: await fileToDataUrl(file), name: file.name, pdf: true };
  }
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
    throw new Error("Format non pris en charge : PNG, JPG, WebP ou PDF.");
  }
  return { dataUrl: await downscaleImage(await fileToDataUrl(file)), name: file.name, pdf: false };
}

// Dictée : marche/arrêt (30 s max), transcription par le serveur (/stt) — fonctionne aussi sur Android.
function useDictation(keys, onText, onError) {
  const [state, setState] = useState("idle");
  const recRef = useRef(null);
  const handlers = useRef({ onText, onError });
  handlers.current = { onText, onError };
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
    const rec = recRef.current;
    if (rec) {
      clearTimeout(rec.timer);
      rec.cancelled = true;
      if (rec.recorder.state === "recording") rec.recorder.stop();
      rec.stream.getTracks().forEach((t) => t.stop());
    }
  }, []);

  const toggle = useCallback(async () => {
    const current = recRef.current;
    if (current) {
      if (current.recorder.state === "recording") current.recorder.stop();
      return;
    }
    if (state !== "idle") return;
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    if (!media?.getUserMedia || typeof MediaRecorder === "undefined") {
      handlers.current.onError("Le micro n'est pas disponible sur cet appareil.");
      return;
    }
    let stream;
    try { stream = await media.getUserMedia({ audio: true }); } catch {
      handlers.current.onError("Accès au micro refusé.");
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    const rec = { recorder, stream, cancelled: false, timer: null };
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      clearTimeout(rec.timer);
      stream.getTracks().forEach((t) => t.stop());
      recRef.current = null;
      if (rec.cancelled || !mounted.current) return;
      setState("stt");
      try {
        const body = new FormData();
        body.append("file", new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), "plans.webm");
        const groq = keys?.groq_key || loadApiKeys().groq_key;
        if (groq) body.append("groq_key", groq);
        const resp = await fetch(`${API_BASE_URL}/stt`, { method: "POST", body });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.detail || "La transcription a échoué.");
        const text = String(data.text || "").trim();
        if (!mounted.current) return;
        if (text) handlers.current.onText(text);
        else handlers.current.onError("Je n'ai rien entendu, réessayez.");
      } catch (e) {
        if (mounted.current) handlers.current.onError(e.message || "La transcription a échoué.");
      } finally {
        if (mounted.current) setState("idle");
      }
    };
    recRef.current = rec;
    recorder.start();
    rec.timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, DICTATION_MAX_MS);
    setState("rec");
  }, [keys, state]);

  return { state, toggle };
}

function MicButton({ dictation, label, testId }) {
  const { state, toggle } = dictation;
  const title = state === "rec" ? "Arrêter la dictée" : state === "stt" ? "Transcription…" : label;
  return (
    <button type="button" className={`fp-icon-btn${state === "rec" ? " is-recording" : ""}`}
      onClick={toggle} disabled={state === "stt"} title={title} aria-label={title} data-testid={testId}>
      {state === "rec" ? <Square size={14} /> : state === "stt" ? <Loader2 size={15} className="fp-spin" /> : <Mic size={15} />}
    </button>
  );
}

function AttachmentChip({ file, onRemove, label }) {
  if (!file) return null;
  return (
    <div className="fp-attachment" data-testid="floorplan-attachment">
      {file.pdf
        ? <span className="fp-attachment-pdf"><FileText size={18} /></span>
        : <img src={file.dataUrl} alt="" />}
      <span className="fp-attachment-text"><small>{label}</small>{file.name}</span>
      <button type="button" onClick={onRemove} title="Retirer" aria-label="Retirer le fichier"><X size={13} /></button>
    </div>
  );
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

function planBounds(plan) {
  const pieces = plan?.pieces || [];
  if (!pieces.length) return { x: 0, y: 0, w: 10, h: 8 };
  const xs = pieces.flatMap((p) => [p.x, p.x + p.l]);
  const ys = pieces.flatMap((p) => [p.y, p.y + p.p]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Projection isométrique : x = est, y = sud, z = hauteur (m) → coordonnées écran SVG.
const ISO_COS = 0.866, ISO_SIN = 0.5;
const proj = (x, y, z = 0) => [(x - y) * ISO_COS * S, ((x + y) * ISO_SIN - z) * S];
const pts = (corners) => corners.map(([x, y, z]) => proj(x, y, z).join(",")).join(" ");

// Styles intégrés au SVG exporté (fiche projet) : les classes CSS de l'application n'y sont pas.
const ISO_EXPORT_CSS = `.fp3-floor{fill:#16324a;stroke:#5fd4ff;stroke-width:2}.fp3-wall-back{fill:#1f4d6b;fill-opacity:.85;stroke:#7fdcff;stroke-width:1.5}
.fp3-wall-front{fill:#2b6a8f;fill-opacity:.25;stroke:#7fdcff;stroke-width:1.5}.fp3-door{fill:#d7a65b;fill-opacity:.8}.fp3-window{fill:#9fe8ff;fill-opacity:.7}
.fp3-f-top{fill:#8fb7c9}.fp3-f-side{fill:#4f7488}.fp3-f-side2{fill:#3b5a6b}.fp3-label,.fp3-f-label{font:600 22px system-ui,sans-serif;fill:#10202c}
.fp3-f-label{font-size:16px}.is-active{stroke:#c9a227;stroke-width:5}`;

function shade(hex, amount) {
  const value = parseInt(String(hex || "#888888").slice(1), 16);
  const ch = (shift) => Math.max(0, Math.min(255, Math.round(((value >> shift) & 255) * (1 + amount))));
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`;
}

// Vue 3D isométrique : sols, murs extrudés (hauteur sous plafond), ouvertures et mobilier
// en volume. Peintre : les éléments sont triés du fond (x+y faible) vers l'avant.
// En mode INTÉRIEUR, `roomColors` colore chaque pièce selon son ambiance et un clic la sélectionne.
export function FloorPlanISO({ plan, svgRef, roomColors = null, activeRoom = "", onRoomClick = null }) {
  if (!plan || !(plan.pieces || []).length) return null;
  const rooms = plan.pieces || [];
  const roomByName = Object.fromEntries(rooms.map((p) => [p.nom, p]));
  const roomAt = (cx, cy) => rooms.find((r) => cx >= r.x && cx <= r.x + r.l && cy >= r.y && cy <= r.y + r.p);
  const solids = [];
  const colored = Boolean(roomColors);
  // En INTÉRIEUR : vue en coupe « maison de poupée » — seuls les murs extérieurs du fond
  // gardent leur hauteur, cloisons et façades avant sont arasées pour dévoiler l'aménagement.
  const bounds = planBounds(plan);
  const CUT = 0.9;
  const wallHeight = (w, h) => {
    if (!colored) return h;
    const north = w.a[1] === w.b[1] && Math.abs(w.a[1] - bounds.y) < 0.01;
    const west = w.a[0] === w.b[0] && Math.abs(w.a[0] - bounds.x) < 0.01;
    return north || west ? h : Math.min(CUT, h);
  };

  for (const p of rooms) {
    const { x, y, l, p: d } = p;
    const h = p.hauteur || 2.5;
    const palette = roomColors?.[p.nom];
    const active = colored && p.nom === activeRoom;
    const select = onRoomClick ? () => onRoomClick(p.nom) : undefined;
    solids.push({
      depth: x + y - 900, el: (k) => (
        <polygon key={k} className={`fp3-floor${active ? " is-active" : ""}${select ? " is-clickable" : ""}`}
          style={palette ? { fill: palette.sol, fillOpacity: 0.92 } : undefined}
          onClick={select} data-room={p.nom}
          points={pts([[x, y, 0], [x + l, y, 0], [x + l, y + d, 0], [x, y + d, 0]])} />
      ),
    });
    const [lx, ly] = proj(x + l / 2, y + d / 2, 0);
    solids.push({
      depth: x + y - 899, el: (k) => (
        <text key={k} className={`fp3-label${colored ? " is-colored" : ""}`} x={lx} y={ly} textAnchor="middle" onClick={select}>
          {p.nom} · {fr((l * d).toFixed(1))} m²
        </text>
      ),
    });
    const walls = [
      { a: [x, y], b: [x + l, y], cls: "fp3-wall-back", tone: -0.04 },
      { a: [x, y], b: [x, y + d], cls: "fp3-wall-back", tone: -0.16 },
      { a: [x + l, y], b: [x + l, y + d], cls: "fp3-wall-front", tone: -0.1 },
      { a: [x, y + d], b: [x + l, y + d], cls: "fp3-wall-front", tone: 0 },
    ];
    for (const w of walls) {
      const depth = (w.a[0] + w.b[0]) / 2 + (w.a[1] + w.b[1]) / 2;
      const front = w.cls === "fp3-wall-front";
      const wh = wallHeight(w, h);
      const cut = wh < h;
      solids.push({
        depth, el: (k) => (
          <polygon key={k} className={`${w.cls}${cut ? " is-cut" : ""}`}
            style={palette ? { fill: shade(palette.murs, w.tone), fillOpacity: cut ? 0.9 : front ? 0.28 : 0.95 } : undefined}
            points={pts([[...w.a, 0], [...w.b, 0], [...w.b, wh], [...w.a, wh]])} />
        ),
      });
    }
  }

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
    const top = Math.min(z1, wallHeight({ a, b }, h));
    if (top <= z0) continue;
    solids.push({
      depth, el: (k) => (
        <polygon key={k} className={win ? "fp3-window" : "fp3-door"}
          points={pts([[...a, z0], [...b, z0], [...b, top], [...a, top]])} />
      ),
    });
  }

  for (const m of plan.mobilier || []) {
    const { x, y, l, p: d } = m;
    const h = 0.75;
    const depth = x + l / 2 + y + d / 2 + 0.01;
    const [tx, ty] = proj(x + l / 2, y + d / 2, h);
    const home = colored ? roomAt(x + l / 2, y + d / 2) : null;
    const palette = home ? roomColors[home.nom] : null;
    const base = palette ? (/(canap|fauteuil|lit|tapis|rideau|coussin)/i.test(m.nom) ? palette.textile : palette.bois) : null;
    solids.push({
      depth, el: (k) => (
        <g key={k} className="fp3-furniture">
          <polygon className="fp3-f-side" style={base ? { fill: shade(base, -0.22) } : undefined}
            points={pts([[x, y + d, 0], [x + l, y + d, 0], [x + l, y + d, h], [x, y + d, h]])} />
          <polygon className="fp3-f-side2" style={base ? { fill: shade(base, -0.36) } : undefined}
            points={pts([[x + l, y, 0], [x + l, y + d, 0], [x + l, y + d, h], [x + l, y, h]])} />
          <polygon className="fp3-f-top" style={base ? { fill: base } : undefined}
            points={pts([[x, y, h], [x + l, y, h], [x + l, y + d, h], [x, y + d, h]])} />
          <text className={`fp3-f-label${colored ? " is-colored" : ""}`} x={tx} y={ty - 8} textAnchor="middle">{m.nom}</text>
        </g>
      ),
    });
  }

  solids.sort((s1, s2) => s1.depth - s2.depth);

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
    <svg ref={svgRef} viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      className={`fp-svg${colored ? " fp-svg-interior" : ""}`} data-testid="floorplan-svg-3d" xmlns="http://www.w3.org/2000/svg">
      {solids.map((s, i) => s.el(i))}
    </svg>
  );
}

function Swatches({ palette }) {
  return (
    <span className="fp-swatches" aria-hidden="true">
      {["murs", "sol", "bois", "textile", "accent"].map((k) => <i key={k} style={{ background: palette[k] }} />)}
    </span>
  );
}

function InteriorStudio({ plan, interior, setInterior, finishes, totals, envies, setEnvies, photo, setPhoto,
  busy, onPropose, onImport, onExport, dictation }) {
  const roomName = interior.piece;
  const room = interior.pieces[roomName] || {};
  const style = roomAmbiance(interior, roomName);
  const current = finishes.find((f) => f.piece === roomName);
  const inspiration = room.inspiration || interior.inspiration;
  const photoStyle = inspiration ? photoAmbiance(inspiration) : null;
  const cards = photoStyle ? [photoStyle, ...AMBIANCES] : AMBIANCES;
  const purchaseTotal = interior.achats.reduce((sum, a) => sum + (a.budget_eur || 0) * (a.quantite || 1), 0);

  const updateRoom = (patch) => setInterior((s) => ({
    ...s, pieces: { ...s.pieces, [s.piece]: { ...(s.pieces[s.piece] || {}), ...patch } },
  }));
  const applyEverywhere = () => setInterior((s) => ({
    ...s, ambiance: style.id,
    pieces: Object.fromEntries(Object.entries(s.pieces).map(([k, v]) => {
      const { ambiance, ...rest } = v;
      return [k, rest];
    })),
  }));
  const tips = room.conseils?.length ? room.conseils : style.conseils;

  return (
    <aside className="fp-studio" data-testid="interior-studio">
      <div className="fp-rooms" role="tablist" aria-label="Pièces">
        {plan.pieces.map((p) => (
          <button key={p.nom} role="tab" aria-selected={p.nom === roomName}
            className={p.nom === roomName ? "active" : ""}
            style={{ "--room-color": roomAmbiance(interior, p.nom).palette.accent }}
            onClick={() => setInterior((s) => ({ ...s, piece: p.nom }))}>
            <i /> {p.nom} <small>{fr((p.l * p.p).toFixed(1))} m²</small>
          </button>
        ))}
      </div>

      <section className="fp-card fp-brief">
        <div className="fp-card-title"><Sparkles size={14} /> VOS ENVIES</div>
        <div className="fp-brief-row">
          <textarea className="fp-input" rows={2} value={envies} data-testid="interior-envies"
            placeholder="« Un séjour japandi chaleureux, coin lecture près de la fenêtre, budget 3 000 € »"
            onChange={(e) => setEnvies(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onPropose(); } }} />
          <div className="fp-brief-tools">
            <MicButton dictation={dictation} label="Dicter vos envies" testId="interior-mic" />
            <button type="button" className="fp-icon-btn" onClick={onImport}
              title="Photo d'inspiration (ou PDF)" aria-label="Ajouter une photo d'inspiration" data-testid="interior-photo">
              <ImagePlus size={15} />
            </button>
          </div>
        </div>
        <AttachmentChip file={photo} label="Inspiration" onRemove={() => setPhoto(null)} />
        <button className="fp-propose" onClick={onPropose} disabled={busy} data-testid="interior-propose">
          {busy ? <><Loader2 size={15} className="fp-spin" /> ΣIRIUS aménage…</> : <><Sofa size={15} /> PROPOSER UN AMÉNAGEMENT · {roomName}</>}
        </button>
      </section>

      <section className="fp-card">
        <div className="fp-card-title"><Palette size={14} /> AMBIANCE · {style.nom}</div>
        <div className="fp-ambiances" role="radiogroup" aria-label="Ambiance">
          {cards.map((a) => (
            <button key={a.id} role="radio" aria-checked={a.id === style.id}
              className={`fp-ambiance${a.id === style.id ? " active" : ""}`}
              onClick={() => updateRoom({ ambiance: a.id })} data-testid={`ambiance-${a.id}`}>
              <Swatches palette={a.palette} />
              <b>{a.nom}</b>
              <small>{a.accroche}</small>
            </button>
          ))}
        </div>
        <div className="fp-matieres">
          {style.matieres.map((m) => <span key={m}>{m}</span>)}
          <button type="button" className="fp-link" onClick={applyEverywhere}>Appliquer à tout le logement</button>
        </div>
        {tips.length > 0 && <ul className="fp-tips">{tips.map((t, i) => <li key={i}>{t}</li>)}</ul>}
        {room.eclairage && <p className="fp-light-tip"><Lightbulb size={13} /> {room.eclairage}</p>}
      </section>

      {current && (
        <section className="fp-card">
          <div className="fp-card-title"><PaintBucket size={14} /> MÉTRÉS &amp; BUDGET</div>
          <div className="fp-settings">
            <label>Hauteur (m)
              <input type="number" min="2" max="6" step="0.05" value={room.hauteur || ""}
                placeholder={fr(current.hauteur)} onChange={(e) => updateRoom({ hauteur: e.target.value })} />
            </label>
            <label>Couches
              <select value={interior.couches} onChange={(e) => setInterior((s) => ({ ...s, couches: Number(e.target.value) }))}>
                <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
              </select>
            </label>
          </div>
          <div className="fp-kpis" data-testid="interior-metrics">
            <div><b>{fr(current.surface_sol)} m²</b><span>{current.sol.nom}</span><small>{fr(current.sol.commande_m2)} m² à commander</small></div>
            <div><b>{fr(current.murs_nets)} m²</b><span>murs nets</span><small>ouvertures déduites</small></div>
            <div><b>{current.pots_2_5l} pot{current.pots_2_5l > 1 ? "s" : ""}</b><span>peinture 2,5 L</span><small>{fr(current.peinture_litres)} L, plafond inclus</small></div>
            <div><b>{current.plinthes_ml ? `${fr(current.plinthes_ml)} ml` : "—"}</b><span>plinthes</span><small>{current.plinthes_ml ? "+5 % de chutes" : "pièce d'eau"}</small></div>
            <div><b>{current.eclairage.lumens.toLocaleString("fr-FR")} lm</b><span>éclairage {current.eclairage.kelvin} K</span><small>{current.eclairage.lux} lux · {current.eclairage.usage}</small></div>
            <div className="fp-kpi-budget"><b>{eur(current.budget_eur.min)} – {eur(current.budget_eur.max)}</b><span>finitions</span><small>fournitures, hors pose</small></div>
          </div>
        </section>
      )}

      <section className="fp-card">
        <div className="fp-card-title">NOTES · {roomName}</div>
        <textarea className="fp-notes" rows={2} value={room.notes || ""} data-testid="interior-notes"
          placeholder="Mesures à vérifier, idées, contacts artisans…" onChange={(e) => updateRoom({ notes: e.target.value })} />
      </section>

      <section className="fp-card">
        <div className="fp-card-title">LISTE D'ACHATS <small>{interior.achats.length ? eur(purchaseTotal) : ""}</small></div>
        {interior.achats.length === 0
          ? <p className="fp-muted">Les articles proposés par ΣIRIUS apparaîtront ici.</p>
          : (
            <ul className="fp-purchases" data-testid="interior-purchases">
              {interior.achats.map((a, i) => (
                <li key={`${a.piece}-${a.article}-${i}`} className={a.fait ? "done" : ""}>
                  <label>
                    <input type="checkbox" checked={Boolean(a.fait)} onChange={() => setInterior((s) => ({
                      ...s, achats: s.achats.map((x, j) => (j === i ? { ...x, fait: !x.fait } : x)),
                    }))} />
                    <span>{a.article}<small>{a.piece} · × {a.quantite || 1}</small></span>
                  </label>
                  <b>{eur((a.budget_eur || 0) * (a.quantite || 1))}</b>
                  <button type="button" title="Retirer" aria-label={`Retirer ${a.article}`} onClick={() => setInterior((s) => ({
                    ...s, achats: s.achats.filter((_, j) => j !== i),
                  }))}><Trash2 size={13} /></button>
                </li>
              ))}
            </ul>
          )}
      </section>

      <footer className="fp-studio-footer">
        <div><small>LOGEMENT</small><b>{fr(totals.surface_sol.toFixed(1))} m² · {eur(totals.budget_min)} – {eur(totals.budget_max)}</b></div>
        <button onClick={onExport} data-testid="interior-export"><FileDown size={14} /> FICHE PROJET</button>
      </footer>
    </aside>
  );
}

export default function FloorPlanPanel({ keys, initialPrompt, initialMode, onClose, onSpeak }) {
  const [mode, setMode] = useState(() => initialMode || localStorage.getItem(MODE_KEY) || "structure");
  const [desc, setDesc] = useState(initialMode === "interieur" ? "" : initialPrompt || "");
  const [plan, setPlanState] = useState(loadPlan);
  const [planImage, setPlanImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState(() => localStorage.getItem("sirius_plan_view") || "2d");
  const [interior, setInterior] = useState(() => loadInterior(loadPlan()));
  const [envies, setEnvies] = useState(initialMode === "interieur" ? initialPrompt || "" : "");
  const [photo, setPhoto] = useState(null);
  const svgRef = useRef(null);
  const fileRef = useRef(null);
  const importTarget = useRef("plan");
  const ranRef = useRef(false);

  const setPlan = useCallback((next) => { setPlanState(next); storePlan(next); }, []);
  const switchView = useCallback((v) => { setView(v); localStorage.setItem("sirius_plan_view", v); }, []);
  const switchMode = useCallback((m) => { setMode(m); setError(""); localStorage.setItem(MODE_KEY, m); }, []);

  useEffect(() => {
    setInterior((s) => (s.planKey === planKey(plan) ? s : loadInterior(plan)));
  }, [plan]);
  useEffect(() => { saveInterior(interior); }, [interior]);

  const generate = useCallback(async (text, image = planImage) => {
    const description = (text || "").trim();
    if (!description && !image) return;
    setBusy(true); setError("");
    try {
      const resp = await fetch(`${API_BASE_URL}/floorplan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, image: image?.dataUrl || "", keys: keys || {} }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.detail || "Génération impossible");
      setPlan(data);
      setPlanImage(null);
      if (onSpeak) {
        const total = data.geometrie?.surface_totale_m2;
        onSpeak(`Plan dessiné : ${data.pieces.length} pièce${data.pieces.length > 1 ? "s" : ""}${total ? `, ${String(total).replace(".", " virgule ")} mètres carrés au total` : ""}.`);
      }
    } catch (e) {
      setError(e.message || "Sirius n'a pas pu dessiner ce plan.");
    } finally {
      setBusy(false);
    }
  }, [keys, onSpeak, planImage, setPlan]);

  const propose = useCallback(async (textOverride) => {
    if (!plan?.pieces?.length) {
      setError("Dessinez ou importez d'abord le plan dans STRUCTURE, puis revenez ici pour l'aménager.");
      return;
    }
    const text = (typeof textOverride === "string" ? textOverride : envies).trim();
    const parsed = parseInteriorRequest(text, plan);
    const pieceName = parsed.piece || interior.piece || plan.pieces[0].nom;
    const previous = interior.pieces[pieceName] || {};
    const ambianceId = parsed.ambiance || previous.ambiance || interior.ambiance;
    const inspiration = previous.inspiration || interior.inspiration;
    const style = ambianceId === PHOTO_AMBIANCE_ID && inspiration ? photoAmbiance(inspiration) : findAmbiance(ambianceId);
    setInterior((s) => ({
      ...s, piece: pieceName,
      pieces: parsed.ambiance ? { ...s.pieces, [pieceName]: { ...(s.pieces[pieceName] || {}), ambiance: parsed.ambiance } } : s.pieces,
    }));
    setBusy(true); setError("");
    try {
      const resp = await fetch(`${API_BASE_URL}/floorplan/interior`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan, piece: pieceName,
          ambiance: photo ? "" : `${style.nom} — ${style.accroche}. Matières : ${style.matieres.join(", ")}.`,
          envies: text, photo: photo?.dataUrl || "", keys: keys || {},
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.detail || "Aménagement impossible");
      const target = data.piece || pieceName;
      setPlan(applyInteriorProposal(plan, target, data.mobilier || []));
      setInterior((s) => ({
        ...s,
        piece: target,
        inspiration: data.inspiration || s.inspiration,
        achats: mergePurchases(s.achats, data.achats || [], target),
        pieces: {
          ...s.pieces,
          [target]: {
            ...(s.pieces[target] || {}),
            conseils: data.conseils || [],
            eclairage: data.eclairage || "",
            ...(data.inspiration ? { inspiration: data.inspiration, ambiance: PHOTO_AMBIANCE_ID } : {}),
          },
        },
      }));
      setPhoto(null);
      if (onSpeak) {
        const n = (data.mobilier || []).length;
        onSpeak(`Aménagement proposé pour ${target} : ${n} élément${n > 1 ? "s" : ""}${data.inspiration?.style ? `, style ${data.inspiration.style}` : ""}.`);
      }
    } catch (e) {
      setError(e.message || "Sirius n'a pas pu aménager cette pièce.");
    } finally {
      setBusy(false);
    }
  }, [plan, envies, interior, photo, keys, onSpeak, setPlan]);

  useEffect(() => {
    if (!initialPrompt || ranRef.current) return;
    ranRef.current = true;
    if (initialMode === "interieur") propose(initialPrompt);
    else generate(initialPrompt, null);
  }, [initialPrompt, initialMode, generate, propose]);

  const planDictation = useDictation(keys, (text) => { setDesc(text); generate(text); }, setError);
  const interiorDictation = useDictation(keys, (text) => { setEnvies(text); propose(text); }, setError);

  const openImport = (target) => { importTarget.current = target; fileRef.current?.click(); };
  const onFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    try {
      const data = await readImportFile(file);
      if (importTarget.current === "photo") setPhoto(data); else setPlanImage(data);
    } catch (e) { setError(e.message); }
  };

  const downloadDxf = useCallback(async () => {
    if (!plan) return;
    try {
      const resp = await fetch(`${API_BASE_URL}/floorplan/dxf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (!resp.ok) throw new Error("Export DXF impossible");
      downloadBlob(await resp.blob(), `${slug(plan.titre)}.dxf`);
    } catch (e) { setError(e.message); }
  }, [plan]);

  const downloadSvg = useCallback(() => {
    if (!svgRef.current) return;
    downloadBlob(new Blob([new XMLSerializer().serializeToString(svgRef.current)], { type: "image/svg+xml" }), `${slug(plan?.titre)}.svg`);
  }, [plan]);

  const roomColors = useMemo(() => Object.fromEntries((plan?.pieces || []).map((p) => [p.nom, roomAmbiance(interior, p.nom).palette])), [plan, interior]);
  const finishes = useMemo(() => (plan?.pieces || []).map((room) => computeRoomFinishes(room, plan, {
    hauteur: interior.pieces[room.nom]?.hauteur, couches: interior.couches, ambiance: roomAmbiance(interior, room.nom),
  })), [plan, interior]);
  const totals = useMemo(() => computeInteriorTotals(finishes), [finishes]);

  const exportInterior = useCallback(() => {
    let svgMarkup = "";
    if (svgRef.current) {
      const clone = svgRef.current.cloneNode(true);
      const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
      style.textContent = ISO_EXPORT_CSS;
      clone.insertBefore(style, clone.firstChild);
      svgMarkup = new XMLSerializer().serializeToString(clone);
    }
    downloadBlob(new Blob([interiorReportHtml(plan, interior, finishes, svgMarkup)], { type: "text/html;charset=utf-8" }),
      `${slug(plan?.titre)}-interieur.html`);
  }, [plan, interior, finishes]);

  const geo = plan?.geometrie;
  const interiorMode = mode === "interieur";
  const hasPlan = Boolean(plan?.pieces?.length);

  return (
    <div className="fp-overlay" role="dialog" aria-label="PLANS — Architecture & Intérieur ΣIRIUS" data-hud-panel>
      <div className={`fp-panel${interiorMode ? " is-interior" : ""}`}>
        <header className="fp-header">
          <div className="fp-title" data-module-name="PLANS"><Ruler size={16} /> PLANS <span className="module-function">— ARCHITECTURE &amp; INTÉRIEUR</span></div>
          <div className="fp-mode-switch" role="tablist" aria-label="Mode du module" data-testid="floorplan-mode">
            <button role="tab" aria-selected={!interiorMode} className={!interiorMode ? "active" : ""} onClick={() => switchMode("structure")}>
              <Building2 size={14} /> STRUCTURE
            </button>
            <button role="tab" aria-selected={interiorMode} className={interiorMode ? "active" : ""} onClick={() => switchMode("interieur")} data-testid="floorplan-mode-interior">
              <Sofa size={14} /> INTÉRIEUR
            </button>
          </div>
          {!interiorMode && (
            <div className="fp-view-toggle sirius-window-tools" role="group" aria-label="Affichage du plan" data-testid="floorplan-view-toggle">
              <button className={view === "2d" ? "active" : ""} onClick={() => switchView("2d")}>COULEUR</button>
              <button className={view === "pro" ? "active" : ""} onClick={() => switchView("pro")}>PRO</button>
              <button className={view === "3d" ? "active" : ""} onClick={() => switchView("3d")}>3D</button>
            </div>
          )}
          <button className="fp-close" onClick={onClose} title="Fermer" data-testid="floorplan-close"><X size={16} /></button>
        </header>

        <input ref={fileRef} type="file" accept={IMPORT_ACCEPT} hidden onChange={onFile} data-testid="floorplan-file" />

        {!interiorMode && (
          <>
            <div className="fp-input-row">
              <textarea
                className="fp-input"
                value={desc}
                placeholder={planImage
                  ? "Précisions facultatives : « hauteur 2,60 m, cuisine ouverte »…"
                  : "Décrivez, dictez ou importez un plan : « un garage de 6 m sur 4, porte sectionnelle de 3 m au sud, fenêtre à l'est »"}
                onChange={(e) => setDesc(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); generate(desc); } }}
                rows={2}
                data-testid="floorplan-input"
              />
              <MicButton dictation={planDictation} label="Dicter le plan" testId="floorplan-mic" />
              <button type="button" className="fp-icon-btn" onClick={() => openImport("plan")}
                title="Importer un plan (photo, scan ou PDF)" aria-label="Importer un plan" data-testid="floorplan-import">
                <ImagePlus size={15} />
              </button>
              <button className="fp-generate" onClick={() => generate(desc)} disabled={busy} data-testid="floorplan-generate">
                {busy ? <Loader2 size={15} className="fp-spin" /> : planImage ? "REDESSINER" : "DESSINER"}
              </button>
            </div>
            <AttachmentChip file={planImage} label="Plan à redessiner" onRemove={() => setPlanImage(null)} />
          </>
        )}
        {error && <div className="fp-error" data-testid="floorplan-error">{error}</div>}

        <div className={`fp-body${interiorMode ? " fp-body-interior" : ""}`}>
          <div className="fp-canvas">
            {interiorMode
              ? (hasPlan
                ? <FloorPlanISO plan={plan} svgRef={svgRef} roomColors={roomColors} activeRoom={interior.piece}
                  onRoomClick={(nom) => setInterior((s) => ({ ...s, piece: nom }))} />
                : (
                  <div className="fp-empty">
                    Commencez par la structure : décrivez, dictez ou importez le plan du logement, puis revenez ici pour l'aménager pièce par pièce.
                    <button className="fp-generate" onClick={() => switchMode("structure")}><Building2 size={14} /> ALLER À STRUCTURE</button>
                  </div>
                ))
              : plan
                ? (view === "3d"
                  ? <FloorPlanISO plan={plan} svgRef={svgRef} />
                  : view === "pro"
                    ? <FloorPlanPro plan={plan} svgRef={svgRef} />
                    : <FloorPlanSVG plan={plan} svgRef={svgRef} />)
                : <div className="fp-empty">Décrivez, dictez ou importez un plan (photo, scan, PDF)… ΣIRIUS trace le plan coté à l'échelle, en couleur, en rendu pro ou en volume 3D.</div>}
          </div>
          {interiorMode && hasPlan && (
            <InteriorStudio plan={plan} interior={interior} setInterior={setInterior} finishes={finishes} totals={totals}
              envies={envies} setEnvies={setEnvies} photo={photo} setPhoto={setPhoto} busy={busy}
              onPropose={() => propose()} onImport={() => openImport("photo")} onExport={exportInterior}
              dictation={interiorDictation} />
          )}
          {!interiorMode && geo && (
            <aside className="fp-side">
              <div className="fp-side-title">{plan.titre}</div>
              <table className="fp-metrics" data-testid="floorplan-metrics">
                <tbody>
                  {geo.pieces.map((p, i) => (
                    <tr key={i}>
                      <td>{p.nom}</td>
                      <td>{fr(p.surface_m2)} m²</td>
                      <td>{fr(p.perimetre_m)} m</td>
                    </tr>
                  ))}
                  <tr className="fp-total">
                    <td>TOTAL</td>
                    <td>{fr(geo.surface_totale_m2)} m²</td>
                    <td>{geo.emprise.largeur_m} × {geo.emprise.profondeur_m} m</td>
                  </tr>
                </tbody>
              </table>
              <div className="fp-actions">
                <button onClick={downloadDxf} title="Fichier AutoCAD / LibreCAD / QCAD" data-testid="floorplan-dxf">
                  <FileDown size={14} /> DXF (AutoCAD)
                </button>
                <button onClick={downloadSvg} data-testid="floorplan-svg-dl"><Download size={14} /> SVG</button>
                <button onClick={() => switchMode("interieur")} className="fp-to-interior" data-testid="floorplan-to-interior">
                  <Sofa size={14} /> AMÉNAGER
                </button>
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
