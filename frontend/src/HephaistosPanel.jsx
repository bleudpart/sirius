// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  X, Hammer, Play, Loader2, CheckCircle2, XCircle, FileDown, Activity,
  Server, Plug, Gauge, History, Trash2,
} from "lucide-react";
import MythosBackdrop from "@/MythosBackdrop";
import useDraggableCards from "@/useDraggableCards";
import "./Hephaistos.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const GROUPS = [
  { key: "endpoints", label: "MODULES INTERNES", Icon: Activity },
  { key: "system", label: "SERVICES SYSTÈME", Icon: Server },
  { key: "integrations", label: "INTÉGRATIONS EXTERNES", Icon: Plug },
];

export default function HephaistosPanel({ onClose, onSpeak }) {
  const [char, setChar] = useState(null);
  useEffect(() => {
    fetch((process.env.REACT_APP_BACKEND_URL || "") + "/api/mythos/characters")
      .then(r => r.json())
      .then(d => {
        const p = d.characters.find(c => c.module === "HÉPHAÏSTOS#");
        setChar(p);
      });
  }, []);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("");
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState([]);
  const timerRef = useRef(null);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch(`${API}/hephaistos/history?limit=40`);
      const d = await r.json();
      if (r.ok && d.history) setHistory(d.history);
    } catch {}
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const purgeHistory = useCallback(async (keep) => {
    try {
      const r = await fetch(`${API}/hephaistos/history?keep=${keep}`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        loadHistory();
        onSpeak && onSpeak(keep > 0
          ? `Historique nettoyé : ${d.deleted} ancien diagnostic supprimé, les ${keep} plus récents sont conservés.`
          : `Historique purgé : ${d.deleted} diagnostics supprimés.`);
      }
    } catch {}
  }, [loadHistory, onSpeak]);

  const runDiagnostic = useCallback(async () => {
    setRunning(true); setError(""); setReport(null); setProgress(4);
    const phases = [
      "Initialisation de la forge…",
      "Analyse des modules internes…",
      "Vérification des services système…",
      "Sondage des intégrations externes…",
      "Compilation du rapport technique…",
    ];
    let step = 0;
    setPhase(phases[0]);
    timerRef.current = setInterval(() => {
      step = Math.min(step + 1, phases.length - 1);
      setPhase(phases[step]);
      setProgress((p) => Math.min(p + 16, 92));
    }, 1600);
    try {
      const r = await fetch(`${API}/hephaistos/diagnostic`);
      const d = await r.json().catch(() => ({}));
      clearInterval(timerRef.current);
      if (!r.ok) { setError(d.detail || "Diagnostic impossible."); setRunning(false); setProgress(0); return; }
      setProgress(100);
      setPhase("Diagnostic terminé.");
      setReport(d);
      if (onSpeak && d.speech) onSpeak(d.speech);
      loadHistory();
    } catch {
      clearInterval(timerRef.current);
      setError("Forge injoignable — le backend ne répond pas.");
      setProgress(0);
    }
    setRunning(false);
  }, [onSpeak, loadHistory]);

  const downloadReport = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "auto-maintenance-report.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const dragRef = useDraggableCards([report]);
  const s = report && report.summary;

  return (
    <div className="prime-screen" data-testid="hephaistos-panel" ref={dragRef}>
      <MythosBackdrop module="HÉPHAÏSTOS#" state={running ? "busy" : error ? "alert" : "idle"} />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><Hammer size={20} /> HÉPHAÏSTOS — AUTO-MAINTENANCE</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="hephaistos-close-btn"><X size={18} /></button>
      </header>
      {char && (
        <img
          src={char.image}
          alt={char.character}
          className="mythos-avatar"
        />
      )}
      <div className="prime-sub">DIAGNOSTIC RÉEL · MODULES · SERVICES · INTÉGRATIONS · RAPPORT TÉLÉCHARGEABLE</div>

      <div className="heph-body">
        <section className="prime-card heph-control">
          <button className="heph-run" onClick={runDiagnostic} disabled={running} data-testid="hephaistos-run-btn">
            {running ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
            {running ? "DIAGNOSTIC EN COURS…" : "LANCER LE DIAGNOSTIC COMPLET"}
          </button>

          {(running || report) && (
            <div className="heph-progress" data-testid="hephaistos-progress">
              <div className="heph-progress-track"><div className="heph-progress-fill" style={{ width: `${progress}%` }} /></div>
              <span className="heph-phase">{phase}</span>
            </div>
          )}

          {error && <div className="heph-error" data-testid="hephaistos-error"><XCircle size={13} /> {error}</div>}

          {s && (
            <div className={`heph-summary ${s.state.toLowerCase()}`} data-testid="hephaistos-summary">
              <div className="heph-gauge">
                <Gauge size={16} />
                <b data-testid="hephaistos-rate">{s.rate}%</b>
              </div>
              <div className="heph-summary-txt">
                <span className={`heph-state heph-state-${s.state.toLowerCase()}`}>{s.state}</span>
                <span>{s.passed}/{s.total} modules OK · {s.failed} en échec · {s.duration_ms} ms</span>
              </div>
              <button className="heph-dl" onClick={downloadReport} data-testid="hephaistos-download-btn">
                <FileDown size={13} /> RAPPORT JSON
              </button>
            </div>
          )}
        </section>

        {report && GROUPS.map(({ key, label, Icon }) => (
          <section className="prime-card heph-group" key={key} data-testid={`hephaistos-group-${key}`}>
            <div className="zc-section-title"><Icon size={12} style={{ marginRight: 6 }} />{label}</div>
            <div className="heph-list">
              {(report.groups[key] || []).map((it) => (
                <div className={`heph-row ${it.status === "OK" ? "ok" : "fail"}`} key={it.name} data-testid={`hephaistos-item-${it.name}`}>
                  {it.status === "OK" ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                  <span className="heph-row-name">{it.name}</span>
                  <span className="heph-row-meta">
                    {it.code != null && <em>{it.code}</em>}
                    {it.latency != null && <em>{it.latency} ms</em>}
                    {it.detail && <em>{it.detail}</em>}
                    {it.configured === false && <em className="heph-nc">non configuré</em>}
                  </span>
                  <span className={`heph-badge ${it.status === "OK" ? "ok" : "fail"}`}>{it.status}</span>
                </div>
              ))}
            </div>
          </section>
        ))}

        {history.length > 0 && (
          <section className="prime-card heph-group" data-testid="hephaistos-history">
            <div className="zc-section-title">
              <History size={12} style={{ marginRight: 6 }} />HISTORIQUE — ÉVOLUTION DE LA SANTÉ SYSTÈME
              <span className="heph-purge-group">
                <button className="heph-purge" onClick={() => purgeHistory(10)} title="Conserver uniquement les 10 diagnostics les plus récents" data-testid="hephaistos-purge-old-btn">
                  <Trash2 size={11} /> PURGER LES ANCIENS
                </button>
                <button className="heph-purge danger" onClick={() => purgeHistory(0)} title="Effacer tout l'historique" data-testid="hephaistos-purge-all-btn">
                  <Trash2 size={11} /> TOUT EFFACER
                </button>
              </span>
            </div>
            <div className="heph-chart" data-testid="hephaistos-chart">
              <svg viewBox="0 0 400 90" preserveAspectRatio="none">
                <line x1="0" y1="9" x2="400" y2="9" className="heph-grid" />
                <line x1="0" y1="45" x2="400" y2="45" className="heph-grid" />
                <line x1="0" y1="81" x2="400" y2="81" className="heph-grid" />
                <polyline
                  className="heph-line"
                  points={history.map((h, i) => {
                    const x = history.length === 1 ? 200 : (i / (history.length - 1)) * 392 + 4;
                    const y = 81 - (h.rate / 100) * 72;
                    return `${x},${y}`;
                  }).join(" ")}
                />
                {history.map((h, i) => {
                  const x = history.length === 1 ? 200 : (i / (history.length - 1)) * 392 + 4;
                  const y = 81 - (h.rate / 100) * 72;
                  return <circle key={i} cx={x} cy={y} r="3" className={`heph-dot ${h.rate === 100 ? "ok" : h.rate >= 70 ? "warn" : "fail"}`} />;
                })}
              </svg>
              <div className="heph-chart-scale"><span>100%</span><span>50%</span><span>0%</span></div>
            </div>
            <div className="heph-hist-list">
              {[...history].reverse().slice(0, 8).map((h, i) => (
                <div className="heph-hist-row" key={i} data-testid={`hephaistos-hist-row-${i}`}>
                  <span className={`heph-dot-inline ${h.rate === 100 ? "ok" : h.rate >= 70 ? "warn" : "fail"}`} />
                  <span className="heph-hist-date">{new Date(h.at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="heph-hist-src">{h.source === "auto" ? "AUTO" : "MANUEL"}</span>
                  <span className="heph-hist-rate">{h.rate}%</span>
                  <span className="heph-hist-detail">{h.passed}/{h.total} OK{h.failed_modules && h.failed_modules.length ? ` · ${h.failed_modules.slice(0, 3).join(", ")}` : ""}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
