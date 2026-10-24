import { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Mic, X } from "lucide-react";
import { createVoiceProfileStore, voiceProfileAccount } from "./voiceProfileStore";
import { recordVoiceSample } from "./voiceProfileCapture";
import { clearVoiceVocabulary, readVoiceVocabulary, saveVoiceVocabulary } from "./voiceVocabulary";
import VoiceIdentityPanel from "./VoiceIdentityPanel";
import "./VoiceProfilePanel.css";

const storage = createVoiceProfileStore();

export default function VoiceProfilePanel({ user, onClose, onBeforeRecord, store = storage, record = recordVoiceSample }) {
  const account = useMemo(() => {
    try { return voiceProfileAccount(user); } catch { return ""; }
  }, [user]);
  return <VoiceProfileContent key={account} account={account} onClose={onClose} onBeforeRecord={onBeforeRecord} store={store} record={record} />;
}

function VoiceProfileContent({ account, onClose, onBeforeRecord, store, record }) {
  const current = useRef(account);
  current.current = account;
  const generation = useRef(0);
  const capture = useRef(null);
  const player = useRef(null);
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [vocabulary, setVocabulary] = useState(() => readVoiceVocabulary(account));
  const [term, setTerm] = useState("");
  const [identityOpen, setIdentityOpen] = useState(true);
  const updateVocabulary = (next) => {
    try { setVocabulary(saveVoiceVocabulary(account, next)); setError(""); }
    catch (err) { setError(err.message); }
  };
  const discard = () => {
    generation.current += 1;
    capture.current?.cancel();
    capture.current = null;
    player.current?.pause();
    setDraft(null); setText(""); setPreview(""); setRecording(false);
  };
  useEffect(() => {
    generation.current += 1;
    let active = true;
    const audioPlayer = player.current;
    setItems([]); setDraft(null); setText(""); setPreview(""); setError(""); setNotice(""); setConfirmDelete(null); setBusy(false); setRecording(false);
    if (account) store.list(account).then((data) => {
      if (active) setItems(data);
    }).catch((err) => { if (active) setError(err.message); });
    return () => {
      active = false;
      generation.current += 1;
      capture.current?.cancel();
      capture.current = null;
      audioPlayer?.pause();
    };
  }, [account, store]);
  useEffect(() => {
    if (!draft?.audio) return;
    const audioPlayer = player.current;
    const url = URL.createObjectURL(draft.audio);
    setPreview(url);
    return () => { audioPlayer?.pause(); URL.revokeObjectURL(url); };
  }, [draft]);
  const begin = async () => {
    discard();
    setError(""); setNotice(""); setRecording(true);
    const id = generation.current;
    try {
      await onBeforeRecord?.();
      if (generation.current !== id || current.current !== account) return;
      const session = await record({
        platform: Capacitor.getPlatform(),
        isCurrent: () => generation.current === id && current.current === account,
        onReady: (sample) => {
          if (generation.current !== id || current.current !== account) return;
          setDraft(sample); setRecording(false);
        },
        onError: (err) => {
          if (generation.current !== id || current.current !== account) return;
          setError(err.message); setRecording(false);
        },
      });
      if (generation.current !== id) session.cancel();
      else capture.current = session;
    } catch (err) {
      if (generation.current === id) {
        setRecording(false);
        setError(err.name === "NotAllowedError" ? "Permission microphone refusée. Aucun extrait conservé." : err.message);
      }
    }
  };
  const save = async () => {
    if (!draft || !text.trim() || busy) return;
    const id = generation.current;
    setBusy(true); setError("");
    try {
      await store.save(account, { ...draft, text });
      if (generation.current !== id || current.current !== account) return;
      const data = await store.list(account);
      if (generation.current !== id || current.current !== account) return;
      setItems(data); discard(); setNotice("Extrait validé, conservé uniquement sur cet appareil.");
    } catch (err) { if (generation.current === id) setError(err.message); }
    finally { if (current.current === account) setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError("");
    const id = generation.current;
    try {
      if (confirmDelete === "all") {
        await store.clear(account);
        clearVoiceVocabulary(account);
        setVocabulary({ enabled: false, terms: [] });
      }
      else await store.remove(account, confirmDelete);
      const data = await store.list(account);
      if (generation.current !== id || current.current !== account) return;
      setItems(data); setConfirmDelete(null);
      if (confirmDelete === "all") discard();
      setNotice("Suppression locale effectuée.");
    } catch (err) { if (generation.current === id) setError(err.message); }
    finally { if (current.current === account) setBusy(false); }
  };
  const close = () => { discard(); onClose(); };
  if (identityOpen) return <VoiceIdentityPanel account={account} onClose={() => setIdentityOpen(false)} onDismiss={close} onBeforeRecord={onBeforeRecord} record={record} />;
  return <section className="prime-screen voice-profile-panel" data-testid="voice-profile-panel"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <header className="zeus-head">
      <div className="oracle-title font-divine" data-module-name="Ma voix et ma diction"><Mic size={22} /> Bibliothèque et diction</div>
      <button type="button" className="setup-close zeus-close" aria-label="Fermer le profil vocal" onClick={close}><X size={18} /></button>
    </header>
    <div className="voice-profile-content">
      <p>Bibliothèque locale : votre voix, sur cet appareil uniquement. Aucun envoi de ces exemples au serveur, aucune écoute permanente. Un extrait n’est conservé qu’après votre validation.</p>
      <p>Cette bibliothèque conserve vos exemples et leur transcription exacte. Elle n’entraîne pas le moteur de reconnaissance et ne reconnaît pas votre identité.</p>
      <button type="button" onClick={() => { discard(); setIdentityOpen(true); }}>Retour à Ma voix</button>
      {!account && <p role="alert">Connectez-vous pour utiliser votre profil vocal personnel.</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="voice-profile-draft">
        <label><input type="checkbox" checked={vocabulary.enabled} disabled={!account} onChange={(event) => updateVocabulary({ ...vocabulary, enabled: event.target.checked })} />
          Utiliser les mots validés pour guider la reconnaissance</label>
        <p>Option désactivée par défaut. Seules les expressions choisies ci-dessous peuvent être envoyées au fournisseur pendant une transcription distante ordinaire. Aucun extrait conservé du profil n’est envoyé. La désactivation retire les mots des prochaines requêtes, pas d’une requête déjà partie.</p>
        <p>Guidage du serveur uniquement, sans remplacement automatique ni entraînement. Les moteurs locaux Android et navigateur ne sont pas personnalisés par cette option ; la prise en compte des mots dépend du fournisseur.</p>
        <label>Expression à valider (80 caractères maximum)<input aria-label="Expression à valider" value={term} maxLength={80} onChange={(event) => setTerm(event.target.value)} /></label>
        <button type="button" disabled={!account || !term.trim()} onClick={() => {
          try {
            const next = saveVoiceVocabulary(account, { ...vocabulary, terms: [...vocabulary.terms, term] });
            setVocabulary(next); setTerm(""); setError("");
          } catch (err) { setError(err.message); }
        }}>Valider cette expression</button>
        <p>32 expressions et 1 600 caractères maximum. Une transcription longue n’est jamais ajoutée automatiquement : saisissez les mots ou expressions utiles.</p>
        {vocabulary.terms.map((value) => <div key={value}><span>{value}</span> <button type="button" onClick={() => updateVocabulary({ ...vocabulary, terms: vocabulary.terms.filter((entry) => entry !== value) })}>Retirer {value}</button></div>)}
      </div>
      <div className="voice-profile-actions">
        <button type="button" disabled={!account || recording || busy} onClick={begin}>Enregistrer volontairement un extrait</button>
        {recording && <><span role="status">Enregistrement — 15 secondes maximum</span><button type="button" onClick={() => capture.current?.stop()}>Arrêter l’extrait</button><button type="button" onClick={discard}>Annuler l’enregistrement</button></>}
      </div>
      <p>15 secondes et 2 Mo par extrait, 20 extraits maximum. Vos données dépendent du stockage de ce navigateur ou de cette application et ne sont pas synchronisées.</p>
      {draft && <div className="voice-profile-draft">
        <audio ref={player} controls src={preview || undefined} aria-label="Écouter avant validation" />
        <label>Transcription exacte validée par vous<textarea value={text} maxLength={1000} onChange={(event) => setText(event.target.value)} /></label>
        <button type="button" disabled={!text.trim() || busy} onClick={save}>Confirmer et conserver localement</button>
        <button type="button" disabled={busy} onClick={discard}>Abandonner cet extrait</button>
      </div>}
      <h2>Mes extraits validés ({items.length}/20)</h2>
      {items.map((item) => <SavedSample key={item.id} item={item} onDelete={() => setConfirmDelete(item.id)} busy={busy} />)}
      {(!!items.length || !!vocabulary.terms.length || vocabulary.enabled) && <button type="button" disabled={busy} onClick={() => setConfirmDelete("all")}>Supprimer mon profil vocal local</button>}
      {confirmDelete && <div role="group" aria-label="Confirmation de suppression">
        <p>{confirmDelete === "all" ? "Supprimer tous les extraits, transcriptions et expressions, et désactiver le guidage pour votre compte sur cet appareil ?" : "Supprimer cet extrait et sa transcription ?"}</p>
        <button type="button" disabled={busy} onClick={remove}>Confirmer la suppression</button>
        <button type="button" disabled={busy} onClick={() => setConfirmDelete(null)}>Annuler</button>
      </div>}
    </div>
  </section>;
}

function SavedSample({ item, onDelete, busy }) {
  const [url, setUrl] = useState("");
  const player = useRef(null);
  useEffect(() => {
    const audioPlayer = player.current;
    const next = URL.createObjectURL(item.audio);
    setUrl(next);
    return () => { audioPlayer?.pause(); URL.revokeObjectURL(next); };
  }, [item.audio]);
  return <article className="voice-profile-sample">
    <p>{item.text}</p><small>{item.duration.toFixed(1)} s · {Math.ceil(item.audio.size / 1024)} Ko</small>
    <audio ref={player} controls src={url || undefined} aria-label={`Écouter : ${item.text}`} />
    <button type="button" disabled={busy} onClick={onDelete}>Supprimer cet extrait</button>
  </article>;
}
