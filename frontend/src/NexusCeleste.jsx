// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
// Carte réelle des modules : taille des nœuds = invocations mesurées, liens = transitions
// réellement observées entre deux commandes consécutives. Aucune valeur n'est simulée.
import { useEffect, useMemo, useRef, useState } from "react";
import { X, Orbit, Radio, GaugeCircle, Waves } from "lucide-react";
import BrainMap, { LOBES, lobeOf } from "./BrainMap";
import "./ZeusCortex.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const PALETTE = ["#7fb2d4", "#6fae9f", "#c2925a", "#8d8fc4", "#b0728a", "#d8b875"];

const nf = (n) => Number(n || 0).toLocaleString("fr-FR");
const slugId = (s) => String(s).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
const polar = (cx, cy, r, a) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
const arcPath = (cx, cy, r, a0, a1) => {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1}`;
};
const ago = (iso) => {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (diff < 1) return "aujourd'hui";
  if (diff < 2) return "hier";
  return `il y a ${Math.round(diff)} j`;
};

/* Graphe radial : rayon du nœud proportionnel au nombre d'appels mesurés. */
function Graph({ nodes, edges }) {
  const [grown, setGrown] = useState(0);
  const [focus, setFocus] = useState(null);
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

  if (!nodes.length) return <div className="zcx-empty">Aucun module encore sollicité.</div>;

  const W = 780, H = 540, cx = 390, cy = 258, R = 148;
  const maxCount = Math.max(...nodes.map((n) => n.count), 1);
  const maxEdge = Math.max(...edges.map((e) => e.count), 1);
  const totalCount = nodes.reduce((a, n) => a + n.count, 0) || 1;

  // Le plus sollicité est placé en haut, les suivants alternent de part et d'autre :
  // les gros nœuds restent ainsi écartés au lieu de s'agglutiner.
  const ordered = [...nodes].sort((a, b) => b.count - a.count);
  const slots = [];
  ordered.forEach((n, i) => (i % 2 ? slots.push(n) : slots.unshift(n)));

  const pos = {};
  slots.forEach((n, i) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / slots.length;
    pos[n.id] = {
      x: cx + Math.cos(a) * R * grown,
      y: cy + Math.sin(a) * R * grown,
      a,
      r: 6 + Math.sqrt(n.count / maxCount) * 17,
      color: PALETTE[slots.indexOf(n) % PALETTE.length],
      code: `M${String(ordered.indexOf(n) + 1).padStart(2, "0")}`,
      share: n.count / totalCount,
    };
  });

  const dim = (id) => focus && focus !== id;
  const edgeActive = (e) => !focus || e.from === focus || e.to === focus;
  const halfSpan = Math.PI / slots.length * 0.82;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} data-testid="nexus-graph-svg"
         onMouseLeave={() => setFocus(null)} style={{ fontFamily: "Rajdhani, sans-serif" }}>
      <defs>
        <radialGradient id="nxHub">
          <stop offset="0%" stopColor="#ffe6a3" stopOpacity="0.5" />
          <stop offset="70%" stopColor="#d8b875" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#d8b875" stopOpacity="0" />
        </radialGradient>
        {slots.map((n) => (
          <radialGradient id={`nxGlow-${slugId(n.id)}`} key={n.id}>
            <stop offset="35%" stopColor={pos[n.id].color} stopOpacity="0.7" />
            <stop offset="100%" stopColor={pos[n.id].color} stopOpacity="0" />
          </radialGradient>
        ))}
        {slots.map((n) => {
          const p = pos[n.id];
          const mx = cx + (p.x - cx) * 0.55 + Math.cos(p.a + Math.PI / 2) * 20;
          const my = cy + (p.y - cy) * 0.55 + Math.sin(p.a + Math.PI / 2) * 20;
          return <path id={`nxPath-${slugId(n.id)}`} key={n.id} d={`M${cx},${cy} Q${mx},${my} ${p.x},${p.y}`} />;
        })}
        <marker id="nxArrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="rgba(216,184,117,.85)" />
        </marker>
      </defs>

      {/* Cadre technique */}
      {[[18, 18, 1, 1], [W - 18, 18, -1, 1], [18, H - 18, 1, -1], [W - 18, H - 18, -1, -1]].map(([x, y, sx, sy]) => (
        <path key={`${x}-${y}`} d={`M${x},${y + sy * 16} L${x},${y} L${x + sx * 16},${y}`}
              fill="none" stroke="rgba(216,184,117,.5)" strokeWidth="1.4" />
      ))}

      {/* Graduations angulaires tous les 15° */}
      {Array.from({ length: 24 }, (_, i) => {
        const a = -Math.PI / 2 + i * Math.PI / 12;
        const major = i % 6 === 0;
        const [x0, y0] = polar(cx, cy, R + 30, a);
        const [x1, y1] = polar(cx, cy, R + (major ? 40 : 35), a);
        return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1}
                     stroke={major ? "rgba(216,184,117,.55)" : "rgba(255,255,255,.14)"} strokeWidth={major ? 1.3 : 0.8} />;
      })}

      {/* Cercles d'échelle : 25 / 50 / 75 / 100 % du volume maximal */}
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <circle cx={cx} cy={cy} r={R * f} fill="none" stroke="rgba(255,255,255,.05)" strokeDasharray="1 8" />
          <text x={cx + 3} y={cy - R * f - 2} fill="#3f5a69" fontSize="8">{Math.round(maxCount * f)}</text>
        </g>
      ))}
      <line x1={cx - R - 22} y1={cy} x2={cx + R + 22} y2={cy} stroke="rgba(255,255,255,.05)" />
      <line x1={cx} y1={cy - R - 22} x2={cx} y2={cy + R + 22} stroke="rgba(255,255,255,.05)" />
      <circle cx={cx} cy={cy} r="70" fill="url(#nxHub)" />

      {/* Arc de part de trafic, centré sur l'angle de chaque module */}
      {slots.map((n) => {
        const p = pos[n.id];
        const w = Math.max(0.05, p.share * 2 * halfSpan / Math.max(...slots.map((s) => pos[s.id].share)));
        return (
          <path key={`arc-${n.id}`} d={arcPath(cx, cy, R + 24, p.a - w / 2, p.a + w / 2)}
                fill="none" stroke={p.color} strokeWidth="5" strokeLinecap="round"
                opacity={dim(n.id) ? 0.12 : 0.85} style={{ transition: "opacity .25s" }}>
            <title>{`${n.id} — ${(p.share * 100).toFixed(1)} % du trafic`}</title>
          </path>
        );
      })}

      {/* Liaisons noyau → module, avec impulsions circulant au rythme du volume */}
      {slots.map((n) => {
        const p = pos[n.id];
        return (
          <g key={`hub-${n.id}`}>
            <use href={`#nxPath-${slugId(n.id)}`} fill="none" stroke={p.color}
                 strokeWidth={1 + (n.count / maxCount) * 4.5}
                 opacity={dim(n.id) ? 0.07 : 0.3} style={{ transition: "opacity .25s" }} />
            {grown > 0.95 && !dim(n.id) ? (
              <circle r={2.2} fill="#ffe6a3" opacity="0.9">
                <animateMotion dur={`${(2.4 - (n.count / maxCount) * 1.4).toFixed(2)}s`} repeatCount="indefinite">
                  <mpath href={`#nxPath-${slugId(n.id)}`} />
                </animateMotion>
              </circle>
            ) : null}
          </g>
        );
      })}

      {/* Enchaînements entre modules : corde orientée, flèche au but */}
      {edges.map((e) => {
        const a = pos[e.from], b = pos[e.to];
        if (!a || !b) return null;
        const mx = cx + ((a.x + b.x) / 2 - cx) * 0.22;
        const my = cy + ((a.y + b.y) / 2 - cy) * 0.22;
        return (
          <path
            key={`${e.from}->${e.to}`}
            d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`}
            fill="none" stroke={a.color}
            strokeWidth={0.9 + (e.count / maxEdge) * 3}
            opacity={edgeActive(e) ? 0.5 : 0.05}
            strokeLinecap="round"
            markerEnd={focus && edgeActive(e) ? "url(#nxArrow)" : undefined}
            style={{ transition: "opacity .25s" }}
          >
            <title>{`${e.from} → ${e.to} : ${e.count} enchaînement(s)`}</title>
          </path>
        );
      })}

      {slots.map((n) => {
        const p = pos[n.id];
        const right = Math.cos(p.a) > -0.05;
        const [lx, ly] = polar(cx, cy, R + 46, p.a);
        const faded = dim(n.id);
        const anchor = right ? "start" : "end";
        const sx = right ? 1 : -1;
        return (
          <g key={n.id}
             onMouseEnter={() => setFocus(n.id)}
             style={{ cursor: "pointer", opacity: faded ? 0.2 : 1, transition: "opacity .25s" }}>
            <circle cx={p.x} cy={p.y} r={p.r * 2.2} fill={`url(#nxGlow-${slugId(n.id)})`} opacity={focus === n.id ? 0.95 : 0.4} />
            <circle cx={p.x} cy={p.y} r={p.r} fill={p.color} opacity="0.92" />
            <circle cx={p.x} cy={p.y} r={p.r} fill="none" stroke="rgba(255,255,255,.45)" strokeWidth={focus === n.id ? 2 : 0.9} />
            <text x={p.x} y={p.y + 3} fill="#04111c" fontSize="8.5" textAnchor="middle" fontWeight="700">{p.code}</text>
            <text x={lx} y={ly - 4} fill="#e6f2f8" fontSize="11.5" textAnchor={anchor}>{n.id}</text>
            <text x={lx} y={ly + 9} fill="#7b97ac" fontSize="9.5" textAnchor={anchor}>
              {nf(n.count)} appels · {(p.share * 100).toFixed(1)} %
            </text>
            <line x1={lx - sx * 2} y1={ly + 14} x2={lx + sx * 42} y2={ly + 14} stroke={p.color} strokeWidth="1.6" opacity="0.5" />
            <title>{`${n.id} — ${n.count} appel(s), dernier ${ago(n.last)}`}</title>
          </g>
        );
      })}

      <circle cx={cx} cy={cy} r="32" fill="rgba(10,20,32,.94)" stroke="rgba(216,184,117,.65)" />
      <circle cx={cx} cy={cy} r="38" fill="none" stroke="rgba(216,184,117,.22)" strokeDasharray="3 5" />
      <text x={cx} y={cy - 2} fill="#ffe6a3" fontSize="12.5" textAnchor="middle" fontFamily="Cinzel">ΣIRIUS</text>
      <text x={cx} y={cy + 10} fill="#7b97ac" fontSize="8" textAnchor="middle" letterSpacing="1">NOYAU</text>
      <text x={cx} y={cy + 21} fill="#6fae9f" fontSize="8.5" textAnchor="middle">{nf(totalCount)}</text>

      {/* Légende d'échelle */}
      <g transform={`translate(28,${H - 54})`}>
        <text x="0" y="0" fill="#54707f" fontSize="9" letterSpacing="1">ÉCHELLE · RAYON = VOLUME D'APPELS</text>
        <text x="0" y="14" fill="#54707f" fontSize="9" letterSpacing="1">ARC EXTERNE = PART DU TRAFIC</text>
        <text x="0" y="28" fill="#54707f" fontSize="9" letterSpacing="1">IMPULSION = FRÉQUENCE DE SOLLICITATION</text>
      </g>
      <text x={W - 28} y={H - 40} fill="#54707f" fontSize="9" textAnchor="end" letterSpacing="1">
        {slots.length} MODULES · {edges.length} LIAISONS
      </text>
      <text x={W - 28} y={H - 26} fill="#3f5a69" fontSize="8.5" textAnchor="end" letterSpacing="1">
        SURVOLEZ UN MODULE POUR ISOLER SES LIAISONS
      </text>
    </svg>
  );
}

export default function NexusCeleste({ onClose, mood, status }) {
  const [latency, setLatency] = useState(null);
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState("");
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const load = async () => {
      const t0 = performance.now();
      try {
        const r = await fetch(`${API}/nexus/graph`, { credentials: "include" });
        const j = await r.json();
        if (!aliveRef.current) return;
        setLatency(Math.round(performance.now() - t0));
        setGraph(j);
        setError("");
      } catch (e) {
        if (aliveRef.current) { setLatency(null); setError("Nexus injoignable — le noyau ne répond pas."); }
      }
    };
    load();
    const id = setInterval(load, 8000);
    return () => { aliveRef.current = false; clearInterval(id); };
  }, []);

  const nodes = useMemo(() => graph?.nodes || [], [graph]);
  const edges = useMemo(() => graph?.edges || [], [graph]);
  const maxCount = Math.max(...nodes.map((n) => n.count), 1);
  const totalCalls = nodes.reduce((a, n) => a + n.count, 0);
  const [view, setView] = useState("brain");
  const maxEdge = Math.max(...edges.map((e) => e.count), 1);
  // Sollicitation en cours : le flux visuel s'accélère tant que ΣIRIUS réfléchit ou répond.
  const busy = status === "thinking" || status === "speaking";
  const energy = Math.max(0.25, Math.min(1, (mood?.energie ?? 70) / 100));
  const tempoFactor = (busy ? 0.45 : 1) * (1.3 - energy * 0.5);
  const lobeStats = useMemo(() => {
    const acc = Object.fromEntries(LOBES.map((l) => [l.id, 0]));
    nodes.forEach((n) => { acc[lobeOf(n.id)] += n.count; });
    return LOBES.map((l) => ({ ...l, count: acc[l.id] }))
      .sort((a, b) => b.count - a.count);
  }, [nodes]);
  const maxLobe = Math.max(...lobeStats.map((l) => l.count), 1);

  return (
    <div className="prime-screen zcx" data-testid="nexus-panel">
      <header className="zeus-head zcx-head">
        <div>
          <h1 className="zeus-title font-divine" style={{ fontSize: 26 }}><Orbit size={22} /> NEXUS CÉLESTE</h1>
          <p className="zcx-sub">CARTE DES MODULES · LIENS RÉELLEMENT OBSERVÉS</p>
        </div>
        <div className="zcx-spacer" />
        <div className="zcx-metrics">
          <div className="zcx-hm"><span>MODULES ACTIFS</span><b>{nodes.length}</b></div>
          <div className="zcx-hm"><span>APPELS CUMULÉS</span><b>{nf(totalCalls)}</b></div>
          <div className="zcx-hm"><span>SANTÉ SERVICES</span><b>{graph?.health != null ? `${graph.health} %` : "—"}</b></div>
        </div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="nexus-close-btn"><X size={18} /></button>
      </header>

      {error ? <div className="zcx-empty" style={{ margin: 16 }} data-testid="nexus-error">{error}</div> : null}

      <div className="zcx-row zcx-rA">
        <div className="zcx-cell" data-testid="nexus-graph">
          <h2><Orbit size={13} style={{ marginRight: 6 }} />
            {view === "brain" ? "CARTE CORTICALE" : "RÉSEAU DES MODULES"}
          </h2>
          <p className="zcx-h2sub">
            {view === "brain"
              ? "Intentions regroupées par aire fonctionnelle · faisceaux = enchaînements observés"
              : "Rayon = nombre d'appels · épaisseur du lien = enchaînements observés"}
          </p>
          <div className="nx-views" data-testid="nexus-view-switch">
            <button type="button" className={view === "radial" ? "on" : ""}
                    onClick={() => setView("radial")} data-testid="nexus-view-radial">RÉSEAU RADIAL</button>
            <button type="button" className={view === "brain" ? "on" : ""}
                    onClick={() => setView("brain")} data-testid="nexus-view-brain">CARTE CORTICALE</button>
          </div>
          {view === "brain"
            ? <BrainMap nodes={nodes} edges={edges} mood={mood} status={status} />
            : <Graph nodes={nodes} edges={edges} />}
        </div>

        <div className="zcx-cell alt">
          <h2><Waves size={13} style={{ marginRight: 6 }} />RÉPARTITION PAR AIRE</h2>
          <p className="zcx-h2sub">Volume d'appels regroupé par aire fonctionnelle</p>
          <div data-testid="nexus-lobes">
            {lobeStats.map((l) => (
              <div className="zcx-bar" key={l.id}>
                <em title={l.role}>{l.label}</em>
                <div className="zcx-track">
                  <div className="zcx-fill" style={{ width: `${l.count / maxLobe * 100}%`, background: l.color }} />
                </div>
                <b>{nf(l.count)}</b>
              </div>
            ))}
          </div>

          <h2 style={{ marginTop: 18 }}><Waves size={13} style={{ marginRight: 6 }} />SOLLICITATION</h2>
          <p className="zcx-h2sub">Part de chaque intention dans les commandes</p>
          <div data-testid="nexus-levels" style={{ maxHeight: 210, overflowY: "auto" }}>
            {nodes.length ? nodes.map((n, i) => (
              <div className="zcx-bar" key={n.id}>
                <em title={n.id}>{n.id}</em>
                <div className="zcx-track nx-flow-track">
                  <div className="zcx-fill" style={{ width: `${n.count / maxCount * 100}%`, background: PALETTE[i % PALETTE.length], transitionDelay: `${i * 30}ms` }} />
                  <span className="nx-spark" style={{
                    background: PALETTE[i % PALETTE.length],
                    animationDuration: `${(2.8 - (n.count / maxCount) * 1.6) * tempoFactor}s`,
                    animationDelay: `${(i % 6) * 0.22}s`,
                  }} />
                </div>
                <b>{nf(n.count)}</b>
              </div>
            )) : <div className="zcx-empty">Aucun module sollicité.</div>}
          </div>

          <h2 style={{ marginTop: 18 }}><GaugeCircle size={13} style={{ marginRight: 6 }} />MÉTRIQUES</h2>
          <div className="zcx-prov">
            <span className="nm"><Radio size={11} style={{ marginRight: 5 }} />Latence aller-retour</span>
            <span className="val" data-testid="nexus-latency">{latency != null ? `${latency} ms` : "—"}</span>
          </div>
          <div className="zcx-prov">
            <span className="nm">Accès base de données</span>
            <span className="val">{graph?.db_ms != null ? `${graph.db_ms} ms` : "—"}</span>
          </div>
          <div className="zcx-prov">
            <span className="nm">Enchaînements distincts</span>
            <span className="val">{edges.length}</span>
          </div>
        </div>
      </div>

      <div className="zcx-row zcx-rD">
        <div className="zcx-cell">
          <h2>ENCHAÎNEMENTS OBSERVÉS</h2>
          <p className="zcx-h2sub">Transitions les plus fréquentes entre deux commandes consécutives</p>
          <div data-testid="nexus-edges" style={{ maxHeight: 300, overflowY: "auto" }}>
            {edges.length ? edges.map((e, i) => (
              <div className="nx-flow" key={`${e.from}->${e.to}`}>
                <em title={`${e.from} → ${e.to}`}>
                  {e.from} <span className="nx-arrow">→</span> {e.to}
                </em>
                <div className="zcx-track nx-flow-track">
                  <div
                    className="zcx-fill"
                    style={{
                      width: `${e.count / maxEdge * 100}%`,
                      background: PALETTE[i % PALETTE.length],
                      transitionDelay: `${i * 40}ms`,
                    }}
                  />
                  <span
                    className="nx-spark"
                    style={{
                      background: PALETTE[i % PALETTE.length],
                      animationDuration: `${(2.6 - (e.count / maxEdge) * 1.5) * tempoFactor}s`,
                      animationDelay: `${(i % 6) * 0.25}s`,
                    }}
                  />
                </div>
                <b>{e.count}</b>
              </div>
            )) : <div className="zcx-empty">Pas encore d'enchaînement observé.</div>}
          </div>
        </div>

        <div className="zcx-cell alt">
          <h2>SERVICES JOURNALISÉS</h2>
          <p className="zcx-h2sub">Taux de succès relevé dans le journal de service</p>
          <div data-testid="nexus-services">
            {(graph?.services || []).map((s) => (
              <div className="zcx-prov" key={s.service}>
                <span className="st" style={{ background: s.ok_rate >= 95 ? "#6fae9f" : s.ok_rate >= 60 ? "#c2925a" : "#b0728a" }} />
                <span className="nm">{s.service}</span>
                <span className="val">{nf(s.calls)} appels</span>
                <span className="val" style={{ width: 56, textAlign: "right" }}>{s.ok_rate} %</span>
              </div>
            ))}
            {!graph?.services?.length ? <div className="zcx-empty">Aucun service journalisé.</div> : null}
          </div>
        </div>
      </div>

      <div className="zcx-foot">
        <div>Dernière mesure <b>{graph?.generated_at ? new Date(graph.generated_at).toLocaleTimeString("fr-FR") : "—"}</b></div>
        <div>Sources <b>events · service_log</b></div>
        <div>Nœuds <b>{nodes.length}</b></div>
        <div>Liens <b>{edges.length}</b></div>
      </div>
    </div>
  );
}

