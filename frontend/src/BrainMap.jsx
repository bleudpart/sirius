// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Carte corticale du NEXUS : regroupement fonctionnel des intentions réellement
// enregistrées en aires cérébrales. La correspondance est une métaphore de lecture,
// pas une mesure neuroanatomique — chaque aire est définie ci-dessous par mots-clés.
import { useEffect, useMemo, useState } from "react";

const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, "-").toLowerCase();

// cx/cy/rx/ry/rot décrivent l'ellipse de l'aire ; l'ensemble compose une silhouette de cerveau.
export const LOBES = [
  {
    id: "prefrontal", label: "PRÉFRONTAL", role: "Décision · configuration",
    color: "#8d8fc4", cx: 196, cy: 250, rx: 74, ry: 66, rot: -12,
    match: ["réglage", "reglage", "paramètre", "parametre", "profil", "système", "systeme",
            "plateforme", "installation", "packager", "clé", "cle", "admin", "entreprise"],
  },
  {
    id: "frontal", label: "FRONTAL", role: "Action · exécution",
    color: "#7fb2d4", cx: 304, cy: 196, rx: 84, ry: 70, rot: -6,
    match: ["module", "ouverture", "rangement", "tâche", "tache", "commande", "webbrowser",
            "web", "outlook", "themis", "thémis", "agora", "facture", "haccp"],
  },
  {
    id: "parietal", label: "PARIÉTAL", role: "Espace · navigation",
    color: "#6fae9f", cx: 448, cy: 186, rx: 82, ry: 66, rot: 6,
    match: ["atlas", "locus", "carte", "pays", "trajet", "météo", "meteo", "géo", "geo",
            "spatial", "navigation", "itinéraire", "itineraire", "adresse", "distance",
            "plan", "position", "lieu", "ville", "voyage"],
  },
  {
    id: "occipital", label: "OCCIPITAL", role: "Vision · rendu",
    color: "#c2925a", cx: 578, cy: 240, rx: 72, ry: 66, rot: 14,
    match: ["vision", "image", "photo", "galerie", "mythos", "display", "écran", "ecran",
            "documentaire", "promo", "storyboard", "vidéo", "video", "trailer", "3d"],
  },
  {
    id: "temporal", label: "TEMPORAL", role: "Langage · audition",
    color: "#b0728a", cx: 344, cy: 332, rx: 96, ry: 54, rot: -4,
    match: ["conversation", "libre", "question", "heure", "musique", "ambiance", "spotify",
            "voix", "lecture", "actualités", "actualites", "news", "calliope"],
  },
  {
    id: "hippocampe", label: "HIPPOCAMPE", role: "Mémoire",
    color: "#d8b875", cx: 452, cy: 306, rx: 46, ry: 30, rot: 18,
    match: ["archive", "mémoire", "memoire", "souvenir", "prime", "historique", "épisode", "episode"],
  },
  {
    id: "cervelet", label: "CERVELET", role: "Automatismes · maintenance",
    color: "#5f8fa8", cx: 566, cy: 352, rx: 62, ry: 44, rot: -10,
    match: ["briefing", "réveil", "reveil", "diagnostic", "héphaïstos", "hephaistos",
            "maintenance", "connectivité", "connectivite", "sauvegarde", "argus", "cortex"],
  },
];

const FALLBACK = "temporal";

// Chaque humeur change le rythme et la teinte d'ensemble ; l'état « thinking » ajoute
// une onde de réflexion qui parcourt le cortex.
export const MOODS = {
  enthousiaste: { tempo: 0.62, glow: 1.25, tint: "#6fae9f", label: "ENTHOUSIASTE" },
  "focalisé": { tempo: 0.85, glow: 1.0, tint: "#7fb2d4", label: "FOCALISÉ" },
  vigilant: { tempo: 0.7, glow: 1.15, tint: "#c2925a", label: "VIGILANT" },
  calme: { tempo: 1.35, glow: 0.8, tint: "#8d8fc4", label: "CALME" },
  "en veille basse": { tempo: 1.9, glow: 0.55, tint: "#54707f", label: "VEILLE BASSE" },
};
const moodProfile = (m) => MOODS[m] || MOODS["focalisé"];

export function lobeOf(intent) {
  const full = String(intent || "").toLowerCase();
  // Les intentions s'écrivent « module · action » : le module porte le sens, on le teste d'abord.
  const primary = full.split("·")[0].trim() || full;
  for (const source of [primary, full]) {
    for (const l of LOBES) {
      if (l.match.some((k) => source.includes(k))) return l.id;
    }
  }
  return FALLBACK;
}

/* Place les nœuds d'une aire sur une spirale interne pour éviter les chevauchements. */
function layout(lobe, items) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return items.map((n, i) => {
    const t = items.length === 1 ? 0 : Math.sqrt((i + 0.5) / items.length);
    const a = i * golden;
    const rot = (lobe.rot * Math.PI) / 180;
    const ex = Math.cos(a) * t * lobe.rx * 0.66;
    const ey = Math.sin(a) * t * lobe.ry * 0.66;
    return {
      ...n,
      x: lobe.cx + ex * Math.cos(rot) - ey * Math.sin(rot),
      y: lobe.cy + ex * Math.sin(rot) + ey * Math.cos(rot),
      lobe,
    };
  });
}

export default function BrainMap({ nodes, edges, mood, status }) {
  const [grown, setGrown] = useState(0);
  const [focus, setFocus] = useState(null);
  const mp = moodProfile(mood?.humeur);
  const energy = Math.max(0.25, Math.min(1, (mood?.energie ?? 70) / 100));
  const thinking = status === "thinking" || status === "speaking";
  // Énergie haute = cadence accélérée ; en réflexion, tout le cortex s'active davantage.
  const tempo = mp.tempo * (1.35 - energy * 0.5) * (thinking ? 0.55 : 1);

  useEffect(() => {
    const t0 = performance.now();
    let raf;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 1100);
      setGrown(1 - Math.pow(1 - p, 3));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [nodes]);

  const placed = useMemo(() => {
    const byLobe = {};
    LOBES.forEach((l) => (byLobe[l.id] = []));
    [...nodes].sort((a, b) => b.count - a.count).forEach((n) => byLobe[lobeOf(n.id)].push(n));
    return LOBES.flatMap((l) => layout(l, byLobe[l.id]));
  }, [nodes]);

  const pos = useMemo(() => Object.fromEntries(placed.map((p) => [p.id, p])), [placed]);
  const counts = useMemo(() => {
    const c = {};
    LOBES.forEach((l) => (c[l.id] = 0));
    nodes.forEach((n) => (c[lobeOf(n.id)] += n.count));
    return c;
  }, [nodes]);
  // Une aire sans faisceau doit être signalée comme telle plutôt que de paraître en panne.
  const linked = useMemo(() => {
    const s = new Set();
    edges.forEach((e) => {
      if (pos[e.from] && pos[e.to]) { s.add(pos[e.from].lobe.id); s.add(pos[e.to].lobe.id); }
    });
    return s;
  }, [edges, pos]);

  if (!nodes.length) return <div className="zcx-empty">Aucun module encore sollicité.</div>;

  const W = 780, H = 520;
  const maxCount = Math.max(...nodes.map((n) => n.count), 1);
  const maxEdge = Math.max(...edges.map((e) => e.count), 1);
  const total = nodes.reduce((a, n) => a + n.count, 0) || 1;
  const dimmed = (id) => focus && focus !== id && pos[focus]?.lobe.id !== pos[id]?.lobe.id;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} data-testid="nexus-brainmap"
         onMouseLeave={() => setFocus(null)} style={{ fontFamily: "Rajdhani, sans-serif" }}>
      <defs>
        {LOBES.map((l) => (
          <radialGradient id={`bmG-${l.id}`} key={l.id}>
            <stop offset="35%" stopColor={l.color} stopOpacity="0.30" />
            <stop offset="100%" stopColor={l.color} stopOpacity="0.05" />
          </radialGradient>
        ))}
        <marker id="bmArrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="rgba(216,184,117,.9)" />
        </marker>
      </defs>

      {[[18, 18, 1, 1], [W - 18, 18, -1, 1], [18, H - 18, 1, -1], [W - 18, H - 18, -1, -1]].map(([x, y, sx, sy]) => (
        <path key={`${x}-${y}`} d={`M${x},${y + sy * 16} L${x},${y} L${x + sx * 16},${y}`}
              fill="none" stroke="rgba(216,184,117,.5)" strokeWidth="1.4" />
      ))}

      {/* Tronc cérébral */}
      <path d="M492,372 C500,412 496,444 470,462 C452,474 438,470 440,452 C444,420 456,392 470,374 Z"
            fill="rgba(95,143,168,.16)" stroke="rgba(95,143,168,.45)" />
      <text x="468" y="480" fill="#54707f" fontSize="8.5" textAnchor="middle" letterSpacing="1">TRONC</text>

      {/* Aires corticales */}
      {LOBES.map((l) => {
        const active = focus && pos[focus]?.lobe.id === l.id;
        const load = counts[l.id] / total;
        return (
          <g key={l.id}>
            <ellipse cx={l.cx} cy={l.cy} rx={l.rx * grown} ry={l.ry * grown}
                     transform={`rotate(${l.rot} ${l.cx} ${l.cy})`}
                     fill={`url(#bmG-${l.id})`} stroke={l.color}
                     strokeWidth={active ? 2 : 1} strokeOpacity={active ? 0.95 : 0.5}
                     strokeDasharray={active ? undefined : "4 4"}
                     style={{ transition: "stroke-opacity .25s, stroke-width .25s" }}>
              {grown > 0.9 ? (
                <animate attributeName="fill-opacity"
                         values={thinking ? "0.45;1;0.45" : "0.55;1;0.55"}
                         dur={`${((5.5 - load * 3) * tempo).toFixed(2)}s`} repeatCount="indefinite" />
              ) : null}
            </ellipse>
            <text x={l.cx} y={l.cy - l.ry + 14} fill={l.color} fontSize="10.5"
                  textAnchor="middle" letterSpacing="1.4" opacity={grown}>{l.label}</text>
            <text x={l.cx} y={l.cy - l.ry + 26} fill="#54707f" fontSize="8.5"
                  textAnchor="middle" opacity={grown}>
              {counts[l.id]} appels · {Math.round(load * 100)} %
            </text>
            {grown > 0.9 && !linked.has(l.id) ? (
              <text x={l.cx} y={l.cy + l.ry - 10} fill="#b0728a" fontSize="8.5"
                    textAnchor="middle" letterSpacing="1">
                {counts[l.id] ? "AUCUNE LIAISON OBSERVÉE" : "AIRE INACTIVE"}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* Faisceaux : liaisons réellement observées entre intentions */}
      {edges.map((e, idx) => {
        const a = pos[e.from], b = pos[e.to];
        if (!a || !b) return null;
        const inter = a.lobe.id !== b.lobe.id;
        const mx = (a.x + b.x) / 2 + (b.y - a.y) * (inter ? 0.18 : 0.32);
        const my = (a.y + b.y) / 2 - (b.x - a.x) * (inter ? 0.18 : 0.32);
        const on = !focus || e.from === focus || e.to === focus;
        const d = `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`;
        const pid = `bmP-${slug(e.from)}-${slug(e.to)}`;
        // Signal circulant : réservé aux liaisons les plus fortes, sinon la scène devient illisible.
        const carries = grown > 0.9 && on && idx < (thinking ? 40 : 22);
        const speed = ((3.2 - (e.count / maxEdge) * 2.1) * tempo).toFixed(2);
        return (
          <g key={`${e.from}->${e.to}`}>
            <path id={pid} d={d}
                  fill="none" stroke={inter ? "#d8b875" : a.lobe.color}
                  strokeWidth={0.7 + (e.count / maxEdge) * 2.6}
                  opacity={on ? (inter ? 0.5 : 0.38) : 0.05}
                  markerEnd={focus && on ? "url(#bmArrow)" : undefined}
                  style={{ transition: "opacity .25s" }}>
              <title>{`${e.from} → ${e.to} : ${e.count} enchaînement(s)`}</title>
            </path>
            {carries ? (
              <circle r={1.6 + (e.count / maxEdge) * 1.8} fill={inter ? "#ffe6a3" : a.lobe.color} opacity="0.95">
                <animateMotion dur={`${speed}s`} repeatCount="indefinite" begin={`${(idx % 7) * 0.28}s`}>
                  <mpath href={`#${pid}`} />
                </animateMotion>
                <animate attributeName="opacity" values="0;1;1;0" dur={`${speed}s`}
                         repeatCount="indefinite" begin={`${(idx % 7) * 0.28}s`} />
              </circle>
            ) : null}
          </g>
        );
      })}

      {placed.map((n) => {
        const r = (3.5 + Math.sqrt(n.count / maxCount) * 13) * grown;
        const faded = dimmed(n.id);
        const isFocus = focus === n.id;
        // Cadence de décharge : plus l'intention est sollicitée, plus le halo bat vite.
        const beat = ((2.8 - (n.count / maxCount) * 1.7) * tempo).toFixed(2);
        return (
          <g key={n.id} onMouseEnter={() => setFocus(n.id)}
             style={{ cursor: "pointer", opacity: faded ? 0.18 : 1, transition: "opacity .25s" }}>
            {grown > 0.9 && !faded ? (
              <circle cx={n.x} cy={n.y} r={r} fill="none" stroke={n.lobe.color} strokeWidth="1.2">
                <animate attributeName="r" values={`${r};${r * (2.6 * mp.glow)}`} dur={`${beat}s`} repeatCount="indefinite" />
                <animate attributeName="opacity" values={`${(0.7 * mp.glow).toFixed(2)};0`} dur={`${beat}s`} repeatCount="indefinite" />
              </circle>
            ) : null}
            <circle cx={n.x} cy={n.y} r={r} fill={n.lobe.color} opacity="0.92" />
            <circle cx={n.x} cy={n.y} r={r} fill="none" stroke="rgba(255,255,255,.5)"
                    strokeWidth={isFocus ? 2 : 0.8} />
            {isFocus ? (
              <>
                <rect x={n.x + 10} y={n.y - 20} width={Math.max(92, n.id.length * 6.4)} height="30"
                      fill="rgba(4,17,28,.94)" stroke={n.lobe.color} />
                <text x={n.x + 16} y={n.y - 8} fill="#e6f2f8" fontSize="10.5">{n.id}</text>
                <text x={n.x + 16} y={n.y + 4} fill="#7b97ac" fontSize="9">
                  {n.count} appels · {n.lobe.label}
                </text>
              </>
            ) : null}
            <title>{`${n.id} — ${n.count} appel(s) · aire ${n.lobe.label}`}</title>
          </g>
        );
      })}

      <text x="28" y={H - 44} fill="#54707f" fontSize="9" letterSpacing="1">
        AIRE = REGROUPEMENT FONCTIONNEL DES INTENTIONS ENREGISTRÉES
      </text>
      <text x="28" y={H - 30} fill="#54707f" fontSize="9" letterSpacing="1">
        FAISCEAU DORÉ = LIAISON ENTRE DEUX AIRES · COULEUR = LIAISON INTERNE
      </text>

      {/* État interne : humeur, énergie et réflexion en cours */}
      <g transform="translate(28,34)">
        <circle cx="6" cy="-4" r="5" fill={mp.tint}>
          <animate attributeName="opacity" values="0.35;1;0.35"
                   dur={`${(2.2 * tempo).toFixed(2)}s`} repeatCount="indefinite" />
        </circle>
        <text x="18" y="0" fill={mp.tint} fontSize="10.5" letterSpacing="1.4">{mp.label}</text>
        <text x="18" y="13" fill="#54707f" fontSize="9" letterSpacing="1">
          ÉNERGIE {Math.round(energy * 100)} % · {thinking ? "RÉFLEXION EN COURS" : "AU REPOS"}
        </text>
      </g>
      {thinking && grown > 0.9 ? (
        <circle cx="390" cy="270" r="40" fill="none" stroke={mp.tint} strokeWidth="1.4" opacity="0.5">
          <animate attributeName="r" values="40;300" dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.45;0" dur="2.4s" repeatCount="indefinite" />
        </circle>
      ) : null}
      <text x={W - 28} y={H - 30} fill="#3f5a69" fontSize="8.5" textAnchor="end" letterSpacing="1">
        {nodes.length} INTENTIONS · {edges.length} FAISCEAUX · {LOBES.length} AIRES
      </text>
    </svg>
  );
}
