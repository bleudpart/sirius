// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
// Tableau de bord ZEUS CORTEX : chaque valeur provient d'une mesure réelle
// (tables events / facts / service_log et relevé psutil). Aucun signal n'est simulé.
import { useEffect, useMemo, useRef, useState } from "react";
import { X, Send } from "lucide-react";
import "./ZeusCortex.css";

const API = process.env.REACT_APP_BACKEND_URL;
const PALETTE = ["#7fb2d4", "#6fae9f", "#c2925a", "#8d8fc4", "#b0728a"];
const DAYS_FR = ["DIM", "LUN", "MAR", "MER", "JEU", "VEN", "SAM"];

const nf = (n) => Number(n || 0).toLocaleString("fr-FR");
const hhmm = (iso) => {
  try { return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }
  catch (e) { return "--:--"; }
};
const shortDate = (iso) => {
  try { return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }); }
  catch (e) { return ""; }
};

function useCountUp(target, decimals = 0) {
  const [shown, setShown] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    const to = Number(target) || 0;
    const t0 = performance.now();
    let raf;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 900);
      setShown(from + (to - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown.toLocaleString("fr-FR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function Kpi({ label, value, hint, suffix = "", delay = 0 }) {
  const shown = useCountUp(value);
  return (
    <div className="zcx-kpi" style={{ animationDelay: `${delay}ms` }}>
      <span>{label}</span>
      <b>{shown}{suffix}</b>
      {hint ? <i>{hint}</i> : null}
    </div>
  );
}

function Timeline({ points, range }) {
  const total = points.reduce((a, p) => a + p.count, 0);
  if (!points.length || total === 0) {
    return (
      <div className="zcx-empty" data-testid="zeus-timeline-empty">
        Aucune commande enregistrée sur la période.
        {range?.last ? <><br />Dernière activité connue : {shortDate(range.last)}.</> : null}
      </div>
    );
  }
  const W = 760, H = 208, L = 40, R = 10, T = 12, B = 34;
  const max = Math.max(...points.map((p) => p.count)) || 1;
  const bw = (W - L - R) / points.length;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ma = points.map((_, i) => {
    const s = points.slice(Math.max(0, i - 6), i + 1);
    return s.reduce((a, p) => a + p.count, 0) / s.length;
  });
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} data-testid="zeus-timeline">
        {[0, Math.round(max / 2), max].map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke="rgba(255,255,255,.06)" />
            <text x={L - 8} y={y(g) + 3.5} fill="#54707f" fontSize="9.5" textAnchor="end">{g}</text>
          </g>
        ))}
        {points.map((p, i) => (
          <rect key={p.date} x={L + i * bw + 1.4} y={y(p.count)} width={Math.max(1, bw - 2.8)}
                height={(H - T - B) * p.count / max}
                fill={i === points.length - 1 ? "#ffe6a3" : "rgba(127,178,212,.68)"}>
            <title>{`${shortDate(p.date)} — ${p.count} commande(s)`}</title>
          </rect>
        ))}
        <polyline points={ma.map((v, i) => `${L + i * bw + bw / 2},${y(v)}`).join(" ")} fill="none" stroke="#d8b875" strokeWidth="1.9" />
        {[0, Math.floor(points.length / 2), points.length - 1].map((i) => (
          <text key={i} x={L + i * bw + bw / 2} y={H - 14} fill="#54707f" fontSize="9.5" textAnchor="middle">{shortDate(points[i].date)}</text>
        ))}
      </svg>
      <div className="zcx-legend">
        <span className="zcx-lg"><span className="zcx-sw" style={{ background: "#7fb2d4" }} />Commandes / jour</span>
        <span className="zcx-lg"><span className="zcx-sw" style={{ background: "#d8b875" }} />Moyenne mobile 7 j</span>
      </div>
    </>
  );
}

function Radar({ subs }) {
  const axes = [
    { key: "langage", label: "LANGAGE" }, { key: "logique", label: "LOGIQUE" },
    { key: "vision", label: "VISION" }, { key: "intuition", label: "INTUITION" },
  ];
  const cx = 160, cy = 118, R = 84;
  const [grown, setGrown] = useState(0);
  useEffect(() => {
    const t0 = performance.now();
    let raf;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 900);
      setGrown(1 - Math.pow(1 - p, 3));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [subs]);
  const pt = (i, r) => {
    const a = -Math.PI / 2 + i * 2 * Math.PI / axes.length;
    return [cx + Math.cos(a) * R * r, cy + Math.sin(a) * R * r];
  };
  const vals = axes.map((a) => Math.min(1, (subs?.[a.key] ?? 0) / 100));
  return (
    <svg viewBox="0 0 320 236" width="100%" height="236" data-testid="zeus-radar">
      {[0.25, 0.5, 0.75, 1].map((r) => (
        <polygon key={r} points={axes.map((_, i) => pt(i, r).join(",")).join(" ")} fill="none" stroke="rgba(255,255,255,.07)" />
      ))}
      {axes.map((_, i) => {
        const [x, y] = pt(i, 1);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(255,255,255,.07)" />;
      })}
      <polygon points={vals.map((v, i) => pt(i, v * grown).join(",")).join(" ")} fill="rgba(127,178,212,.22)" stroke="#7fb2d4" strokeWidth="1.9" />
      {vals.map((v, i) => { const [x, y] = pt(i, v * grown); return <circle key={i} cx={x} cy={y} r="2.8" fill="#ffe6a3" />; })}
      {axes.map((a, i) => {
        const [x, y] = pt(i, 1.26);
        return <text key={a.key} x={x} y={y + 3} fill="#7b97ac" fontSize="9.5" textAnchor="middle">{a.label} {Math.round(subs?.[a.key] ?? 0)}%</text>;
      })}
    </svg>
  );
}

function Heatmap({ grid }) {
  const flat = grid.flat();
  const max = Math.max(...flat, 1);
  if (!flat.some((v) => v > 0)) return <div className="zcx-empty">Aucune donnée horaire disponible.</div>;
  const L = 46, T = 20, cw = 47.5, chh = 17, gap = 2;
  const color = (v) => {
    if (!v) return "rgba(255,255,255,.035)";
    const r = v / max;
    return `rgba(${Math.round(110 + 120 * r)},${Math.round(160 + 50 * r)},${Math.round(205 - 40 * r)},${0.18 + 0.78 * r})`;
  };
  return (
    <div className="zcx-heat-scroll">
      <svg viewBox="0 0 1240 176" width="100%" height="176" className="zcx-heat" data-testid="zeus-heatmap">
        {grid.map((rowVals, d) => (
          <g key={d}>
            <text x={L - 10} y={T + d * (chh + gap) + 12} fill="#54707f" fontSize="9.5" textAnchor="end">{DAYS_FR[d]}</text>
            {rowVals.map((v, h) => (
              <rect key={h} x={L + h * cw} y={T + d * (chh + gap)} width={cw - gap} height={chh} fill={color(v)}>
                <title>{`${DAYS_FR[d]} ${String(h).padStart(2, "0")}h — ${v} commande(s)`}</title>
              </rect>
            ))}
          </g>
        ))}
        {Array.from({ length: 8 }, (_, k) => k * 3).map((h) => (
          <text key={h} x={L + h * cw + (cw - gap) / 2} y={T - 7} fill="#54707f" fontSize="9" textAnchor="middle">{String(h).padStart(2, "0")}h</text>
        ))}
      </svg>
    </div>
  );
}

function Rings({ cpu, ram, disk }) {
  const data = [
    { lab: "PROCESSEUR", v: cpu, r: 84, c: "#7fb2d4" },
    { lab: "MÉMOIRE", v: ram, r: 66, c: "#c2925a" },
    { lab: "DISQUE", v: disk, r: 48, c: "#6fae9f" },
  ];
  const cx = 130, cy = 100;
  return (
    <svg viewBox="0 0 260 218" width="100%" height="218" data-testid="zeus-rings">
      {data.map((d) => {
        const C = 2 * Math.PI * d.r;
        return (
          <g key={d.lab}>
            <circle cx={cx} cy={cy} r={d.r} fill="none" stroke="rgba(255,255,255,.055)" strokeWidth="11" />
            <circle cx={cx} cy={cy} r={d.r} fill="none" stroke={d.c} strokeWidth="11"
                    strokeDasharray={`${C * Math.min(1, (d.v || 0) / 100)} ${C}`}
                    transform={`rotate(-90 ${cx} ${cy})`}
                    style={{ transition: "stroke-dasharray 1.1s cubic-bezier(.22,.8,.3,1)" }}>
              <title>{`${d.lab} — ${Math.round(d.v || 0)} %`}</title>
            </circle>
          </g>
        );
      })}
      <text x={cx} y={cy + 2} fill="#ffe6a3" fontSize="25" textAnchor="middle" fontWeight="600">
        {Math.round(((cpu || 0) + (ram || 0) + (disk || 0)) / 3)} %
      </text>
      <text x={cx} y={cy + 17} fill="#54707f" fontSize="9" textAnchor="middle" letterSpacing="1.4">CHARGE MOYENNE</text>
      {data.map((d, i) => (
        <g key={d.lab}>
          <rect x={8 + i * 86} y={192} width="9" height="9" fill={d.c} />
          <text x={21 + i * 86} y={200} fill="#7b97ac" fontSize="9">{`${d.lab} ${Math.round(d.v || 0)}%`}</text>
        </g>
      ))}
    </svg>
  );
}

function MemoryCurve({ points }) {
  if (points.length < 2) return <div className="zcx-empty">Pas encore assez de souvenirs pour tracer une courbe.</div>;
  const W = 340, H = 214, L = 34, B = 40, T = 16;
  const max = Math.max(...points.map((p) => p.total), 1);
  const x = (i) => L + i * (W - L - 12) / (points.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const gained = points[points.length - 1].total - points[0].total;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} data-testid="zeus-memory">
      <defs>
        <linearGradient id="zcxMem" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8d8fc4" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#8d8fc4" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, max].map((g) => (
        <g key={g}>
          <line x1={L} x2={W - 12} y1={y(g)} y2={y(g)} stroke="rgba(255,255,255,.06)" />
          <text x={L - 7} y={y(g) + 3.5} fill="#54707f" fontSize="9.5" textAnchor="end">{g}</text>
        </g>
      ))}
      <path d={`M${x(0)},${y(points[0].total)} ${points.map((p, i) => `L${x(i)},${y(p.total)}`).join(" ")} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill="url(#zcxMem)" />
      <polyline points={points.map((p, i) => `${x(i)},${y(p.total)}`).join(" ")} fill="none" stroke="#8d8fc4" strokeWidth="1.9" />
      <circle cx={x(points.length - 1)} cy={y(points[points.length - 1].total)} r="3.4" fill="#ffe6a3" />
      <text x={L} y={H - 14} fill="#54707f" fontSize="9">{shortDate(points[0].date)}</text>
      <text x={W - 12} y={H - 14} fill="#54707f" fontSize="9" textAnchor="end">{shortDate(points[points.length - 1].date)}</text>
      <text x={W / 2} y={H - 14} fill="#6fae9f" fontSize="9" textAnchor="middle">{gained >= 0 ? `+${gained}` : gained} sur la période</text>
    </svg>
  );
}


export default function ZeusCortex({ onClose, onAsk, answer }) {
  const [q, setQ] = useState("");
  const [stats, setStats] = useState(null);
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(8);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, b] = await Promise.all([
          fetch(`${API}/api/cortex/stats`, { credentials: "include" }).then((r) => r.json()),
          fetch(`${API}/api/cortex/dashboard?days=30`, { credentials: "include" }).then((r) => r.json()),
        ]);
        if (!alive) return;
        setStats(s); setBoard(b); setError("");
      } catch (e) {
        if (alive) setError("Télémétrie indisponible — le noyau ne répond pas.");
      }
    };
    load();
    const id = setInterval(load, 8000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t > 1 ? t - 1 : 8)), 1000);
    return () => clearInterval(id);
  }, []);

  const intents = useMemo(() => (stats?.intents || []).filter((i) => i.count > 0).slice(0, 8), [stats]);
  const maxIntent = intents[0]?.count || 1;
  const totals = stats?.totaux || {};
  const peak = board?.peak || {};

  const ask = (e) => {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    onAsk(v);
    setQ("");
  };

  return (
    <div className="zeus-screen zcx" data-testid="zeus-cortex-panel">
      <header className="zeus-head zcx-head">
        <img className="zcx-avatar" src="/holo/zeus.jpg" alt="Zeus" draggable={false} />
        <div>
          <h1 className="zeus-title font-divine">ZEUS CORTEX</h1>
          <p className="zcx-sub">INTELLIGENCE CENTRALE · TÉLÉMÉTRIE VÉRIFIABLE</p>
        </div>
        <div className="zcx-spacer" />
        <div className="zcx-metrics">
          <div className="zcx-hm"><span>CHARGE COGNITIVE</span><b data-testid="zeus-cog">{Math.round(stats?.activite_cognitive ?? 0)} %</b></div>
          <div className="zcx-hm"><span>ACCÈS BASE</span><b data-testid="zeus-speed">{stats?.traitement_ms ?? 0} ms</b></div>
          <div className="zcx-hm"><span>DISPONIBILITÉ</span><b>{stats?.uptime_h ?? 0} h</b></div>
        </div>
        <div className="zcx-live"><span className="zcx-dot" />{tick} s</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="zeus-close-btn"><X size={18} /></button>
      </header>

      {error ? <div className="zcx-empty" style={{ margin: 16 }} data-testid="zeus-error">{error}</div> : null}

      <div className="zcx-kpis" data-testid="zeus-totals">
        <Kpi label="COMMANDES" value={totals.commandes} hint={`${nf(totals.aujourdhui)} aujourd'hui`} delay={60} />
        <Kpi label="SOUVENIRS" value={totals.souvenirs} delay={115} />
        <Kpi label="CONVERSATIONS" value={totals.conversations} delay={170} />
        <Kpi label="CONSULTATIONS" value={totals.consultations} delay={225} />
        <Kpi label="PIC HORAIRE" value={peak.hour ?? 0} suffix=" h" hint={`${nf(peak.count)} commandes`} delay={280} />
        <Kpi label="CHARGE MÉMOIRE" value={stats?.charge_memoire} suffix=" %" delay={335} />
      </div>

      <div className="zcx-row zcx-rA">
        <div className="zcx-cell" style={{ animationDelay: "200ms" }}>
          <h2>ACTIVITÉ — 30 JOURS</h2>
          <p className="zcx-h2sub">Commandes exécutées · moyenne mobile 7 jours en surimpression</p>
          <Timeline points={board?.timeline || []} range={board?.range} />
        </div>
        <div className="zcx-cell alt" style={{ animationDelay: "280ms" }}>
          <h2>PROFIL COGNITIF</h2>
          <p className="zcx-h2sub">Part des intentions par faculté</p>
          <Radar subs={stats?.sous_systemes} />
        </div>
      </div>

      <div className="zcx-row zcx-rB">
        <div className="zcx-cell" style={{ animationDelay: "360ms" }}>
          <h2>DENSITÉ HORAIRE</h2>
          <p className="zcx-h2sub">Chaque cellule = commandes traitées sur une heure · survolez pour le détail</p>
          <Heatmap grid={board?.heatmap || []} />
        </div>
      </div>

      <div className="zcx-row zcx-rC">
        <div className="zcx-cell" style={{ animationDelay: "440ms" }}>
          <h2>INTENTIONS</h2>
          <p className="zcx-h2sub">Volume mesuré par type de commande</p>
          {intents.length ? intents.map((it, i) => (
            <div className="zcx-bar" key={it.name}>
              <em title={it.name}>{it.name}</em>
              <div className="zcx-track">
                <div className="zcx-fill" style={{ width: `${it.count / maxIntent * 100}%`, background: PALETTE[i % PALETTE.length], transitionDelay: `${i * 80}ms` }} />
              </div>
              <b>{nf(it.count)}</b>
            </div>
          )) : <div className="zcx-empty">Aucune intention enregistrée.</div>}
        </div>

        <div className="zcx-cell alt" style={{ animationDelay: "520ms" }}>
          <h2>RESSOURCES</h2>
          <p className="zcx-h2sub">Relevé psutil · instantané</p>
          <Rings cpu={stats?.cpu ?? 0} ram={stats?.ram ?? 0} disk={stats?.disque ?? 0} />
        </div>

        <div className="zcx-cell" style={{ animationDelay: "600ms" }}>
          <h2>CROISSANCE DE LA MÉMOIRE</h2>
          <p className="zcx-h2sub">Souvenirs cumulés sur 30 jours</p>
          <MemoryCurve points={board?.memory || []} />
        </div>
      </div>

      <div className="zcx-row zcx-rD">
        <div className="zcx-cell" style={{ animationDelay: "680ms" }}>
          <h2>JOURNAL DES ÉVÉNEMENTS</h2>
          <p className="zcx-h2sub">12 dernières commandes enregistrées</p>
          <div className="zcx-log" data-testid="zeus-journal">
            {(board?.journal || []).map((row, i) => (
              <div className="zcx-logline" key={`${row.at}-${i}`} style={{ animationDelay: `${700 + i * 70}ms` }}>
                <time>{hhmm(row.at)}</time>
                <span className="zcx-tag" style={{ background: PALETTE[i % PALETTE.length] }} />
                <p><em>{row.intent}</em> — {row.text}</p>
              </div>
            ))}
            {!board?.journal?.length ? <div className="zcx-empty">Journal vide.</div> : null}
          </div>
        </div>

        <div className="zcx-cell alt" style={{ animationDelay: "760ms" }}>
          <h2>SERVICES</h2>
          <p className="zcx-h2sub">Taux de succès relevé dans le journal de service</p>
          <div data-testid="zeus-services">
            {(board?.services || []).map((s) => (
              <div className="zcx-prov" key={s.service}>
                <span className="st" style={{ background: s.ok_rate >= 95 ? "#6fae9f" : s.ok_rate >= 60 ? "#c2925a" : "#b0728a" }} />
                <span className="nm">{s.service}</span>
                <span className="val">{nf(s.calls)} appels</span>
                <span className="val" style={{ width: 56, textAlign: "right" }}>{s.ok_rate} %</span>
              </div>
            ))}
            {!board?.services?.length ? <div className="zcx-empty">Aucun service journalisé.</div> : null}
          </div>

          <h2 style={{ marginTop: 18 }}>ENCHAÎNEMENTS</h2>
          <p className="zcx-h2sub">Transitions les plus fréquentes entre intentions</p>
          {(board?.flows || []).map((f) => (
            <div className="zcx-prov" key={`${f.from}->${f.to}`}>
              <span className="nm">{f.from} → {f.to}</span>
              <span className="val">{f.count}</span>
            </div>
          ))}
          {!board?.flows?.length ? <div className="zcx-empty">Pas encore d'enchaînement observé.</div> : null}
        </div>
      </div>

      <div className="zcx-foot">
        <div>Dernière mesure <b>{board?.generated_at ? hhmm(board.generated_at) : "—"}</b></div>
        <div>Sources <b>events · facts · service_log · psutil</b></div>
        <div>Fenêtre <b>{board?.days ?? 30} jours</b></div>
        <div>Échantillons <b>{nf(totals.commandes)}</b></div>
      </div>

      {/* Réponse + saisie */}
      <div className="zeus-bottom">
        {answer && <div className="zeus-answer" data-testid="zeus-answer">{answer}</div>}
        <form className="cmd-bar zeus-cmd" onSubmit={ask} data-testid="zeus-ask-form">
          <span className="cmd-prompt font-divine">ΣIRIUS&gt;</span>
          <input
            className="cmd-input"
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Posez votre question directement à Sirius..."
            data-testid="zeus-ask-input"
          />
          <button type="submit" className="cmd-send" data-testid="zeus-ask-send"><Send size={15} /></button>
        </form>
      </div>
    </div>
  );
}
