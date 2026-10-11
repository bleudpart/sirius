import { Mic } from "lucide-react";

export default function PushToTalkButton({ active, ready, onStart, onStop }) {
  return (
    <button
      type="button"
      className={`ptt-btn ${active ? "on" : ""}`}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        onStart();
      }}
      onPointerUp={onStop}
      onPointerCancel={onStop}
      onLostPointerCapture={onStop}
      onContextMenu={(event) => event.preventDefault()}
      data-testid="sirius-ptt-btn"
      title="Talkie-walkie : maintenir pour parler, relâcher pour envoyer (ou touche Espace)"
      aria-pressed={active}
      aria-label={active ? (ready ? "Microphone ouvert : relâchez pour envoyer" : "Ouverture du microphone") : "Maintenir pour parler, relâcher pour envoyer"}
    >
      <Mic size={18} aria-hidden="true" />
      <span className="ptt-label">
        <span>{active ? (ready ? "À VOUS" : "OUVERTURE…") : "ESPACE"}</span>
      </span>
    </button>
  );
}
