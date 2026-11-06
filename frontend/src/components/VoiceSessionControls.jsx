import { AudioLines, Mic, Square } from "lucide-react";

const LABELS = {
  idle: "Prêt",
  checking: "Préparation…",
  requesting: "Activation du micro…",
  listening: "J’écoute…",
  verifying: "Un instant…",
  rejected: "Demande ignorée",
  error: "Dialogue vocal interrompu",
  transcribing: "Un instant…",
  thinking: "Je traite votre demande…",
  preparing: "Un instant…",
  speaking: "Je réponds…",
};

const VALIDATION_LABELS = {
  idle: "Aucune vérification de voix en cours",
  preparing: "Préparation du profil vocal",
  checking: "Vérification de la voix en cours",
  verified: "Voix vérifiée pour cette demande",
  rejected: "Vérification de la voix non validée",
};

export default function VoiceSessionControls({ phase, message, voiceValidation, onStop, androidRecognition, onRecognitionChange, compact = false }) {
  const state = Object.hasOwn(LABELS, phase) ? phase : "idle";
  const refusal = /(?:voix non reconnue|voix non vérifiée|voix non verifiee|demande ignorée|commande ignorée)/i.test(message || "");
  const specificRefusal = refusal && /voix non reconnue/i.test(message || "");
  const label = specificRefusal ? (compact ? "Voix non reconnue : demande ignorée." : message)
    : compact && state === "thinking" ? "Je traite…" : LABELS[state];
  const detail = specificRefusal ? "" : message;
  const urgent = refusal || state === "rejected" || state === "error";
  const validation = voiceValidation === "rejected" && refusal ? "rejected"
    : state === "verifying" ? "checking" : state === "checking" ? "preparing"
      : voiceValidation === "verified" ? "verified" : "idle";
  const StatusIcon = state === "speaking" || state === "preparing" ? AudioLines : Mic;
  return (
    <div className="voice-session-controls" data-phase={state}
      data-quiet={state === "idle" && !message ? "true" : undefined} data-testid="sirius-voice-controls">
      <span className="voice-session-emblem" aria-hidden="true"><StatusIcon size={19} /></span>
      <div className="voice-session-status" role="status" aria-live={urgent ? "assertive" : "polite"} aria-atomic="true">
        <span className="voice-session-caption" aria-hidden="true">DIALOGUE VOCAL</span>
        <span className="voice-session-label">
          <span title={specificRefusal && compact ? message : undefined}
            aria-label={specificRefusal && compact ? message : undefined}>{label}</span>
          <span className={`voice-validation is-${validation}`} data-testid="voice-validation" data-state={validation}
            role="img" aria-label={VALIDATION_LABELS[validation]} title={VALIDATION_LABELS[validation]} />
        </span>
        {detail && <small className="voice-session-detail">{detail}</small>}
      </div>
      {androidRecognition && (
        <label>
          <span className="voice-session-engine-label">Micro Android</span>
          <select aria-label="Moteur de reconnaissance Android" value={androidRecognition}
            onChange={(event) => onRecognitionChange(event.target.value)}>
            <option value="server">Serveur</option>
            <option value="native">Local (test)</option>
          </select>
        </label>
      )}
      <button
        type="button"
        onPointerDown={onStop}
        onClick={(event) => { if (event.detail === 0) onStop(); }}
        aria-label="Arrêter le microphone et la réponse"
        title="Interrompre l'écoute et la réponse ; une action déjà envoyée ne sera pas annulée"
      >
        <Square size={11} aria-hidden="true" /><span className="voice-session-stop-label">Arrêter</span>
      </button>
    </div>
  );
}
