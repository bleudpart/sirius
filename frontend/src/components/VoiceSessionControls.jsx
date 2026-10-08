const LABELS = {
  idle: "Prêt",
  requesting: "Ouverture du microphone…",
  listening: "J’écoute…",
  transcribing: "Je transcris…",
  thinking: "Je traite votre demande…",
  preparing: "Je prépare la voix…",
  speaking: "Je réponds…",
};

export default function VoiceSessionControls({ phase, message, onStop, androidRecognition, onRecognitionChange }) {
  return (
    <div className="voice-session-controls" data-testid="sirius-voice-controls">
      <div role="status" aria-live="polite" aria-atomic="true">
        <span>{LABELS[phase] || LABELS.idle}</span>
        {message && <small>{message}</small>}
      </div>
      {androidRecognition && (
        <label>
          Micro Android
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
        <span aria-hidden="true">■</span> Arrêter
      </button>
    </div>
  );
}
