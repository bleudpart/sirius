// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import { Activity, CheckCircle2, AlertTriangle, Loader2, X, History, Trash2 } from "lucide-react";
import "./SiriusProgress.css";

// Journal des tâches passées (localStorage, 200 entrées max)
const JOURNAL_KEY = "sirius_task_journal";
const readJournal = () => { try { return JSON.parse(localStorage.getItem(JOURNAL_KEY)) || []; } catch (e) { return []; } };
const writeJournal = (l) => { try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(l.slice(0, 200))); } catch (e) { /* stockage plein ignoré */ } };
export const fmtDuree = (ms) =>
  ms < 1000 ? `${ms} ms`
  : ms < 60000 ? `${(ms / 1000).toFixed(1).replace(".", ",")} s`
  : `${Math.floor(ms / 60000)} min ${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")} s`;

// Fenêtre de progression globale SIRIUS : toute tâche longue s'y affiche en direct.
// API globale : progress.start(nom) -> id, progress.log(id, msg, pct?), progress.done(id, msg?), progress.error(id, msg?)
let seq = 0;
const emit = (detail) => window.dispatchEvent(new CustomEvent("sirius-progress", { detail }));
export const progress = {
  start(task, opts) { const id = `sp-${Date.now()}-${seq++}`; emit({ action: "start", id, task, silent: !!(opts && opts.silent) }); return id; },
  log(id, message, pct) { if (id) emit({ action: "log", id, message, pct }); },
  done(id, message) { if (id) emit({ action: "done", id, message }); },
  error(id, message) { if (id) emit({ action: "error", id, message }); },
};

const now = () => new Date().toLocaleTimeString("fr-FR", { hour12: false });
const POS_KEY = "sirius_progress_pos";

// Témoin de mode : une couleur par état de Sirius
const MODES = {
  idle: { label: "Veille", color: "#22d3ee" },
  listening: { label: "Écoute", color: "#38bdf8" },
  thinking: { label: "Réflexion", color: "#fbbf24" },
  speaking: { label: "Réponse", color: "#5eead4" },
};

export default function SiriusProgress({ mode = "idle" }) {
  const [tasks, setTasks] = useState([]);
  const panelRef = useRef(null);
  const logRef = useRef(null);
  const timersRef = useRef({});
  const startedRef = useRef({});
  const [showJournal, setShowJournal] = useState(false);
  const [journal, setJournal] = useState([]);

  const openJournal = () => { setJournal(readJournal()); setShowJournal(true); };

  useEffect(() => {
    const onOpen = () => { setJournal(readJournal()); setShowJournal(true); };
    window.addEventListener("sirius-journal-open", onOpen);
    return () => window.removeEventListener("sirius-journal-open", onOpen);
  }, []);

  useEffect(() => {
    const onEvt = (e) => {
      const { action, id, task, message, pct } = e.detail || {};
      if (!id) return;
      if (action === "start") startedRef.current[id] = { task: task || "Tâche SIRIUS", t0: Date.now() };
      if (action === "done" || action === "error") {
        const st = startedRef.current[id];
        if (st) {
          const entry = {
            ts: Date.now(),
            task: st.task,
            duree: Date.now() - st.t0,
            statut: action === "done" ? "succès" : "erreur",
            resultat: message || (action === "done" ? "Terminé" : "Échec"),
          };
          writeJournal([entry, ...readJournal()]);
          setJournal((j) => (j.length || showJournal ? [entry, ...j].slice(0, 200) : j));
          delete startedRef.current[id];
        }
      }
      setTasks((ts) => {
        if (action === "start") {
          if (ts.some((t) => t.id === id)) return ts;
          return [...ts, { id, task: task || "Tâche SIRIUS", pct: 4, status: "running", logs: [{ t: now(), msg: "Tâche démarrée" }] }];
        }
        return ts.map((t) => {
          if (t.id !== id) return t;
          if (action === "log") {
            const p = typeof pct === "number" ? Math.min(99, pct) : Math.min(90, t.pct + Math.max(4, (92 - t.pct) * 0.22));
            return { ...t, pct: Math.max(t.pct, p), logs: [...t.logs, { t: now(), msg: message }].slice(-60) };
          }
          if (action === "done") {
            return { ...t, pct: 100, status: "done", logs: [...t.logs, { t: now(), msg: message || "Terminé" }].slice(-60) };
          }
          if (action === "error") {
            return { ...t, status: "error", logs: [...t.logs, { t: now(), msg: message || "Échec" }].slice(-60) };
          }
          return t;
        });
      });
      if (action === "done" || action === "error") {
        clearTimeout(timersRef.current[id]);
        timersRef.current[id] = setTimeout(() => {
          setTasks((ts) => ts.filter((t) => t.id !== id));
        }, 7000);
      }
    };
    window.addEventListener("sirius-progress", onEvt);
    const timers = timersRef.current;
    return () => {
      window.removeEventListener("sirius-progress", onEvt);
      Object.values(timers).forEach(clearTimeout);
    };
  }, [showJournal]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tasks]);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY));
      if (saved && typeof saved.x === "number") {
        el.style.left = Math.min(Math.max(0, saved.x), window.innerWidth - 160) + "px";
        el.style.top = Math.min(Math.max(0, saved.y), window.innerHeight - 80) + "px";
        el.style.right = "auto";
        el.style.bottom = "auto";
      }
    } catch (e) { /* position invalide ignorée */ }
  }, [tasks.length]);


  const onBarDown = (e) => {
    if (e.target.closest("button")) return;
    const el = panelRef.current;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      const x = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 160);
      const y = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 80);
      el.style.left = x + "px"; el.style.top = y + "px";
      el.style.right = "auto"; el.style.bottom = "auto";
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const rr = el.getBoundingClientRect();
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: rr.left, y: rr.top })); } catch (e) { /* ignoré */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };

  const running = tasks.filter((t) => t.status === "running").length;
  const m = MODES[mode] || MODES.idle;

  return (
    <>
      <div ref={panelRef} className={`sirius-progress ${tasks.length ? "" : "sp-compact"}`} data-testid="sirius-progress-panel">
      <div className="sp-bar" onPointerDown={onBarDown} title="Glisser pour déplacer" data-testid="sirius-progress-bar-header">
        <Activity size={13} className={running ? "sp-pulse" : ""} />
        <span className="sp-title">SIRIUS — ACTIVITÉ EN COURS</span>
        <span className="sp-mode" data-testid="sirius-mode-indicator" style={{ "--mode-c": m.color }}>
          <i className="sp-mode-bar" />
          Mode : {m.label}
        </span>
        {tasks.length > 0 && <span className="sp-count">{running ? `${running} TÂCHE${running > 1 ? "S" : ""}` : "TERMINÉ"}</span>}
        <button className="sp-close" onClick={openJournal} title="Journal des tâches" data-testid="sirius-progress-journal-btn"><History size={13} /></button>
        {tasks.length > 0 && <button className="sp-close" onClick={() => setTasks([])} data-testid="sirius-progress-close-btn"><X size={13} /></button>}
      </div>
      {tasks.map((t) => (
        <div key={t.id} className={`sp-task sp-${t.status}`} data-testid="sirius-progress-task">
          <div className="sp-task-head">
            {t.status === "running" && <Loader2 size={12} className="sp-spin" />}
            {t.status === "done" && <CheckCircle2 size={12} />}
            {t.status === "error" && <AlertTriangle size={12} />}
            <span className="sp-task-name">{t.task}</span>
            <span className="sp-pct" data-testid="sirius-progress-pct">{t.status === "error" ? "ERREUR" : `${Math.round(t.pct)}%`}</span>
          </div>
          <div className="sp-track">
            <div className={`sp-fill sp-fill-${t.status}`} style={{ width: `${t.pct}%` }} />
          </div>
        </div>
      ))}
      {tasks.length > 0 && (
        <div className="sp-log" ref={logRef} data-testid="sirius-progress-log">
          {tasks.flatMap((t) => t.logs.map((l, i) => (
            <div key={`${t.id}-${i}`} className="sp-line">
              <span className="sp-time">{l.t}</span>
              <span className="sp-msg">{l.msg}</span>
            </div>
          )))}
        </div>
      )}
      </div>

      {showJournal && (
        <div className="sp-journal" data-testid="sirius-journal-panel">
          <div className="sp-bar">
            <History size={13} />
            <span className="sp-title">JOURNAL DES TÂCHES SIRIUS</span>
            <span className="sp-count">{journal.length} ENTRÉE{journal.length > 1 ? "S" : ""}</span>
            <button className="sp-close" title="Vider le journal" onClick={() => { writeJournal([]); setJournal([]); }} data-testid="sirius-journal-clear-btn"><Trash2 size={13} /></button>
            <button className="sp-close" onClick={() => setShowJournal(false)} data-testid="sirius-journal-close-btn"><X size={13} /></button>
          </div>
          <div className="sp-journal-list" data-testid="sirius-journal-list">
            {journal.length === 0 && <div className="sp-journal-empty">Aucune tâche enregistrée pour le moment.</div>}
            {journal.map((e, i) => (
              <div key={`${e.ts}-${i}`} className={`sp-jrow sp-j-${e.statut === "succès" ? "done" : "error"}`} data-testid="sirius-journal-row">
                <div className="sp-jrow-head">
                  {e.statut === "succès" ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                  <span className="sp-jtask">{e.task}</span>
                  <span className="sp-jduree">{fmtDuree(e.duree)}</span>
                </div>
                <div className="sp-jrow-sub">
                  <span className="sp-jdate">{new Date(e.ts).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  <span className="sp-jres">{e.resultat}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
