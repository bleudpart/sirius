// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import { Workflow, X, Cast, Loader2, Maximize } from "lucide-react";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const TYPE_COLORS = { user: "#fbbf24", ui: "#22d3ee", service: "#5eead4", database: "#a78bfa", external: "#fb7185" };
const TYPE_LABELS = { user: "ACTEUR", ui: "INTERFACE", service: "SERVICE", database: "BASE DE DONNÉES", external: "EXTERNE" };

// Placement automatique en colonnes (niveaux BFS depuis les nœuds sans lien entrant)
function computeLayout(diagram) {
  const nodes = (diagram.noeuds || []).slice(0, 12);
  const ids = new Set(nodes.map((n) => n.id));
  const links = (diagram.liens || []).filter((l) => ids.has(l.de) && ids.has(l.vers) && l.de !== l.vers);
  const incoming = {};
  links.forEach((l) => { incoming[l.vers] = (incoming[l.vers] || 0) + 1; });
  const level = {};
  let frontier = nodes.filter((n) => !incoming[n.id]).map((n) => n.id);
  if (!frontier.length && nodes.length) frontier = [nodes[0].id];
  frontier.forEach((id) => { level[id] = 0; });
  let cur = frontier, depth = 0, guard = 0;
  while (cur.length && guard++ < 24) {
    const next = [];
    links.forEach((l) => {
      if (cur.includes(l.de) && level[l.vers] === undefined) { level[l.vers] = depth + 1; next.push(l.vers); }
    });
    cur = next; depth += 1;
  }
  nodes.forEach((n) => { if (level[n.id] === undefined) level[n.id] = Math.min(depth, 1); });
  const byLevel = {};
  nodes.forEach((n) => { (byLevel[level[n.id]] = byLevel[level[n.id]] || []).push(n); });
  const levels = Object.keys(byLevel).map(Number).sort((a, b) => a - b);
  const W = 172, H = 58, GX = 240, GY = 96;
  const maxRows = Math.max(1, ...levels.map((lv) => byLevel[lv].length));
  const totalH = maxRows * GY;
  const pos = {};
  levels.forEach((lv, li) => {
    const col = byLevel[lv];
    col.forEach((n, ri) => {
      pos[n.id] = { x: 30 + li * GX, y: 30 + ri * GY + (totalH - col.length * GY) / 2 };
    });
  });
  return { nodes, links, pos, W, H, width: 60 + (levels.length - 1) * GX + W, height: totalH + 60 };
}

// Diagramme SVG holographique avec construction progressive (effet "wahou")
export function DiagramSVG({ diagram, animKey }) {
  if (!diagram || !(diagram.noeuds || []).length) return null;
  const { nodes, links, pos, W, H, width, height } = computeLayout(diagram);
  const nodeDelay = 0.3;
  const edgeStart = nodes.length * nodeDelay + 0.2;
  return (
    <svg key={animKey} viewBox={`0 0 ${width} ${height}`} className="dg-svg" data-testid="architect-diagram">
      <defs>
        <marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#22d3ee" />
        </marker>
      </defs>
      {links.map((l, j) => {
        const a = pos[l.de], b = pos[l.vers];
        const x1 = a.x + W / 2, y1 = a.y + H / 2, x2 = b.x + W / 2, y2 = b.y + H / 2;
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        return (
          <g key={`e${j}`}>
            <line
              className="dg-edge" x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="rgba(34,211,238,0.6)" strokeWidth="1.6" markerEnd="url(#dg-arrow)"
              style={{ animationDelay: `${edgeStart + j * 0.22}s` }}
            />
            {l.label && (
              <text className="dg-elabel" x={mx} y={my - 6} textAnchor="middle"
                style={{ animationDelay: `${edgeStart + j * 0.22 + 0.3}s` }}>
                {l.label}
              </text>
            )}
          </g>
        );
      })}
      {nodes.map((n, i) => {
        const p = pos[n.id];
        const c = TYPE_COLORS[n.type] || "#22d3ee";
        return (
          <g key={n.id} className="dg-node" style={{ animationDelay: `${i * nodeDelay}s` }} data-testid={`architect-node-${n.id}`}>
            <rect x={p.x} y={p.y} width={W} height={H} rx="4"
              fill="rgba(4,17,28,0.92)" stroke={c} strokeWidth="1.4"
              style={{ filter: `drop-shadow(0 0 7px ${c}66)` }} />
            <rect x={p.x} y={p.y} width="4" height={H} fill={c} />
            <text x={p.x + 14} y={p.y + 24} className="dg-nlabel">{(n.label || n.id).slice(0, 24)}</text>
            <text x={p.x + 14} y={p.y + 44} className="dg-ntype" fill={c}>{TYPE_LABELS[n.type] || "COMPOSANT"}</text>
          </g>
        );
      })}
    </svg>
  );
}

const loadDiagram = () => {
  try { return JSON.parse(localStorage.getItem("sirius_diagram")) || null; } catch { return null; }
};

// Panneau "Architecte visuel" : description en langage naturel -> diagramme animé
export function ArchitectPanel({ keys, initialPrompt, onClose, onSpeak }) {
  const [desc, setDesc] = useState(initialPrompt || "");
  const [diagram, setDiagram] = useState(loadDiagram);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [animKey, setAnimKey] = useState(1);
  const chanRef = useRef(null);

  useEffect(() => {
    try { chanRef.current = new BroadcastChannel("sirius-diagram"); } catch (e) {}
    return () => { try { chanRef.current && chanRef.current.close(); } catch (e) {} };
  }, []);

  const generate = async (text) => {
    const description = (text || desc || "").trim();
    if (!description || loading) return;
    setLoading(true);
    setError("");
    try {
      const resp = await fetch(`${API}/diagram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, keys: keys || {} }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || "Erreur de génération");
      setDiagram(data);
      setAnimKey(Date.now());
      localStorage.setItem("sirius_diagram", JSON.stringify(data));
      try { chanRef.current && chanRef.current.postMessage(data); } catch (e) {}
      if (onSpeak) onSpeak(`Architecture ${data.titre || ""} générée, avec ${(data.noeuds || []).length} composants.`);
    } catch (e) {
      setError(e.message || "Sirius n'a pas pu dessiner ce diagramme. Vérifiez votre clé Kimi K3.");
    }
    setLoading(false);
  };

  // Lancement automatique quand on arrive par commande vocale
  const autoRef = useRef(false);
  useEffect(() => {
    if (initialPrompt && !autoRef.current) { autoRef.current = true; generate(initialPrompt); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openTV = () => {
    window.open(window.location.pathname + "?spectateur=1", "sirius-tv", "width=1280,height=720");
  };

  return (
    <div className="setup-screen" data-testid="sirius-architect-panel" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="setup-grid-bg" />
      <div className="setup-card architect-modal">
        <button className="setup-close" onClick={onClose} data-testid="architect-close-btn"><X size={18} /></button>
        <div className="setup-head">
          <Workflow size={22} />
          <div>
            <h2 className="setup-title">Architecte visuel</h2>
            <p className="setup-sub">Décrivez ce que vous voulez, Sirius dessine l'architecture sous vos yeux.</p>
          </div>
        </div>

        <div className="architect-bar">
          <input
            className="cmd-input"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") generate(); }}
            placeholder="Ex : une application de livraison avec 3 types d'utilisateurs et une base de données"
            data-testid="architect-input"
          />
          <button className="cmd-send" onClick={() => generate()} disabled={loading} data-testid="architect-generate-btn">
            {loading ? <Loader2 size={16} className="dg-spin" /> : <Workflow size={16} />}
            {loading ? "SIRIUS DESSINE..." : "GÉNÉRER AVEC L'IA"}
          </button>
          <button className="setup-io-btn" onClick={openTV} title="Ouvre une fenêtre spectateur à diffuser sur la TV (Cast / HDMI)" data-testid="architect-tv-btn">
            <Cast size={15} /> MODE TV
          </button>
        </div>

        {error && <div className="setup-warn" data-testid="architect-error">{error}</div>}

        <div className="architect-canvas" data-testid="architect-canvas">
          {diagram ? (
            <>
              <div className="architect-title" data-testid="architect-title">{diagram.titre}</div>
              <DiagramSVG diagram={diagram} animKey={animKey} />
            </>
          ) : (
            <div className="architect-empty">
              Aucun diagramme pour l'instant. Décrivez votre idée ci-dessus,
              ou dites : « Sirius, dessine-moi l'architecture d'une application de livraison ».
            </div>
          )}
        </div>
        <div className="memory-foot">
          Mode TV : ouvrez la fenêtre spectateur puis diffusez-la sur votre télé (Cast d'onglet Chrome, Miracast ou câble HDMI).
          Le diagramme s'y met à jour en temps réel.
        </div>
      </div>
    </div>
  );
}

// Vue spectateur plein écran (grand affichage / réunion) — synchronisée en temps réel
export function SpectatorView() {
  const [diagram, setDiagram] = useState(loadDiagram);
  const [animKey, setAnimKey] = useState(1);
  useEffect(() => {
    let chan;
    try {
      chan = new BroadcastChannel("sirius-diagram");
      chan.onmessage = (e) => { setDiagram(e.data); setAnimKey(Date.now()); };
    } catch (e) {}
    return () => { try { chan && chan.close(); } catch (e) {} };
  }, []);
  const goFullscreen = () => { try { document.documentElement.requestFullscreen(); } catch (e) {} };
  return (
    <div className="spectator-view" data-testid="spectator-view">
      <div className="setup-grid-bg" />
      <header className="spectator-head">
        <span className="spectator-brand"><Workflow size={18} /> SIRIUS · DESIGN REVIEW</span>
        <span className="spectator-title" data-testid="spectator-title">{diagram ? diagram.titre : "EN ATTENTE DU DIAGRAMME..."}</span>
        <button className="setup-io-btn" onClick={goFullscreen} data-testid="spectator-fullscreen-btn"><Maximize size={15} /> PLEIN ÉCRAN</button>
      </header>
      <div className="spectator-canvas">
        {diagram ? (
          <DiagramSVG diagram={diagram} animKey={animKey} />
        ) : (
          <div className="architect-empty">Générez un diagramme depuis le HUD Sirius : il apparaîtra ici en direct.</div>
        )}
      </div>
    </div>
  );
}
