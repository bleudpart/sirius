import { AudioLines, Mic, Square } from "lucide-react";

const LABELS = {
  idle: "Prêt",
  checking: "Je vérifie le profil vocal…",
  requesting: "Ouverture du microphone…",
  listening: "J’écoute…",
  verifying: "Je vérifie votre voix…",
  rejected: "Demande ignorée",
  error: "Dialogue vocal interrompu",
  transcribing: "Je transcris…",
  thinking: "Je traite votre demande…",
  preparing: "Je prépare la voix…",
  speaking: "Je réponds…",
};

export default function VoiceSessionControls({ phase, message, onStop, androidRecognition, onRecognitionChange }) {
  const state = Object.hasOwn(LABELS, phase) ? phase : "idle";
  const StatusIcon = state === "speaking" || state === "preparing" ? AudioLines : Mic;
  return (
    <div className="voice-session-controls" data-phase={state} data-testid="sirius-voice-controls">
      <span className="voice-session-emblem" aria-hidden="true"><StatusIcon size={19} /></span>
      <div className="voice-session-status" role="status" aria-live="polite" aria-atomic="true">
        <span className="voice-session-caption" aria-hidden="true">DIALOGUE VOCAL</span>
        <span className="voice-session-label">{LABELS[state]}</span>
        {message && <small className="voice-session-detail">{message}</small>}
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
