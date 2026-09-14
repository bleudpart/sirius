// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  X, CheckCircle2, XCircle, Loader2, RotateCcw, Monitor, Mic, Server,
  BrainCircuit, LayoutDashboard, Boxes, Rocket, ChevronRight, Code2,
} from "lucide-react";
import "./InstallWizard.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const STEPS = [
  { id: "environment", label: "ENVIRONNEMENT", icon: Monitor },
  { id: "micro", label: "MICRO & VOIX", icon: Mic },
  { id: "backend", label: "BACKEND ΣIRIUS", icon: Server },
  { id: "ia", label: "MOTEUR IA", icon: BrainCircuit },
  { id: "hud", label: "HUD", icon: LayoutDashboard },
  { id: "modules", label: "MODULES", icon: Boxes },
  { id: "completed", label: "ACTIVATION", icon: Rocket },
];

function detectEnv() {
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) return "tauri";
  if (window.electronAPI || (navigator.userAgent || "").includes("Electron")) return "electron";
  return "web";
}

async function checkMicro() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return "unsupported";
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return "unsupported";
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const p = await navigator.permissions.query({ name: "microphone" });
      if (p.state === "granted") return "granted";
      if (p.state === "denied") return "denied";
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return "granted";
  } catch (e) {
    return "denied";
  }
}

function checkHud() {
  return {
    "barre de commande": !!document.querySelector('[data-testid="sirius-cmd-input"]'),
    "commande vocale": !!document.querySelector('[data-testid="sirius-ptt-btn"]'),
    "noyau HUD": !!document.querySelector(".hud-root, .hud, #root > div"),
  };
}

export default function InstallWizard({ onClose, onSpeak, keys }) {
  const [results, setResults] = useState({});
  const [current, setCurrent] = useState("environment");
  const [running, setRunning] = useState(false);
  const [showJson, setShowJson] = useState(true);
  const doneRef = useRef(false);
  const startedRef = useRef(false);

  const buildContext = useCallback(async (step) => {
    if (step === "environment") return { env: detectEnv() };
    if (step === "micro") return { micro: await checkMicro() };
    if (step === "hud") return { hud: checkHud() };
    return { keys: keys || {} };
  }, [keys]);

  const runStep = useCallback(async (step) => {
    setRunning(true);
    setCurrent(step);
    try {
      const context = await buildContext(step);
      const r = await fetch(`${API}/install/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step, context }),
      });
      const d = await r.json();
      setResults((res) => ({ ...res, [step]: d }));
      setRunning(false);
      if (d.status === "ok" && d.next) {
        setTimeout(() => runStep(d.next), 750);
      } else if (d.step === "completed" && d.status === "ok" && !doneRef.current) {
        doneRef.current = true;
        onSpeak && onSpeak("Installation terminée. Tous les systèmes sont vérifiés. Sirius est activé, monsieur.");
      }
    } catch (e) {
      setResults((res) => ({
        ...res,
        [step]: { step, message: "Backend ΣIRIUS injoignable. Solution : vérifiez que le serveur est démarré (port 8001).", status: "error", next: step },
      }));
      setRunning(false);
    }
  }, [buildContext, onSpeak]);

  const restart = useCallback(async () => {
    doneRef.current = false;
    startedRef.current = true;
    setResults({});
    runStep("environment");
  }, [runStep]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runStep("environment");
  }, [runStep]);

  const activate = () => {
    localStorage.setItem("sirius_installed", "1");
    onClose();
  };

  const cur = results[current];
  const completedOk = results.completed && results.completed.status === "ok";
  const okCount = STEPS.filter((s) => results[s.id] && results[s.id].status === "ok").length;

  return (
    <div className="iw-overlay" data-testid="install-wizard">
      <div className="iw-panel">
        <header className="iw-head">
          <span className="iw-title">Σ INSTALLATION DE ΣIRIUS</span>
          <button className="iw-icon-btn" onClick={onClose} data-testid="iw-close-btn"><X size={16} /></button>
        </header>

        <div className="iw-progress">
          <div className="iw-progress-bar" style={{ width: `${(okCount / STEPS.length) * 100}%` }} />
        </div>

        <div className="iw-steps">
          {STEPS.map((s) => {
            const res = results[s.id];
            const Icon = s.icon;
            const st = res ? res.status : (s.id === current && running ? "running" : "idle");
            return (
              <div className={`iw-step ${st} ${s.id === current ? "current" : ""}`} key={s.id} data-testid={`iw-step-${s.id}`}>
                <span className="iw-step-icon"><Icon size={13} /></span>
                <span className="iw-step-label">{s.label}</span>
                <span className="iw-step-status">
                  {st === "ok" && <CheckCircle2 size={14} className="ok" />}
                  {st === "error" && <XCircle size={14} className="err" />}
                  {(st === "running" || st === "pending") && <Loader2 size={14} className="iw-spin" />}
                </span>
              </div>
            );
          })}
        </div>

        {cur && (
          <div className={`iw-message ${cur.status}`} data-testid="iw-message">
            <p>{cur.message}</p>
            {cur.status === "error" && (
              <div className="iw-actions">
                <button className="iw-btn" onClick={() => runStep(cur.step)} data-testid="iw-retry-btn">
                  <RotateCcw size={11} /> RÉESSAYER
                </button>
                {cur.next && cur.step !== "backend" && (
                  <button className="iw-btn ghost" onClick={() => {
                    const idx = STEPS.findIndex((s) => s.id === cur.step);
                    if (idx >= 0 && idx < STEPS.length - 1) runStep(STEPS[idx + 1].id);
                  }} data-testid="iw-skip-btn">
                    <ChevronRight size={11} /> CONTINUER QUAND MÊME
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {cur && showJson && (
          <pre className="iw-json" data-testid="iw-json">{JSON.stringify(cur, null, 2)}</pre>
        )}

        <footer className="iw-foot">
          <button className="iw-btn ghost" onClick={() => setShowJson(!showJson)} data-testid="iw-json-toggle">
            <Code2 size={11} /> JSON {showJson ? "MASQUER" : "AFFICHER"}
          </button>
          <button className="iw-btn" onClick={restart} data-testid="iw-restart-btn">
            <RotateCcw size={11} /> RECOMMENCER
          </button>
          {completedOk && (
            <button className="iw-btn activate" onClick={activate} data-testid="iw-activate-btn">
              <Rocket size={12} /> ACTIVER ΣIRIUS
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
