import { useEffect, useRef, useState } from "react";
import { collectVoiceDiagnostic } from "../voiceDiagnostic";
import "./VoiceDiagnosticPanel.css";

const labels = { ok: "Contrôle réussi", error: "À corriger", unknown: "Non vérifié" };

export default function VoiceDiagnosticPanel({ onClose, onProfile, onSettings, collect = collectVoiceDiagnostic }) {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const closeButton = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(""); setReport(null);
    collect({ signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setReport(result);
    }).catch((err) => {
      if (!controller.signal.aborted) setError(err.message || "Diagnostic indisponible. Réessayez.");
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [collect, revision]);
  return <section className="prime-screen voice-diagnostic-panel" role="dialog" aria-labelledby="voice-diagnostic-title"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header><h2 id="voice-diagnostic-title">Vérifier Sirius</h2>
      <button ref={closeButton} type="button" onClick={onClose}>Fermer le diagnostic</button></header>
    <p>Contrôles limités, sans ouvrir le microphone, sans enregistrer votre voix et sans lancer de synthèse vocale.
      Le serveur est interrogé avec votre session ; aucun extrait audio n'est envoyé.</p>
    <p role="status">{busy ? "Contrôles en cours…" : report ? `Contrôles relevés le ${new Date(report.measuredAt).toLocaleString("fr-FR")}.` : "Aucun résultat confirmé."}</p>
    {error && <p role="alert">{error}</p>}
    {report && <ul>{report.checks.map((check) => <li key={check.id} data-state={check.state}>
      <h3>{check.label} — {labels[check.state]}</h3>
      <p>{check.detail}</p>
      {typeof check.ms === "number" && check.id !== "permission" && <small>Aller-retour mesuré : {check.ms} ms. Ce n'est pas le délai d'une réponse vocale complète.</small>}
    </li>)}</ul>}
    <p>Une panne observée ne permet pas d'accuser un Wi-Fi précis. Comparez avec les données mobiles si le serveur ne répond pas.
      Pour une demande de moins de 3 secondes, utilisez le bouton micro maintenu ; la protection n'est jamais contournée automatiquement.</p>
    <footer>
      <button type="button" disabled={busy} onClick={() => setRevision((value) => value + 1)}>Relancer les contrôles</button>
      <button type="button" onClick={onProfile}>Ouvrir mon profil vocal</button>
      <button type="button" onClick={onSettings}>Ouvrir les réglages voix</button>
    </footer>
  </section>;
}
