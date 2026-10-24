import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Headphones, Mic, Minus, RotateCcw, ShieldCheck, Square, Trash2, X } from "lucide-react";
import { minimizeHoloWindow } from "./holoWindows";
import { recordVoiceSample } from "./voiceProfileCapture";
import { voiceIdentityStatus, enrollVoiceIdentity, deleteVoiceIdentity } from "./voiceIdentity";
import "./VoiceProfilePanel.css";

const defaultApi = { status: voiceIdentityStatus, enroll: enrollVoiceIdentity, remove: deleteVoiceIdentity };
const prompts = [
  "Sirius, je prépare ma journée et je souhaite écouter les informations de ce matin.",
  "Je parle naturellement près du téléphone, dans une pièce calme sans télévision.",
  "Sirius, aide-moi à organiser mon activité et à retrouver mes prochains rendez-vous.",
];
const steps = ["Préparer", "Enregistrer", "Activer"];

export default function VoiceIdentityPanel({ account, onClose, onDismiss = onClose, onBeforeRecord, record = recordVoiceSample, api = defaultApi }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [consent, setConsent] = useState(false);
  const [samples, setSamples] = useState([]);
  const [draft, setDraft] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [elapsed, setElapsed] = useState(0);
  const [step, setStep] = useState(0);
  const [configuring, setConfiguring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const controller = useRef(null);
  const capture = useRef(null);
  const stopRequested = useRef(false);
  const content = useRef(null);
  const generation = useRef(0);
  const players = useRef(new Set());
  const registerPlayer = useCallback((player) => {
    players.current.add(player);
    return () => players.current.delete(player);
  }, []);
  const stopPlayback = () => players.current.forEach((player) => player.pause());
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    setLoading(Boolean(account)); setStatus(null); setConsent(false); setSamples([]); setDraft(null);
    setStep(0); setPhase("idle"); setBusy(false); setError(""); setNotice(""); setConfiguring(false); setConfirmDelete(false);
    if (account) api.status({ signal: abort.signal }).then((value) => {
      if (!abort.signal.aborted) setStatus(value);
    }).catch((err) => { if (!abort.signal.aborted) setError(err.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => {
      generation.current += 1;
      abort.abort();
      capture.current?.cancel();
      capture.current = null;
    };
  }, [account, api]);
  useEffect(() => {
    if (phase !== "recording") return undefined;
    const began = Date.now();
    const timer = setInterval(() => setElapsed(Math.min(15, Math.floor((Date.now() - began) / 1000))), 250);
    return () => clearInterval(timer);
  }, [phase]);

  const capturing = phase !== "idle";
  const activeProfile = status?.ready === true && status.enrolled === true && !configuring;
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [step, activeProfile]);
  const refresh = async () => {
    const signal = controller.current.signal;
    setLoading(true); setError("");
    try {
      const next = await api.status({ signal });
      if (!signal.aborted) setStatus(next);
    } catch (err) { if (!signal.aborted) setError(err.message); }
    finally { if (!signal.aborted) setLoading(false); }
  };
  const cancelRecording = () => {
    generation.current += 1;
    capture.current?.cancel(); capture.current = null;
    setPhase("idle"); setElapsed(0);
  };
  const begin = async () => {
    if (busy || capturing || draft || step !== 1 || samples.length >= 3 || !consent || status?.ready !== true) return;
    const id = ++generation.current;
    const signal = controller.current.signal;
    const isCurrent = () => generation.current === id && !signal.aborted;
    stopPlayback(); capture.current = null; stopRequested.current = false;
    setPhase("preparing"); setElapsed(0); setError(""); setNotice("");
    try {
      await onBeforeRecord?.();
      if (!isCurrent()) return;
      const session = await record({
        platform: Capacitor.getPlatform(), isCurrent,
        onStart: () => { if (isCurrent()) setPhase("recording"); },
        onReady: (sample) => {
          if (!isCurrent()) return;
          setPhase("idle");
          if (!sample.audio?.size || !Number.isFinite(sample.duration) || sample.duration < 3 || sample.duration > 15) {
            setError("Parlez pendant 3 à 15 secondes. Cet extrait n'a pas été ajouté.");
            return;
          }
          setDraft(sample);
        },
        onError: (err) => { if (isCurrent()) { setPhase("idle"); setError(err.message); } },
      });
      if (!isCurrent()) session.cancel();
      else {
        capture.current = session;
        if (stopRequested.current) session.stop();
      }
    } catch (err) {
      if (isCurrent()) {
        setPhase("idle");
        setError(err.name === "NotAllowedError" ? "Microphone refusé. Autorisez le micro dans les réglages de l'application, puis réessayez." : err.message);
      }
    }
  };
  const confirmSample = () => {
    if (!draft || capturing || busy) return;
    stopPlayback();
    setSamples((previous) => [...previous, draft]); setDraft(null); setError("");
    if (samples.length === 2) setStep(2);
  };
  const restart = () => {
    stopPlayback(); setSamples([]); setDraft(null); setStep(1); setError(""); setNotice("");
  };
  const enroll = async () => {
    if (!consent || samples.length !== 3 || draft || busy || capturing || status?.ready !== true) return;
    stopPlayback(); setBusy(true); setError(""); setNotice("");
    const signal = controller.current.signal;
    try {
      await onBeforeRecord?.();
      if (signal.aborted) return;
      await api.enroll(samples, { signal });
      if (signal.aborted) return;
      const next = await api.status({ signal });
      if (signal.aborted) return;
      setStatus(next);
      if (next.ready !== true || next.enrolled !== true) throw new Error("Le serveur n'a pas confirmé l'activation du profil vocal.");
      setSamples([]); setDraft(null); setConsent(false); setConfiguring(false);
      setNotice("Profil vocal enregistré. L'écoute continue vérifiera chaque extrait avant sa transcription.");
    } catch (err) { if (!signal.aborted) setError(err.message); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const remove = async () => {
    stopPlayback(); setBusy(true); setError(""); setNotice("");
    const signal = controller.current.signal;
    try {
      await onBeforeRecord?.();
      if (signal.aborted) return;
      await api.remove({ signal });
      if (signal.aborted) return;
      setStatus((previous) => ({ ...previous, enrolled: false, ready: false }));
      setSamples([]); setDraft(null); setConsent(false); setConfirmDelete(false); setStep(0); setConfiguring(false);
      setNotice("Empreinte vocale supprimée du serveur. L'écoute continue est bloquée ; le bouton maintenu reste disponible.");
      const next = await api.status({ signal });
      if (!signal.aborted) setStatus(next);
    } catch (err) { if (!signal.aborted) setError(err.message); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const leave = (callback) => {
    controller.current?.abort(); generation.current += 1; capture.current?.cancel(); stopPlayback(); callback();
  };
  const statusLabel = !account ? "Connexion nécessaire" : loading ? "Connexion au moteur…" : !status ? "Connexion non confirmée"
    : status.ready !== true ? "Moteur indisponible" : status.enrolled ? "Profil enregistré" : "Prêt à configurer";
  return <section className="prime-screen voice-profile-panel voice-studio" data-testid="voice-identity-panel"
    aria-label="Ma voix"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); leave(onDismiss); } }}>
    <header className="zeus-head mobile-window-controls">
      <div className="voice-studio-heading"><Mic size={23} aria-hidden="true" /><div>
        <h2 className="voice-identity-title" data-module-name="Ma voix">Ma voix</h2><span>Votre espace vocal personnel</span>
      </div></div>
      <button type="button" className="holo-win-min mobile-window-min" aria-label="Réduire la fenêtre" title="Réduire en pastille"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); cancelRecording(); stopPlayback(); minimizeHoloWindow(event.currentTarget.closest(".voice-studio")); }}><Minus size={18} /></button>
      <button type="button" className="setup-close zeus-close" aria-label="Fermer la vérification de ma voix" onClick={() => leave(onDismiss)}><X size={18} /></button>
    </header>
    <div className="voice-profile-content voice-studio-content" ref={content}>
      <div className={`voice-studio-intro ${step > 0 && !activeProfile ? "is-compact" : ""}`}><span className="voice-studio-eyebrow">SIRIUS · IDENTITÉ VOCALE</span>
        {(step === 0 || activeProfile) && <>
          <h3>{activeProfile ? "Votre voix est configurée." : "Une voix familière. La vôtre."}</h3>
          <p>{activeProfile ? "Votre empreinte est enregistrée sur le serveur Sirius." : "Trois courts extraits pour comparer votre voix avant les demandes en écoute continue."}</p>
        </>}
        <span className={`voice-studio-status ${status?.ready ? "is-ready" : ""}`} role="status"><ShieldCheck size={16} aria-hidden="true" />{statusLabel}</span>
      </div>
      {!account && <p className="voice-studio-alert" role="alert">Connectez-vous pour créer votre empreinte vocale personnelle.</p>}
      {error && <p className="voice-studio-alert" role="alert">{error}</p>}
      {notice && <p className="voice-studio-notice" role="status">{notice}</p>}
      {status?.ready === false && <div className="voice-studio-card">
        <h3>{status.reason === "model_changed" ? "Votre profil doit être renouvelé" : "Le moteur n'est pas disponible"}</h3>
        <p>{status.reason === "model_changed" ? "Le modèle vocal a changé. Supprimez l'ancienne empreinte serveur, puis enregistrez de nouvelles références."
          : "Moteur non disponible sur le serveur : l'écoute continue est bloquée. Utilisez le bouton micro maintenu."}</p>
      </div>}
      {account && !loading && !capturing && status?.ready !== true && <button type="button" className="voice-studio-link" disabled={busy} onClick={refresh}><RotateCcw size={16} aria-hidden="true" />Actualiser l'état du moteur</button>}
      {activeProfile ? <div className="voice-studio-card voice-studio-success">
        <CheckCircle2 size={42} aria-hidden="true" /><h3>Votre profil vocal est prêt</h3>
        <p>Vous pouvez utiliser l'écoute continue depuis le micro habituel. Cette page ne l'active pas automatiquement.</p>
        <p>Faites un essai réel au calme. Un profil enregistré ne prouve pas le rejet de la télévision.</p>
        <button type="button" className="voice-studio-primary" disabled={busy} onClick={() => {
          setConfiguring(true); setStep(0); setConsent(false); setNotice(""); setError("");
        }}><Mic size={18} aria-hidden="true" />Refaire mes enregistrements</button>
        <button type="button" disabled={busy} onClick={() => leave(onDismiss)}>Terminer</button>
      </div> : <>
        <ol className="voice-studio-steps" aria-label="Étapes de configuration">
          {steps.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined} className={index < step ? "is-complete" : ""}>
            <span>{index < step ? <Check size={16} aria-hidden="true" /> : index + 1}</span>{label}
          </li>)}
        </ol>
        {step === 0 && <div className="voice-studio-card">
          <h3>Commençons au calme</h3>
          <ul className="voice-studio-checklist"><li>Coupez la télévision et la musique.</li><li>Gardez le téléphone près de vous, sans le coller à la bouche.</li><li>Lisez les trois phrases avec votre voix habituelle.</li></ul>
          <p>Chaque extrait dure de 3 à 15 secondes. Vous pourrez le réécouter et le recommencer avant de le valider.</p>
          <div className="voice-studio-consent">
            <p>Les trois références et les extraits d'écoute continue seront envoyés au serveur Sirius pour comparaison. Il conserve une empreinte biométrique liée à votre compte, pas les fichiers audio de référence. Vous pourrez supprimer cette empreinte ici.</p>
            <label><input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} />
              <span>J'autorise cet envoi au serveur Sirius et la conservation de mon empreinte vocale jusqu'à sa suppression.</span></label>
          </div>
          <button type="button" className="voice-studio-primary" disabled={!account || !consent || loading || status?.ready !== true || busy} onClick={() => setStep(1)}>
            Commencer les enregistrements<ArrowRight size={18} aria-hidden="true" /></button>
          <small>Aucun micro ne s'ouvre avant votre appui sur Enregistrer.</small>
        </div>}
        {step === 1 && <div className="voice-studio-card voice-studio-recorder">
          <span className="voice-studio-eyebrow">EXTRAIT {samples.length + 1} SUR 3</span>
          <h3>{draft ? "Réécoutez et confirmez" : "Lisez cette phrase à voix haute"}</h3>
          <blockquote>{prompts[samples.length]}</blockquote>
          {draft ? <>
            <VoiceReference sample={draft} label={`Réécouter l'extrait ${samples.length + 1}`} registerPlayer={registerPlayer} />
            <p>La voix est bien la vôtre et la phrase est audible ? Confirmez cet extrait pour passer à la suite.</p>
            <div className="voice-studio-actions"><button type="button" className="voice-studio-primary" onClick={confirmSample}><Check size={18} aria-hidden="true" />Confirmer cet extrait</button>
              <button type="button" onClick={() => { stopPlayback(); setDraft(null); setError(""); }}><RotateCcw size={16} aria-hidden="true" />Recommencer cet extrait</button></div>
          </> : <>
            <div className={`voice-studio-wave ${phase === "recording" ? "is-recording" : ""}`} aria-hidden="true">
              {Array.from({ length: 25 }, (_, index) => <i key={index} style={{ "--bar-height": `${14 + ((index * 17) % 39)}px`, "--bar-delay": `${(index % 7) * -0.12}s` }} />)}
            </div>
            <div className="voice-studio-timer" aria-label={`${elapsed} secondes sur 15`}>00:{String(elapsed).padStart(2, "0")}<span> / 00:15</span></div>
            <p className="voice-studio-record-state" role="status">{phase === "preparing" ? "Préparation du micro… Attendez avant de parler."
              : phase === "recording" ? "Enregistrement en cours. Parlez maintenant."
                : phase === "finishing" ? "Préparation de votre extrait…" : "Appuyez sur le micro pour commencer."}</p>
            <button type="button" className={`voice-studio-record-button ${phase === "recording" ? "is-recording" : ""}`}
              disabled={phase === "preparing" || phase === "finishing" || busy || status?.ready !== true}
              onClick={phase === "recording" ? () => { stopRequested.current = true; setPhase("finishing"); capture.current?.stop(); } : begin}
              aria-label={phase === "recording" ? "Terminer cette référence" : "Enregistrer une référence vocale"}>
              {phase === "recording" ? <Square size={27} fill="currentColor" aria-hidden="true" /> : <Mic size={31} aria-hidden="true" />}
            </button>
            <p className="voice-studio-record-hint">{phase === "recording" ? "Appuyez sur le carré quand vous avez fini." : "3 secondes minimum · arrêt automatique à 15 secondes"}</p>
            {capturing && <button type="button" onClick={cancelRecording}>Annuler l'enregistrement</button>}
          </>}
          {!capturing && !draft && <button type="button" className="voice-studio-link" onClick={() => setStep(0)}><ArrowLeft size={16} aria-hidden="true" />Revoir la préparation</button>}
        </div>}
        {step === 2 && <div className="voice-studio-card">
          <span className="voice-studio-eyebrow">DERNIÈRE ÉTAPE</span><h3>Tout est prêt pour l'activation</h3>
          <p>Vos trois extraits sont confirmés. Ils restent sur cet écran tant que vous n'appuyez pas sur le bouton ci-dessous.</p>
          <button type="button" className="voice-studio-primary" disabled={busy || !consent || samples.length !== 3 || status?.ready !== true} onClick={enroll}>
            <ShieldCheck size={19} aria-hidden="true" />{busy ? "Activation en cours…" : "Envoyer et activer mon profil vocal"}</button>
          <p>La confirmation du serveur apparaîtra ici. Gardez cette page ouverte pendant l'envoi.</p>
          <button type="button" disabled={busy} onClick={restart}><RotateCcw size={16} aria-hidden="true" />Recommencer les références</button>
        </div>}
        {!!samples.length && <div className="voice-studio-card voice-studio-references">
          <h3><Headphones size={18} aria-hidden="true" />Mes extraits confirmés</h3>
          <p>{samples.length}/3 extraits prêts · non envoyés</p>
          {samples.map((sample, index) => <div className="voice-studio-reference" key={index}>
            <span><CheckCircle2 size={17} aria-hidden="true" />Extrait {index + 1}</span>
            <VoiceReference sample={sample} label={`Réécouter l'extrait confirmé ${index + 1}`} registerPlayer={registerPlayer} />
          </div>)}
        </div>}
      </>}
      <details className="voice-studio-details"><summary>Comprendre la protection de ma voix</summary>
        <p>Cette fonction compare le locuteur, elle ne personnalise pas la transcription. Elle filtre les voix différentes mais ne garantit pas le rejet d'une télévision, d'un mélange de voix, d'une imitation ou d'un enregistrement de votre voix. Ce n'est pas une authentification pour les actions sensibles.</p>
        <p>Les extraits refusés ne sont pas envoyés à la transcription. Une demande acceptée suit ensuite les fournisseurs de transcription habituels.</p>
        <p>Les exemples de la bibliothèque locale ne sont jamais envoyés automatiquement. Les nouvelles références restent en mémoire jusqu'à validation et envoi ; fermer la page abandonne les extraits non envoyés.</p>
        <p>En écoute continue, parlez au moins 3 secondes. Pour une demande courte ou si la vérification est indisponible, maintenez volontairement le bouton micro. Pendant une réponse, utilisez Stop ou le bouton maintenu : l'interruption vocale n'est pas disponible en écoute protégée.</p>
      </details>
      {status?.enrolled === true && <div className="voice-studio-manage">
        <button type="button" className="voice-studio-danger" disabled={busy || capturing} onClick={() => setConfirmDelete(true)}><Trash2 size={16} aria-hidden="true" />Supprimer mon empreinte serveur</button>
        {confirmDelete && <div className="voice-studio-card" role="group" aria-label="Confirmer la suppression du profil vocal">
          <p>La suppression bloque l'écoute continue tant qu'un nouveau profil n'est pas créé. Elle ne supprime pas votre bibliothèque locale.</p>
          <div className="voice-studio-actions"><button type="button" disabled={busy} onClick={remove}>Confirmer la suppression serveur</button>
            <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Annuler</button></div>
        </div>}
      </div>}
      <button type="button" className="voice-studio-library" aria-label="Ouvrir la bibliothèque et la diction" disabled={busy} onClick={() => leave(onClose)}>
        <Headphones size={20} aria-hidden="true" /><span><strong>Bibliothèque et diction</strong><small>Extraits locaux et mots utiles · séparés de la vérification</small></span><ArrowRight size={18} aria-hidden="true" />
      </button>
    </div>
  </section>;
}

function VoiceReference({ sample, label, registerPlayer }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  const player = useRef(null);
  useEffect(() => {
    const audio = player.current;
    const next = URL.createObjectURL(sample.audio);
    const unregister = registerPlayer(audio);
    setUrl(next); setError(false);
    return () => { audio.pause(); unregister(); URL.revokeObjectURL(next); };
  }, [sample.audio, registerPlayer]);
  return <div className="voice-studio-preview">
    <audio ref={player} controls preload="metadata" src={url || undefined} aria-label={label}
      onPlay={(event) => {
        event.currentTarget.closest(".voice-studio").querySelectorAll("audio").forEach((audio) => {
          if (audio !== event.currentTarget) audio.pause();
        });
      }}
      onError={(event) => {
        if (event.currentTarget.getAttribute("src")) setError(true);
      }} />
    <small>{sample.duration.toFixed(1)} s · conservé en mémoire uniquement</small>
    {error && <span role="alert">Réécoute indisponible. Recommencez l'extrait si nécessaire.</span>}
  </div>;
}
