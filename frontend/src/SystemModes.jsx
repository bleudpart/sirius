// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldOff, BatteryLow, Camera, X, Loader2, ScanEye, Stethoscope, Power } from "lucide-react";
import "./SystemModes.css";
import { progress } from "@/SiriusProgress";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

export function ModeBanner({ mode, cause, onExit, onDiagnostic }) {
  if (mode === "safe") {
    return (
      <div className="mode-banner safe" data-testid="safe-mode-banner">
        <ShieldOff size={13} />
        <span className="mode-banner-title">MODE RESTREINT</span>
        <span className="mode-banner-cause">{cause ? `— ${cause.slice(0, 90)}` : "— capacité réduite, priorité à la stabilité"}</span>
        <button className="mode-banner-btn" onClick={onDiagnostic} data-testid="safe-diagnostic-btn">
          <Stethoscope size={10} /> DIAGNOSTIC
        </button>
        <button className="mode-banner-btn" onClick={onExit} data-testid="safe-exit-btn">
          <Power size={10} /> MODE NORMAL
        </button>
      </div>
    );
  }
  if (mode === "frugal") {
    return (
      <div className="mode-banner frugal" data-testid="frugal-mode-banner">
        <BatteryLow size={12} />
        <span className="mode-banner-title">MODE FRUGAL</span>
        <span className="mode-banner-cause">— animations réduites, réponses courtes</span>
        <button className="mode-banner-btn" onClick={onExit} data-testid="frugal-exit-btn">
          <Power size={10} /> DÉSACTIVER
        </button>
      </div>
    );
  }
  return null;
}

export function FrugalWatcher({ active, manual, onAuto }) {
  useEffect(() => {
    let battery = null;
    let cancelled = false;

    const evaluate = () => {
      if (cancelled || manual !== null) return;
      const conn = navigator.connection || {};
      const slowNet = !navigator.onLine || ["slow-2g", "2g"].includes(conn.effectiveType);
      const lowBat = battery ? (battery.level < 0.2 && !battery.charging) : false;
      const should = slowNet || lowBat;
      if (should !== active) onAuto(should, lowBat ? "batterie faible" : (slowNet ? "réseau faible" : ""));
    };

    if (navigator.getBattery) {
      navigator.getBattery().then((b) => {
        battery = b;
        b.addEventListener("levelchange", evaluate);
        b.addEventListener("chargingchange", evaluate);
        evaluate();
      }).catch(() => {});
    }
    window.addEventListener("online", evaluate);
    window.addEventListener("offline", evaluate);
    const conn = navigator.connection;
    if (conn && conn.addEventListener) conn.addEventListener("change", evaluate);
    const iv = setInterval(evaluate, 60000);
    return () => {
      cancelled = true;
      window.removeEventListener("online", evaluate);
      window.removeEventListener("offline", evaluate);
      if (conn && conn.removeEventListener) conn.removeEventListener("change", evaluate);
      clearInterval(iv);
    };
  }, [active, manual, onAuto]);
  return null;
}

export function VisionModule({ onClose, onSpeak, keys, autoAnalyze }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const autoRanRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [desc, setDesc] = useState("");
  const [ocr, setOcr] = useState("");
  const [snap, setSnap] = useState("");
  const [question, setQuestion] = useState("");

  useEffect(() => {
    let mounted = true;
    navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
      .then((stream) => {
        if (!mounted) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setReady(true);
      })
      .catch(() => setError("Caméra non autorisée. Cliquez sur le cadenas de la barre d'adresse pour autoriser la caméra."));
    return () => {
      mounted = false;
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const analyze = useCallback(async () => {
    if (!videoRef.current || busy) return;
    setBusy(true); setDesc(""); setOcr("");
    const pid = progress.start("VISION — ANALYSE CAMÉRA");
    progress.log(pid, "Capture de l'image caméra", 20);
    try {
      const v = videoRef.current;
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth || 640;
      canvas.height = v.videoHeight || 480;
      canvas.getContext("2d").drawImage(v, 0, 0);
      const image = canvas.toDataURL("image/jpeg", 0.75);
      setSnap(image);
      progress.log(pid, "Analyse neuronale de l'image en cours", 55);
      const r = await fetch(`${API}/vision/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, question, keys: keys || {} }),
      });
      const d = await r.json();
      if (!r.ok) { progress.error(pid, d.detail || "Analyse impossible"); setDesc(d.detail || "Analyse impossible."); setBusy(false); return; }
      setDesc(d.description || d.responseText || "");
      setOcr(d.texte_extrait || "");
      progress.done(pid, "Analyse visuelle terminée");
      onSpeak && onSpeak(d.synthese || d.responseText);
    } catch (_) {
      progress.error(pid, "Backend injoignable");
      setDesc("Backend injoignable.");
    }
    setBusy(false);
  }, [busy, question, keys, onSpeak]);

  // Déclenchement vocal « Sirius, regarde ça » : capture automatique dès que la caméra est prête
  const analyzeRef = useRef(null);
  analyzeRef.current = analyze;
  useEffect(() => {
    if (ready && autoAnalyze && !autoRanRef.current) {
      autoRanRef.current = true;
      setTimeout(() => analyzeRef.current && analyzeRef.current(), 700);
    }
  }, [ready, autoAnalyze]);

  return (
    <div className="vision-card" data-testid="vision-module">
      <div className="vision-head">
        <span className="vision-title"><ScanEye size={13} /> VISION SIRIUS</span>
        <button className="vision-icon-btn" onClick={onClose} data-testid="vision-close-btn"><X size={14} /></button>
      </div>
      {error ? (
        <p className="vision-error" data-testid="vision-error">{error}</p>
      ) : (
        <video ref={videoRef} autoPlay muted playsInline className="vision-video" data-testid="vision-video" />
      )}
      <input
        className="vision-question"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Question optionnelle (ex : lis ce document)"
        data-testid="vision-question-input"
      />
      <div className="vision-actions">
        <button className="vision-btn" onClick={analyze} disabled={!ready || busy} data-testid="vision-analyze-btn">
          {busy ? <Loader2 size={11} className="vision-spin" /> : <Camera size={11} />} ANALYSER
        </button>
        <span className="vision-privacy">Rien n&apos;est stocké sans votre demande.</span>
      </div>
      {desc && (
        <div className="vision-result" data-testid="vision-result" style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 8 }}>
          {snap && <img src={snap} alt="Capture" data-testid="vision-snapshot" style={{ width: 96, borderRadius: 6, border: "1px solid rgba(145,230,242,0.35)", flexShrink: 0 }} />}
          <div style={{ minWidth: 0 }}>
            <p className="vision-desc" data-testid="vision-description" style={{ margin: 0 }}>{desc}</p>
            {ocr && (
              <p className="vision-desc" data-testid="vision-ocr" style={{ marginTop: 6, opacity: 0.8, fontSize: 11, whiteSpace: "pre-wrap" }}>
                <b>TEXTE EXTRAIT :</b> {ocr}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
