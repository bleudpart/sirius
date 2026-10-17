export default function ActionFeedback({ title, impact, recovery, onRetry, busy = false }) {
  return <div className="action-feedback" role="alert">
    <strong>{title}</strong>
    <p>{impact}</p>
    <p>{recovery}</p>
    {onRetry && <button type="button" disabled={busy} onClick={onRetry}>Réessayer</button>}
  </div>;
}
