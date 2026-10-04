export default function MicrophoneIndicator({ active, showLabel = false }) {
  const label = active ? "Microphone ouvert" : "Microphone fermé";
  const dot = (
    <span
      className={`voice-microphone-dot${active ? " is-open" : ""}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
  if (!showLabel) return dot;
  return (
    <span className={`mic-status-pill${active ? " is-open" : ""}`} data-testid="sirius-mic-status">
      {dot}
      <span aria-hidden="true">MICRO</span>
    </span>
  );
}
