// © 2026 Daniel Partel – ΣIRIUS Assistant. Logiciel protégé.
// Assistant de premier démarrage : cerveau → micro → prêt, sans aucune clé à saisir.
import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, CheckCircle2, Loader2, Mic, Rocket, Volume2, XCircle } from "lucide-react";
import { API_BASE_URL } from "@/lib/api";
import { readAccountSetup } from "@/accountSetup";
import { loadApiKeys } from "@/apiKeyStorage";
import { speakFr } from "@/voice";
import { withBackendResponse } from "@/lib/backendRequest";

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
    const status = await readAccountSetup(fetchImpl);
    const personal = loadApiKeys();
    if (status.cloud?.available && !status.cloud.linked
      && status.services.find((service) => service.id === "chat")?.state !== "configured"
      && !personal.groq_key && !personal.groq) {
      return { state: "link", setup: status };
    }
    const configured = Boolean(personal.groq_key || personal.groq)
      || status.services.some((service) => service.id === "chat" && ["configured", "available"].includes(service.state));
    return {
      state: configured ? "configured" : "missing",
      via: personal.groq_key || personal.groq ? "personal" : status.cloud?.linked ? "cloud" : "server",
      setup: status,
    };
  } catch (error) {
    return { state: "down", message: error.message };
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
  const [chatTest, setChatTest] = useState({ state: "idle" });
  const [voiceTest, setVoiceTest] = useState("idle");
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
      await checkBrain();
    } catch {
      setLinkError("ΣIRIUS Cloud est injoignable. Vérifiez la connexion Internet.");
    } finally {
      if (mounted.current) setLinkBusy(false);
    }
  };

  const testChat = async () => {
    setChatTest({ state: "testing" });
    try {
      const data = await withBackendResponse("/setup/test-chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: loadApiKeys() }),
      }, async (response) => {
        if (!response.ok) throw new Error(await readDetail(response, "Le test de réponse IA a échoué."));
        return response.json();
      }, { timeoutMs: 30000 });
      if (data.ok !== true || typeof data.provider !== "string" || !data.provider) {
        throw new Error("Le serveur n'a pas confirmé un test réel du fournisseur IA.");
      }
      if (mounted.current) setChatTest({ state: "ok", provider: data.provider });
    } catch (error) {
      if (mounted.current) setChatTest({ state: "error", message: error.name === "AbortError"
        ? "Le test IA a dépassé le délai. Réessayez." : error.message });
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
      const personal = loadApiKeys();
      if (personal.groq_key) body.append("groq_key", personal.groq_key);
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
    onComplete({ name: trimmed }, loadApiKeys());
  };

  const brainLabel = {
    personal: "Clés personnelles déverrouillées — test IA proposé",
    cloud: "Compte SIRIUS Cloud relié — test IA proposé",
    server: "Service IA configuré sur le serveur — test IA proposé",
  }[brain.via];

  return (
    <div className="setup-screen fw-screen" data-testid="first-run-wizard">
      <div className="setup-grid-bg" />
      <div className="setup-card fw-card">
        <h1 className="setup-title">BIENVENUE DANS ΣIRIUS</h1>
        <ol className="fw-steps">
          <Step index={0} current={step} label="Cerveau" />
          <Step index={1} current={step} label="Micro" />
          <Step index={2} current={step} label="Bilan" />
        </ol>

        {step === 0 && (
          <section className="fw-body" data-testid="fw-brain">
            <h2><Brain size={18} /> Le cerveau de ΣIRIUS</h2>
            {brain.state === "checking" && <p className="fw-status"><Loader2 size={14} className="spin" /> Recherche du cerveau…</p>}
            {brain.state === "configured" && <p className="fw-status" data-testid="fw-brain-ok">{brainLabel}</p>}
            {brain.state === "down" && (
              <>
                <p className="fw-status ko" role="alert" data-testid="fw-brain-down"><XCircle size={14} /> {brain.message}</p>
                <button type="button" className="fw-secondary" onClick={checkBrain}>Réessayer</button>
              </>
            )}
            {brain.setup?.trial?.state === "active" && <p>Essai SIRIUS : 7 jours avec quotas, jusqu'au {new Date(brain.setup.trial.expires_at).toLocaleString("fr-FR")}. Ensuite, utilisez vos propres clés.</p>}
            {brain.state === "missing" && <p className="fw-status ko">Service IA non disponible pour ce compte. Configurez ou déverrouillez vos clés personnelles.</p>}
            {brain.state === "configured" && <button type="button" className="fw-primary" onClick={testChat} disabled={chatTest.state === "testing"} data-testid="fw-chat-test">Tester une réponse IA</button>}
            {chatTest.state === "testing" && <p role="status">Test IA en cours…</p>}
            {chatTest.state === "ok" && <p className="fw-status ok" data-testid="fw-chat-ok">Réponse IA testée avec {chatTest.provider}.</p>}
            {chatTest.state === "error" && <p role="alert" className="fw-status ko">{chatTest.message}</p>}
            {brain.state === "link" && (
              <form className="fw-link" onSubmit={linkAccount} data-testid="fw-link-form">
                <p>Reliez votre compte SIRIUS pour les services de l'essai de 7 jours, sous quotas. Les clés personnelles prennent ensuite le relais.</p>
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
              {onExpert && <button type="button" className="fw-link-btn" onClick={onExpert} data-testid="fw-expert">Configurer mes clés / importer mon coffre</button>}
              <button type="button" className="fw-primary" onClick={() => setStep(1)} data-testid="fw-next-brain">
                Suivant
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
            <h2><Volume2 size={18} /> La lecture vocale</h2>
            <button type="button" className="fw-secondary" onClick={() => {
              setVoiceTest("playing");
              speakFr("Bonjour, ceci est un test de lecture SIRIUS.", {
                onend: () => { if (mounted.current) setVoiceTest("confirm"); },
              });
            }} disabled={voiceTest === "playing"} data-testid="fw-voice-test">Écouter une phrase de test</button>
            {(voiceTest === "confirm" || voiceTest === "heard" || voiceTest === "failed") && <div>
              <p>Avez-vous entendu la phrase ?</p>
              <button type="button" className="fw-secondary" onClick={() => setVoiceTest("heard")} data-testid="fw-voice-heard">Oui</button>
              <button type="button" className="fw-secondary" onClick={() => setVoiceTest("failed")}>Non</button>
            </div>}
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
            <h2><Rocket size={18} /> Bilan de votre installation</h2>
            <ul className="fw-summary">
              <li className={chatTest.state === "ok" ? "ok" : "ko"}>Réponse IA : {chatTest.state === "ok" ? "test réussi" : "non vérifiée"}</li>
              <li className={voiceTest === "heard" ? "ok" : "ko"}>Voix : {voiceTest === "heard" ? "audible, confirmée par vous" : voiceTest === "failed" ? "non entendue" : "non vérifiée"}</li>
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
