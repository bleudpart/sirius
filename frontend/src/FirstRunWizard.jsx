// © 2026 Daniel Partel – ΣIRIUS Assistant. Logiciel protégé.
// Assistant de premier démarrage : cerveau → micro → prêt, sans aucune clé à saisir.
import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, CheckCircle2, Loader2, Mic, Rocket, XCircle } from "lucide-react";
import { API_BASE_URL } from "@/lib/api";

const RECORD_MS = 3000;

const readDetail = async (response, fallback) => {
  try {
    const data = await response.json();
    return (typeof data?.detail === "string" && data.detail) || fallback;
  } catch {
    return fallback;
  }
};

export async function detectBrain(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${API_BASE_URL}/cloud/status`);
    if (response.ok) {
      const status = await response.json();
      if (status.available) {
        if (status.local_brain) return { state: "ready", via: "local" };
        if (status.linked) return { state: "ready", via: "cloud", email: status.email };
        return { state: "link" };
      }
    }
  } catch {
    // Pas de relais : on vérifie simplement que le serveur répond.
  }
  try {
    const response = await fetchImpl(`${API_BASE_URL}/health`);
    return response.ok ? { state: "ready", via: "server" } : { state: "down" };
  } catch {
    return { state: "down" };
  }
}

export async function recordSample(ms = RECORD_MS, media = typeof navigator !== "undefined" ? navigator.mediaDevices : null) {
  if (!media?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("Ce navigateur ne permet pas d'enregistrer le micro.");
  }
  const stream = await media.getUserMedia({ audio: true });
  try {
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, ms));
    recorder.stop();
    await stopped;
    return new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

function Step({ index, current, label }) {
  const state = index < current ? "done" : index === current ? "active" : "";
  return <li className={`fw-step ${state}`}><span>{index + 1}</span>{label}</li>;
}

export default function FirstRunWizard({ userName = "", userEmail = "", keys = {}, onComplete, onExpert, record = recordSample }) {
  const [step, setStep] = useState(0);
  const [brain, setBrain] = useState({ state: "checking" });
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: userEmail, password: "", name: userName });
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [mic, setMic] = useState({ state: "idle" });
  const [name, setName] = useState(userName);
  const mounted = useRef(true);

  const checkBrain = useCallback(async () => {
    setBrain({ state: "checking" });
    const result = await detectBrain();
    if (mounted.current) setBrain(result);
  }, []);

  useEffect(() => {
    mounted.current = true;
    checkBrain();
    return () => { mounted.current = false; };
  }, [checkBrain]);

  const linkAccount = async (event) => {
    event.preventDefault();
    setLinkBusy(true);
    setLinkError("");
    try {
      const response = await fetch(`${API_BASE_URL}/cloud/${mode === "register" ? "register" : "link"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.email.trim(), password: form.password, name: form.name.trim() }),
      });
      if (!response.ok) {
        setLinkError(await readDetail(response, "Connexion à ΣIRIUS Cloud impossible."));
        return;
      }
      const status = await response.json();
      if (mounted.current) setBrain({ state: "ready", via: "cloud", email: status.email });
    } catch {
      setLinkError("ΣIRIUS Cloud est injoignable. Vérifiez la connexion Internet.");
    } finally {
      if (mounted.current) setLinkBusy(false);
    }
  };

  const testMic = async () => {
    setMic({ state: "recording" });
    try {
      const blob = await record();
      if (!mounted.current) return;
      setMic({ state: "transcribing" });
      const body = new FormData();
      body.append("file", blob, "sirius-test.webm");
      if (keys.groq_key) body.append("groq_key", keys.groq_key);
      const response = await fetch(`${API_BASE_URL}/stt`, { method: "POST", body });
      if (!response.ok) {
        const detail = await readDetail(response, "La transcription a échoué.");
        if (mounted.current) setMic({ state: "error", message: detail });
        return;
      }
      const data = await response.json();
      const text = (data?.text || "").trim();
      if (mounted.current) {
        setMic(text
          ? { state: "ok", text }
          : { state: "error", message: "Je n'ai rien entendu. Rapprochez-vous du micro et réessayez." });
      }
    } catch (error) {
      if (!mounted.current) return;
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      setMic({
        state: "error",
        message: denied ? "Accès au micro refusé. Autorisez-le dans les réglages de l'appareil." : (error?.message || "Micro indisponible."),
      });
    }
  };

  const finish = () => {
    const trimmed = name.trim() || userName || "Utilisateur";
    onComplete({ name: trimmed }, keys);
  };

  const brainLabel = {
    local: "Cerveau local (vos clés) ✓",
    cloud: `ΣIRIUS Cloud relié${brain.email ? ` (${brain.email})` : ""} ✓`,
    server: "ΣIRIUS Cloud ✓",
  }[brain.via];

  return (
    <div className="setup-screen fw-screen" data-testid="first-run-wizard">
      <div className="setup-grid-bg" />
      <div className="setup-card fw-card">
        <h1 className="setup-title">BIENVENUE DANS ΣIRIUS</h1>
        <ol className="fw-steps">
          <Step index={0} current={step} label="Cerveau" />
          <Step index={1} current={step} label="Micro" />
          <Step index={2} current={step} label="Prêt" />
        </ol>

        {step === 0 && (
          <section className="fw-body" data-testid="fw-brain">
            <h2><Brain size={18} /> Le cerveau de ΣIRIUS</h2>
            {brain.state === "checking" && <p className="fw-status"><Loader2 size={14} className="spin" /> Recherche du cerveau…</p>}
            {brain.state === "ready" && <p className="fw-status ok" data-testid="fw-brain-ok"><CheckCircle2 size={14} /> {brainLabel}</p>}
            {brain.state === "down" && (
              <>
                <p className="fw-status ko" data-testid="fw-brain-down"><XCircle size={14} /> Le moteur ne répond pas encore.</p>
                <button type="button" className="fw-secondary" onClick={checkBrain}>Réessayer</button>
              </>
            )}
            {brain.state === "link" && (
              <form className="fw-link" onSubmit={linkAccount} data-testid="fw-link-form">
                <p>Connectez votre compte ΣIRIUS : il fournit l'intelligence, la voix et la transcription, <b>sans aucune clé à configurer</b>.</p>
                <div className="fw-tabs">
                  <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>J'ai un compte</button>
                  <button type="button" className={mode === "register" ? "on" : ""} onClick={() => setMode("register")} data-testid="fw-mode-register">Créer un compte</button>
                </div>
                {mode === "register" && (
                  <input className="setup-input" placeholder="Prénom" value={form.name} autoComplete="name"
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} data-testid="fw-link-name" />
                )}
                <input className="setup-input" type="email" placeholder="Email" value={form.email} required autoComplete="email"
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} data-testid="fw-link-email" />
                <input className="setup-input" type="password" placeholder={mode === "register" ? "Mot de passe (8 caractères minimum)" : "Mot de passe"}
                  value={form.password} required autoComplete={mode === "register" ? "new-password" : "current-password"}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} data-testid="fw-link-password" />
                {linkError && <p className="fw-status ko" role="alert" data-testid="fw-link-error">{linkError}</p>}
                <button type="submit" className="fw-primary" disabled={linkBusy} data-testid="fw-link-submit">
                  {linkBusy ? <Loader2 size={14} className="spin" /> : mode === "register" ? "Créer et relier" : "Relier mon compte"}
                </button>
              </form>
            )}
            <div className="fw-actions">
              {onExpert && <button type="button" className="fw-link-btn" onClick={onExpert} data-testid="fw-expert">J'ai mes propres clés (mode expert)</button>}
              <button type="button" className="fw-primary" onClick={() => setStep(1)} data-testid="fw-next-brain">
                {brain.state === "ready" ? "Suivant" : "Plus tard"}
              </button>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="fw-body" data-testid="fw-mic">
            <h2><Mic size={18} /> Le micro</h2>
            <p>Appuyez sur le bouton, puis dites « Bonjour SIRIUS ».</p>
            <button type="button" className="fw-primary" onClick={testMic}
              disabled={mic.state === "recording" || mic.state === "transcribing"} data-testid="fw-mic-test">
              {mic.state === "recording" ? "Je vous écoute…" : mic.state === "transcribing" ? "Transcription…" : "Tester le micro"}
            </button>
            {mic.state === "ok" && <p className="fw-status ok" data-testid="fw-mic-ok"><CheckCircle2 size={14} /> J'ai entendu : « {mic.text} »</p>}
            {mic.state === "error" && <p className="fw-status ko" role="alert" data-testid="fw-mic-error"><XCircle size={14} /> {mic.message}</p>}
            <div className="fw-actions">
              <button type="button" className="fw-secondary" onClick={() => setStep(0)}>Retour</button>
              <button type="button" className="fw-primary" onClick={() => setStep(2)} data-testid="fw-next-mic">
                {mic.state === "ok" ? "Suivant" : "Passer"}
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="fw-body" data-testid="fw-ready">
            <h2><Rocket size={18} /> Tout est prêt</h2>
            <ul className="fw-summary">
              <li className={brain.state === "ready" ? "ok" : "ko"}>Cerveau : {brain.state === "ready" ? "opérationnel" : "à configurer plus tard"}</li>
              <li className="ok">Voix : opérationnelle</li>
              <li className={mic.state === "ok" ? "ok" : "ko"}>Micro : {mic.state === "ok" ? "testé" : "non testé"}</li>
            </ul>
            <label className="setup-label" htmlFor="fw-name">Comment dois-je vous appeler ?</label>
            <input id="fw-name" className="setup-input" value={name} onChange={(e) => setName(e.target.value)} data-testid="fw-name" />
            <div className="fw-actions">
              <button type="button" className="fw-secondary" onClick={() => setStep(1)}>Retour</button>
              <button type="button" className="fw-primary" onClick={finish} data-testid="fw-finish">Commencer</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
