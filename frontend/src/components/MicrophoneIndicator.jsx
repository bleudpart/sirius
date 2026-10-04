export default function MicrophoneIndicator({ active }) {
  const label = active ? "Microphone ouvert" : "Microphone fermé";
  return (
    <span
      className={`voice-microphone-dot${active ? " is-open" : ""}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
