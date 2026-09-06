// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  X, ShieldAlert, RefreshCw, Wrench, History, Loader2, CheckCircle2,
  AlertTriangle, Radar, ScrollText,
} from "lucide-react";
import "./Argus.css";
import MythosBackdrop from "@/MythosBackdrop";
import useDraggableCards from "@/useDraggableCards";
import { progress } from "@/SiriusProgress";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const SEV_LABEL = { auto: "AUTO", severe: "SÉVÈRE", critical: "CRITIQUE" };

async function postFix(err, confirmed) {
  const r = await fetch(`${API}/argus/fix`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fixId: err.fixId,
      confirmed,
    }),
  });
  return r.json();
}

export function ArgusWatcher({ onCriticalAlert }) {
  const lastSent = useRef(0);
  const seen = useRef(new Set());

  useEffect(() => {
    const report = (message, stack) => {
      const key = (message || "").slice(0, 80);
      if (!message || seen.current.has(key) || Date.now() - lastSent.current < 10000) return;
      seen.current.add(key);
      lastSent.current = Date.now();
      fetch(`${API}/argus/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "hud", message: String(message).slice(0, 300), stack: String(stack || "").slice(0, 200) }),
      }).then((r) => r.json()).then((d) => {
        if (d && (d.severity === "critical" || d.severity === "severe")) onCriticalAlert && onCriticalAlert(d);
      }).catch(() => {});
    };
    const onErr = (e) => report(e.message, e.error && e.error.stack);
    const onRej = (e) => report(e.reason && (e.reason.message || String(e.reason)), e.reason && e.reason.stack);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);

    const iv = setInterval(async () => {
      try {
        const r = await fetch(`${API}/argus/scan`, { method: "POST" });
        const d = await r.json();
        const crit = (d.errors || []).filter((e) => e.severity === "critical" || e.severity === "severe");
        if (crit.length) onCriticalAlert && onCriticalAlert(crit[0]);
      } catch (_) {}
    }, 120000);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
      clearInterval(iv);
    };
  }, [onCriticalAlert]);
  return null;
}

function ErrorRow({ err, onClientAction, onDone, onRepaired }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const repair = async () => {
    if (err.requiresConfirmation && !confirming) { setConfirming(true); return; }
    setBusy(true);
    const pid = progress.start(`ARGUS — RÉPARATION : ${(err.errorType || "").toUpperCase()}`);
    progress.log(pid, "Application du correctif proposé", 45);
    try {
      const d = await postFix(err, true);
      setResult(d.message || (d.ok ? "Réparé." : "Échec."));
      if (d.ok) progress.done(pid, d.message || "Réparation effectuée");
      else progress.error(pid, d.message || "Échec de la réparation");
      if (d.clientAction && onClientAction) onClientAction(d.clientAction);
      if (d.ok) setTimeout(() => onDone && onDone(err.id), 2200);
    } catch (_) {
      progress.error(pid, "Backend injoignable");
      setResult("Backend injoignable.");
    }
    setBusy(false);
    setConfirming(false);
  };

  if (err.errorType === "none") {
    return (
      <div className="argus-none" data-testid="argus-none">
        <CheckCircle2 size={15} /> {err.message}
      </div>
    );
  }
  return (
    <div className={`argus-row sev-${err.severity}`} data-testid="argus-error-row">
      <div className="argus-row-head">
        <span className={`argus-badge sev-${err.severity}`}>
          {err.severity !== "auto" && <AlertTriangle size={9} />} {SEV_LABEL[err.severity] || err.severity}
        </span>
        <span className="argus-type">{(err.errorType || "").toUpperCase()}</span>
        {err.repaired && <span className="argus-badge repaired">RÉPARÉ AUTO</span>}
      </div>
      <p className="argus-msg">{err.message}</p>
      <p className="argus-fix"><Wrench size={10} /> {err.proposedFix}</p>
      {result && <p className="argus-result" data-testid="argus-fix-result">{result}</p>}
      {!err.repaired && !result && (
        <div className="argus-actions">
          <button className={`argus-btn ${confirming ? "confirm" : ""}`} onClick={repair} disabled={busy} data-testid="argus-repair-btn">
            {busy ? <Loader2 size={10} className="argus-spin" /> : <Wrench size={10} />}
            {confirming ? "CONFIRMER LA RÉPARATION" : "RÉPARER"}
          </button>
          {confirming && (
            <button className="argus-btn ghost" onClick={() => setConfirming(false)} data-testid="argus-cancel-btn">ANNULER</button>
          )}
        </div>
      )}
    </div>
  );
}

export default function ArgusPanel({ onClose, onClientAction, onRepaired }) {
  const [char, setChar] = useState(null);
  useEffect(() => {
    fetch((process.env.REACT_APP_BACKEND_URL || "") + "/api/mythos/characters")
      .then(r => r.json())
      .then(d => {
        const p = d.characters.find(c => c.module === "ARGUS#");
        setChar(p);
      });
  }, []);
  const [tab, setTab] = useState("scan");
  const dragRef = useDraggableCards([tab]);
  const [errors, setErrors] = useState([]);
  const [hist, setHist] = useState([]);
  const [scanning, setScanning] = useState(false);

  const runScan = useCallback(async () => {
    setScanning(true);
    const pid = progress.start("ARGUS — SCAN DES SYSTÈMES");
    progress.log(pid, "Analyse des sous-systèmes SIRIUS en cours", 40);
    try {
      const r = await fetch(`${API}/argus/scan`, { method: "POST" });
      const d = await r.json();
      setErrors(d.errors || []);
      setHist(d.history || []);
      const nb = (d.errors || []).filter((e) => e.errorType !== "none").length;
      progress.done(pid, nb ? `Scan terminé — ${nb} anomalie${nb > 1 ? "s" : ""} détectée${nb > 1 ? "s" : ""}` : "Scan terminé — aucun problème détecté");
    } catch (_) {
      progress.error(pid, "Backend SIRIUS injoignable");
      setErrors([{ errorType: "reseau", message: "Backend SIRIUS injoignable.", severity: "critical", proposedFix: "Vérifiez que le serveur est démarré (port 8001).", requiresConfirmation: true, actionToken: null, fixId: "retest_backend", id: "x" }]);
    }
    setScanning(false);
  }, []);

  useEffect(() => { runScan(); }, [runScan]);

  return (
    <div className="prime-screen" data-testid="argus-panel" ref={dragRef}>
      <MythosBackdrop module="ARGUS#" state={scanning ? "busy" : (errors && errors.length) ? "alert" : "idle"} />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><Radar size={20} /> ARGUS — SURVEILLANCE & RÉPARATION</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="argus-close-btn"><X size={18} /></button>
      </header>
      {char && (
        <img
          src={char.image}
          alt={char.character}
          className="mythos-avatar"
        />
      )}
      <div className="prime-sub">DÉTECTION CONTINUE · AUTO / SÉVÈRE / CRITIQUE · RÉPARATIONS SUR LISTE BLANCHE</div>

      <div className="argus-body">
        <div className="haccp-tabs">
          <button className={`haccp-tab ${tab === "scan" ? "active" : ""}`} onClick={() => setTab("scan")} data-testid="argus-tab-scan">
            <ShieldAlert size={13} /> ERREURS DÉTECTÉES
          </button>
          <button className={`haccp-tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")} data-testid="argus-tab-history">
            <History size={13} /> HISTORIQUE RÉPARATIONS
          </button>
          <button className="haccp-tab argus-rescan" onClick={runScan} disabled={scanning} data-testid="argus-rescan-btn">
            {scanning ? <Loader2 size={13} className="argus-spin" /> : <RefreshCw size={13} />} SCANNER MAINTENANT
          </button>
        </div>

        {tab === "scan" && (
          <section className="prime-card argus-wide" data-testid="argus-errors">
            {scanning && !errors.length && <div className="haccp-loading"><Loader2 size={20} className="argus-spin" /><span>Analyse des systèmes...</span></div>}
            {errors.map((e) => (
              <ErrorRow key={e.id || e.errorType} err={e} onClientAction={onClientAction} onRepaired={onRepaired}
                onDone={(id) => setErrors((l) => l.filter((x) => x.id !== id))} />
            ))}
          </section>
        )}

        {tab === "history" && (
          <section className="prime-card argus-wide" data-testid="argus-history">
            <div className="zc-section-title"><ScrollText size={12} style={{ marginRight: 6 }} />JOURNAL DES RÉPARATIONS ARGUS</div>
            {hist.length === 0 && <div className="memory-empty">Aucune réparation effectuée.</div>}
            {hist.map((h) => (
              <div className="argus-hist-row" key={h.id}>
                <span className={`argus-badge sev-${h.severity}`}>{SEV_LABEL[h.severity] || h.severity}</span>
                <span className="argus-hist-label">{h.label}</span>
                <span className="argus-hist-detail">{h.detail}</span>
                <span className="argus-hist-date">{(h.created_at || "").slice(0, 16).replace("T", " ")}</span>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
