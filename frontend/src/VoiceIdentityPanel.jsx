import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { recordVoiceSample } from "./voiceProfileCapture";
import { voiceIdentityStatus, enrollVoiceIdentity, deleteVoiceIdentity } from "./voiceIdentity";

const defaultApi = { status: voiceIdentityStatus, enroll: enrollVoiceIdentity, remove: deleteVoiceIdentity };
const prompts = [
  "Sirius, je prépare ma journée et je souhaite écouter les informations de ce matin.",
  "Je parle naturellement près du téléphone, dans une pièce calme sans télévision.",
  "Sirius, aide-moi à organiser mon activité et à retrouver mes prochains rendez-vous.",
];

export default function VoiceIdentityPanel({ account, onClose, onBeforeRecord, record = recordVoiceSample, api = defaultApi }) {
  const [status, setStatus] = useState(null);
  const [consent, setConsent] = useState(false);
  const [samples, setSamples] = useState([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const controller = useRef(null);
  const capture = useRef(null);
  const generation = useRef(0);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    const id = ++generation.current;
    if (account) api.status({ signal: abort.signal }).then((value) => {
      if (!abort.signal.aborted) setStatus(value);
    }).catch((err) => { if (!abort.signal.aborted) setError(err.message); });
    return () => {
      if (generation.current === id) generation.current += 1;
      abort.abort();
      capture.current?.cancel();
    };
  }, [account, api]);

  const begin = async () => {
    if (busy || recording || samples.length >= 3 || !consent || status?.ready !== true) return;
    const id = ++generation.current;
    const isCurrent = () => generation.current === id && !controller.current.signal.aborted;
    setRecording(true); setError(""); setNotice("");
    try {
      await onBeforeRecord?.();
      if (!isCurrent()) return;
      const session = await record({
        platform: Capacitor.getPlatform(), isCurrent,
        onReady: (sample) => {
          if (!isCurrent()) return;
          setRecording(false);
          if (!Number.isFinite(sample.duration) || sample.duration < 3 || sample.duration > 15) {
            setError("Parlez pendant 3 à 15 secondes. Cet extrait n'a pas été ajouté.");
            return;
          }
          setSamples((previous) => [...previous, sample]);
        },
        onError: (err) => { if (isCurrent()) { setRecording(false); setError(err.message); } },
      });
      if (!isCurrent()) session.cancel();
      else capture.current = session;
    } catch (err) {
      if (isCurrent()) { setRecording(false); setError(err.message); }
    }
  };
  const enroll = async () => {
    if (!consent || samples.length !== 3 || busy || recording) return;
    setBusy(true); setError(""); setNotice("");
    const signal = controller.current.signal;
    try {
      await onBeforeRecord?.();
      if (signal.aborted) return;
      await api.enroll(samples, { signal });
      if (signal.aborted) return;
      const next = await api.status({ signal });
      if (signal.aborted) return;
      setStatus(next); setSamples([]); setConsent(false);
      if (next.ready !== true || next.enrolled !== true) throw new Error("Le serveur n'a pas confirmé l'activation du profil vocal.");
      setNotice("Profil vocal enregistré. L'écoute continue vérifiera chaque extrait avant sa transcription.");
    } catch (err) { if (!signal.aborted) setError(err.message); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(""); setNotice("");
    const signal = controller.current.signal;
    try {
      await onBeforeRecord?.();
      if (signal.aborted) return;
      await api.remove({ signal });
      if (signal.aborted) return;
      setStatus((previous) => ({ ...previous, enrolled: false, ready: false }));
      setSamples([]); setConsent(false); setConfirmDelete(false);
      setNotice("Empreinte vocale supprimée du serveur. L'écoute continue est bloquée ; le bouton maintenu reste disponible.");
      const next = await api.status({ signal });
      if (!signal.aborted) setStatus(next);
    } catch (err) { if (!signal.aborted) setError(err.message); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const close = () => { controller.current?.abort(); generation.current += 1; capture.current?.cancel(); onClose(); };
  return <section className="prime-screen voice-profile-panel" data-testid="voice-identity-panel"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <header className="zeus-head"><h2>Vérifier ma voix en écoute continue</h2>
      <button type="button" onClick={close}>Retour au profil local</button></header>
    <div className="voice-profile-content">
      <p>Cette fonction compare le locuteur, elle ne personnalise pas la transcription. Elle filtre les voix différentes mais ne garantit pas le rejet d'une télévision, d'un mélange de voix, d'une imitation ou d'un enregistrement de votre voix. Ce n'est pas une authentification pour les actions sensibles.</p>
      <p>Avec votre accord, les trois références et les extraits d'écoute continue sont envoyés au serveur Sirius pour comparaison. Le serveur conserve une empreinte biométrique liée à votre compte, pas les fichiers audio de référence. Les extraits refusés ne sont pas envoyés à la transcription. Une demande acceptée suit ensuite les fournisseurs de transcription habituels.</p>
      <p>Les exemples de la bibliothèque locale ne sont jamais envoyés automatiquement. Les trois nouvelles références restent en mémoire sur cet écran jusqu'à validation, puis sont libérées. Aucun micro ne s'ouvre à l'affichage.</p>
      {!account && <p role="alert">Connectez-vous pour créer votre empreinte vocale personnelle.</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {status && <p role="status">{status.ready !== true
        ? status.reason === "model_changed"
          ? "Le modèle vocal a changé. Supprimez l'ancienne empreinte serveur, puis enregistrez de nouvelles références."
          : "Moteur non disponible sur le serveur : l'écoute continue est bloquée. Utilisez le bouton micro maintenu."
        : status.enrolled === true ? "Votre profil vocal serveur est enregistré." : "Aucun profil vocal serveur enregistré."}</p>}
      <label><input type="checkbox" checked={consent} disabled={busy || recording} onChange={(event) => setConsent(event.target.checked)} />
        J'autorise l'envoi de ces nouvelles références et des extraits d'écoute continue au serveur Sirius, ainsi que la conservation de mon empreinte vocale jusqu'à sa suppression.</label>
      <p>Enregistrez seul, sans télévision, trois extraits distincts de 3 à 15 secondes, avec votre voix habituelle.</p>
      <p>En écoute continue, l'extrait doit durer au moins 3 secondes pour être comparé. Pour une demande courte, utilisez le bouton micro maintenu.</p>
      <p>{samples.length}/3 extraits prêts. {samples.length < 3 && prompts[samples.length]}</p>
      <button type="button" disabled={!account || status?.ready !== true || !consent || busy || recording || samples.length >= 3} onClick={begin}>Enregistrer une référence vocale</button>
      {recording && <button type="button" onClick={() => capture.current?.stop()}>Terminer cette référence</button>}
      <button type="button" disabled={busy || recording || samples.length === 0} onClick={() => { setSamples([]); setError(""); }}>Recommencer les références</button>
      <button type="button" disabled={!consent || samples.length !== 3 || busy || recording} onClick={enroll}>Envoyer et activer mon profil vocal</button>
      {status?.enrolled === true && <button type="button" disabled={busy || recording} onClick={() => setConfirmDelete(true)}>Supprimer mon empreinte serveur</button>}
      {confirmDelete && <div><p>La suppression bloque l'écoute continue tant qu'un nouveau profil n'est pas créé.</p>
        <button type="button" disabled={busy} onClick={remove}>Confirmer la suppression serveur</button>
        <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Annuler</button></div>}
      <p>En cas de doute, d'absence de profil ou d'erreur du serveur, aucune commande automatique n'est acceptée. Maintenir volontairement le bouton micro permet de parler sans vérification du locuteur. L'interruption vocale pendant que Sirius parle n'est pas disponible en écoute protégée ; utilisez Stop ou le bouton maintenu.</p>
    </div>
  </section>;
}
