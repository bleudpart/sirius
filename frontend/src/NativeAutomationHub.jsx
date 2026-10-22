import { useEffect, useRef, useState } from "react";
import "./NativeAutomationHub.css";

export default function NativeAutomationHub({ open, onClose, onReview, onRequestOpen }) {
  const bridge = window.siriusNative;
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const token = useRef(null);
  const locked = useRef(false);
  const lifecycle = useRef(null);
  const [restart, setRestart] = useState(0);
  const requestOpen = useRef(onRequestOpen);
  requestOpen.current = onRequestOpen;
  useEffect(() => {
    if (!bridge) return undefined;
    const session = { alive: true };
    lifecycle.current = session;
    setBusy(true); locked.current = true;
    const unsubscribe = bridge.onEvent((next) => {
      if (session.alive) {
        setState(next);
        if (next.events?.[0]?.kind === "review") requestOpen.current?.();
      }
    });
    void bridge.begin().then((result) => {
      if (!session.alive) {
        return bridge.stop(result.token).catch((failure) => console.warn("Arrêt des hooks Windows impossible.", failure));
      }
      token.current = result.token; setState(result.state);
    }).catch((failure) => {
      if (session.alive) setError(failure.message || "Initialisation Windows impossible.");
    }).finally(() => {
      if (session.alive) { setBusy(false); locked.current = false; }
    });
    return () => {
      session.alive = false; unsubscribe();
      if (token.current) void bridge.stop(token.current).catch((failure) =>
        console.warn("Arrêt des hooks Windows impossible.", failure));
      token.current = null;
    };
  }, [bridge, restart]);

  const perform = async (action) => {
    if (locked.current) return;
    const session = lifecycle.current;
    locked.current = true; setBusy(true); setError("");
    try {
      if (!token.current) throw new Error("Session Windows indisponible ; réinitialisez les automatisations.");
      const next = await action(token.current);
      if (session.alive) setState(next);
    } catch (failure) { if (session.alive) setError(failure.message || "Automatisation Windows impossible."); }
    finally { if (session.alive) { locked.current = false; setBusy(false); } }
  };
  if (!open) return null;
  return <div className="native-automation-backdrop"><section className="native-automation-panel" role="dialog"
    aria-modal="true" aria-label="Automatisations Windows">
    <button type="button" onClick={onClose}>Fermer</button>
    <h2>Hooks natifs · automatisations Windows</h2>
    {!bridge ? <p>Disponible uniquement dans l'application Windows Electron, pas sur le navigateur ni Android.</p> : <>
      <p>Tout est désactivé au départ. Les autorisations valent pour cette session du compte sur ce PC.
        Fermer ce panneau ne les arrête pas ; déconnexion, rechargement ou fermeture de SIRIUS les arrêtent.
        SIRIUS doit rester ouvert.</p>
      <p>Aucun raccourci ne déclenche le microphone ni un appel IA. Aucun contenu de fichier n'est lu,
        classé, envoyé ou exécuté. Les noms détectés restent dans un journal local en mémoire, limité à 100 événements.</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={() => { setError(""); setState(null); setRestart((value) => value + 1); }}>
        Tout arrêter et réinitialiser</button>
      <fieldset disabled={busy || !state || !token.current}>
        <legend>Autorisations facultatives</legend>
        {[["shortcut", "Ctrl+Alt+S · rappeler la fenêtre SIRIUS"], ["notifications", "Notifications Windows génériques"],
          ["resume", "Événements de reprise et déverrouillage de session"]].map(([key, label]) => <label key={key}>
          <input type="checkbox" checked={state?.[key] || false} onChange={(event) => {
            const options = { shortcut: state.shortcut, notifications: state.notifications, resume: state.resume,
              [key]: event.target.checked };
            void perform((identity) => bridge.configure(identity, options));
          }} />{label}</label>)}
        <p>Les notifications peuvent être masquées par Windows (mode concentration ou autorisations système).</p>
        <button type="button" onClick={() => perform((identity) => bridge.chooseFolder(identity))}>Choisir le dossier à surveiller</button>
        <p>{state?.folder ? `Dossier surveillé : ${state.folder}` : "Aucun dossier surveillé."}</p>
        <p>Surveillance non récursive : les événements peuvent être regroupés et ne prouvent ni création ni fin de copie.
          Vérifiez le dossier avant toute importation. Aucun sous-dossier n'est parcouru.</p>
        <button type="button" disabled={!state?.folder} onClick={() => perform((identity) => bridge.unwatch(identity))}>Arrêter la surveillance du dossier</button>
      </fieldset>
      <button type="button" onClick={onReview}>Consulter les rappels et tâches en attente</button>
      <h3>Journal de cette session · 100 événements maximum</h3>
      <p>Les rappels ne sont pas lus automatiquement. Utilisez le bouton ci-dessus pour ouvrir le suivi CHRONOS.</p>
      <ul>{state?.events.map((event) => <li key={event.id}>{event.at} · {event.message}
        {event.name && <> · {event.name}</>}</li>)}</ul>
    </>}
  </section></div>;
}
