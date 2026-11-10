import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ClipboardList, ImageIcon } from "lucide-react";
import { v5 as uuidv5 } from "uuid";
import HaccpSignature from "./HaccpSignature";
import { setWordRelayEnabled, wordRelayEnabled } from "./haccpRelevePrinter";
import { API_BASE_URL } from "./lib/api";
import { checkHaccpResponse, haccpFetch } from "./haccpRequest";
import "./HaccpReleves.css";

const ROOT = `${API_BASE_URL}/haccp`;
const PRINT_NAMESPACE = "5a702840-0bb5-4889-89ac-36df7fd5fc33";
const isWaiting = (job) => job && (job.status === "pending" || job.status === "claimed");
const localNow = () => {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
};
const stamp = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("fr-FR", {
    timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short",
  });
};
const newId = () => {
  if (!globalThis.crypto?.randomUUID) throw new Error("Ce navigateur ne permet pas de créer un identifiant unique.");
  return globalThis.crypto.randomUUID();
};

export default function HaccpReleves({ establishmentName = "", kitchenToken = "", onBack, onDirtyChange, onSavingChange }) {
  const [models, setModels] = useState([]);
  const [modelsAttempt, setModelsAttempt] = useState(0);
  const [type, setType] = useState("");
  const [panel, setPanel] = useState("home");
  const [form, setForm] = useState({ operateur: "", champs: {}, signature_image: "" });
  const [captureId, setCaptureId] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [printError, setPrintError] = useState("");
  const [printBusy, setPrintBusy] = useState(false);
  const [record, setRecord] = useState(null);
  const [job, setJob] = useState(null);
  const [records, setRecords] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [photos, setPhotos] = useState([]);
  const [photosTruncated, setPhotosTruncated] = useState(false);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photoTerm, setPhotoTerm] = useState("");
  const [photoQuery, setPhotoQuery] = useState("");
  const [photoSearchVersion, setPhotoSearchVersion] = useState(0);
  const [photoError, setPhotoError] = useState("");
  const [photoSrc, setPhotoSrc] = useState("");
  const [relayEnabled, setRelayEnabled] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const printPending = useRef(false);
  const photoUrl = useRef("");
  const photoRequest = useRef(0);
  const model = useMemo(() => models.find((item) => item.id === type), [models, type]);
  const desktop = Boolean(window.siriusHaccpPrinter);
  const jobId = job?.id;
  const jobStatus = job?.status;

  const call = useCallback((path, body) => {
    const headers = kitchenToken ? { "X-Sirius-Cuisine": kitchenToken } : {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return haccpFetch(`${ROOT}${path}`, {
      headers,
      ...(body !== undefined ? { method: "POST", body: JSON.stringify(body) } : {}),
    }, async (response) => (await checkHaccpResponse(response)).json());
  }, [kitchenToken]);

  const closePhoto = useCallback(() => {
    photoRequest.current += 1;
    if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
    photoUrl.current = "";
    setPhotoSrc("");
  }, []);

  useEffect(() => {
    mounted.current = true;
    setError("");
    call("/releves/modeles").then((response) => {
      if (!Array.isArray(response.modeles) || response.modeles.some((item) => !Array.isArray(item.champs))) {
        throw new Error("La liste des modèles de relevés est invalide.");
      }
      if (mounted.current) {
        setModels(response.modeles);
        setType((old) => old || response.modeles[0]?.id || "");
      }
    }).catch((failure) => {
      if (mounted.current) setError(failure.message || "Chargement des relevés impossible.");
    });
    if (desktop) {
      try { setRelayEnabled(wordRelayEnabled()); }
      catch { setError("Le stockage local du relais Word est inaccessible."); }
    }
    return () => {
      mounted.current = false;
      photoRequest.current += 1;
      if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
    };
  }, [call, desktop, modelsAttempt]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    const warn = (event) => {
      if (dirty) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      onDirtyChange?.(false);
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onSavingChange?.(busy && panel === "form");
    return () => onSavingChange?.(false);
  }, [busy, onSavingChange, panel]);

  useEffect(() => {
    if (panel !== "form" || !model?.champs.some((item) => item.type === "etiquette")) return undefined;
    let active = true;
    const date = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const query = photoQuery ? `terme=${encodeURIComponent(photoQuery)}` : `date_debut=${date}`;
    setPhotos([]);
    setPhotosTruncated(false);
    setPhotoError("");
    setPhotosLoading(true);
    call(`/registre/recherche?${query}`).then((response) => {
      if (!Array.isArray(response)) throw new Error("La liste des étiquettes est invalide.");
      if (active) {
        const available = response.filter((item) => item.type_operation !== "preparation"
          && (!item.restaurant_name || item.restaurant_name === establishmentName));
        setPhotos(available.slice(0, 60));
        setPhotosTruncated(available.length > 60);
      }
    }).catch((failure) => {
      if (active) setPhotoError(failure.message || "Lecture des étiquettes impossible.");
    }).finally(() => {
      if (active) setPhotosLoading(false);
    });
    return () => { active = false; };
  }, [call, establishmentName, model, panel, photoQuery, photoSearchVersion]);

  useEffect(() => {
    if (!jobId || !["pending", "claimed"].includes(jobStatus) || !["saved", "detail"].includes(panel)) return undefined;
    let active = true;
    let timer;
    const poll = async () => {
      try {
        const next = await call(`/releves/impression/${encodeURIComponent(jobId)}`);
        if (!active) return;
        setJob(next);
        if (isWaiting(next)) timer = setTimeout(poll, 3000);
      } catch (failure) {
        if (active) setPrintError(`État de l'impression non confirmé : ${failure.message}`);
      }
    };
    timer = setTimeout(poll, 3000);
    return () => { active = false; clearTimeout(timer); };
  }, [call, jobId, jobStatus, panel]);

  const begin = () => {
    if (!model) { setError("Choisissez un type de relevé."); return; }
    try {
      const identity = newId();
      const champs = Object.fromEntries(model.champs.map((item) => [
        item.key, item.key === "date_heure" ? localNow() : "",
      ]));
      setCaptureId(identity);
      setForm({ operateur: "", champs, signature_image: "" });
      setDirty(false);
      setError("");
      setPrintError("");
      setJob(null);
      setPhotoTerm("");
      setPhotoQuery("");
      setPhotoSearchVersion(0);
      setPanel("form");
    } catch (failure) { setError(failure.message); }
  };
  const change = (key, value) => {
    setForm((old) => ({ ...old, [key]: value }));
    setDirty(true);
  };
  const changeField = (key, value) => {
    setForm((old) => ({ ...old, champs: { ...old.champs, [key]: value } }));
    setDirty(true);
  };
  const leave = () => {
    if (dirty && !window.confirm("Quitter cette saisie sans l'enregistrer ?")) return;
    setDirty(false);
    setError("");
    setPrintError("");
    closePhoto();
    if (panel === "home") onBack?.();
    else setPanel("home");
  };
  const toggleRelay = (event) => {
    try {
      setWordRelayEnabled(event.target.checked);
      setRelayEnabled(event.target.checked);
      setError("");
    } catch {
      setError("Impossible d'enregistrer le réglage du relais Word sur ce PC.");
    }
  };

  const queuePrint = async (item, previous = job) => {
    if (printPending.current || isWaiting(previous)) return;
    if (previous && !window.confirm("Vérifiez la sortie papier. Envoyer une nouvelle impression ?")) return;
    printPending.current = true;
    try {
      const requestId = uuidv5(`${item.id}:${item.created_at}:${previous?.id || "initial"}`, PRINT_NAMESPACE);
      setPrintBusy(true);
      setPrintError("");
      const next = await call(`/releves/${encodeURIComponent(item.id)}/impression`, {
        id: requestId, previous_job_id: previous?.id || null,
      });
      if (!mounted.current) return;
      setJob(next);
      if (next.id !== requestId) setPrintError("Une autre demande existe déjà. Vérifiez son état avant de réimprimer.");
    } catch (failure) {
      if (mounted.current) setPrintError(`Demande d'impression non confirmée : ${failure.message}`);
    } finally {
      printPending.current = false;
      if (mounted.current) setPrintBusy(false);
    }
  };
  const save = async (event) => {
    event.preventDefault();
    const shouldPrint = event.nativeEvent.submitter?.value === "print";
    if (pending.current) return;
    if (!form.signature_image) { setError("Signez avant d'enregistrer le relevé."); return; }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await call("/releves", {
        capture_id: captureId, type_releve: type, etablissement: establishmentName.trim(),
        operateur: form.operateur, champs: form.champs, signature_image: form.signature_image,
      });
      if (!mounted.current) return;
      if (!response.releve?.id) throw new Error("Réponse d'enregistrement invalide. Vérifiez la liste des relevés.");
      setRecord(response.releve);
      setDirty(false);
      setPanel("saved");
      setJob(null);
      closePhoto();
      if (shouldPrint) await queuePrint(response.releve, null);
    } catch (failure) {
      if (mounted.current) setError(failure.message || "Enregistrement impossible ; la saisie est conservée.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const openHistory = async () => {
    setBusy(true); setError("");
    try {
      const response = await call("/releves");
      if (!Array.isArray(response.items)) throw new Error("La liste des relevés est invalide.");
      if (mounted.current) {
        setRecords(response.items);
        setTruncated(response.truncated);
        setPanel("history");
      }
    } catch (failure) {
      if (mounted.current) setError(failure.message || "Lecture des relevés impossible.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const openRecord = async (identity) => {
    setBusy(true); setError(""); setPrintError(""); setPhotoError("");
    try {
      const [detail, latest] = await Promise.all([
        call(`/releves/${encodeURIComponent(identity)}`),
        call(`/releves/${encodeURIComponent(identity)}/impression`),
      ]);
      if (mounted.current) {
        setRecord(detail.releve);
        setJob(latest.job);
        setPanel("detail");
      }
    } catch (failure) {
      if (mounted.current) setError(failure.message || "Lecture du relevé impossible.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const checkPrint = async () => {
    if (!job) return;
    setPrintBusy(true); setPrintError("");
    try {
      const next = await call(`/releves/impression/${encodeURIComponent(job.id)}`);
      if (mounted.current) setJob(next);
    } catch (failure) {
      if (mounted.current) setPrintError(`État de l'impression non confirmé : ${failure.message}`);
    } finally {
      if (mounted.current) setPrintBusy(false);
    }
  };
  const cancelPrint = async () => {
    if (!job || job.status !== "pending" || printBusy) return;
    setPrintBusy(true); setPrintError("");
    try {
      const next = await call(`/releves/impression/${encodeURIComponent(job.id)}/annulation`, {});
      if (mounted.current) setJob(next);
    } catch (failure) {
      if (mounted.current) setPrintError(`Annulation non confirmée : ${failure.message}`);
    } finally {
      if (mounted.current) setPrintBusy(false);
    }
  };
  const showPhoto = async (identity) => {
    if (!identity) return;
    closePhoto();
    setPhotoError("");
    const sequence = ++photoRequest.current;
    try {
      const headers = kitchenToken ? { "X-Sirius-Cuisine": kitchenToken } : {};
      const blob = await haccpFetch(`${ROOT}/registre/${encodeURIComponent(identity)}/photo`, { headers }, async (response) => {
        await checkHaccpResponse(response);
        if (!response.headers.get("content-type")?.startsWith("image/")) throw new Error("Photo introuvable.");
        return response.blob();
      });
      if (!mounted.current || sequence !== photoRequest.current) return;
      photoUrl.current = URL.createObjectURL(blob);
      setPhotoSrc(photoUrl.current);
    } catch (failure) {
      if (mounted.current && sequence === photoRequest.current) setPhotoError(failure.message || "Photo introuvable.");
    }
  };

  return <section className="haccp-releves" aria-label="Relevés HACCP">
    <button type="button" className="haccp-releve-back" disabled={busy || printBusy} onClick={leave}>
      <ArrowLeft size={24} aria-hidden="true" />{panel === "home" ? "PHOTO" : "RELEVÉS"}
    </button>
    <h2><ClipboardList size={25} aria-hidden="true" /> Relevés et nettoyage</h2>
    {error && panel !== "form" && <div role="alert" className="haccp-releve-error">{error}
      {panel === "home" && !models.length && <button type="button" onClick={() => setModelsAttempt((value) => value + 1)}>Réessayer</button>}
    </div>}
    {panel === "home" && <>
      <label>Type de relevé
        <select value={type} onChange={(event) => setType(event.target.value)} disabled={!models.length || busy}>
          {models.map((item) => <option key={item.id} value={item.id}>{item.titre}</option>)}
        </select>
      </label>
      <div className="haccp-releve-actions">
        <button type="button" disabled={!models.length || busy} onClick={begin}>Nouveau relevé</button>
        <button type="button" disabled={busy} onClick={openHistory}>Voir les relevés</button>
      </div>
      {desktop && <details>
        <summary>Impression des documents Word</summary>
        <label className="haccp-releve-check">
          <input type="checkbox" checked={relayEnabled} onChange={toggleRelay} />
          Autoriser ce PC à imprimer les relevés
        </label>
        <p>Gardez ΣIRIUS ouvert et relié au même compte. Les documents sont envoyés à l'imprimante Windows par défaut.</p>
      </details>}
    </>}
    {panel === "form" && model && <form onSubmit={save} className="haccp-releve-form">
      <h3>{model.titre}</h3>
      <p>Établissement : {establishmentName || "non choisi"}</p>
      <label>Nom de l'opérateur *
        <input required maxLength={160} value={form.operateur} onChange={(event) => change("operateur", event.target.value)} />
      </label>
      {model.champs.map((item) => <div key={item.key} className="haccp-releve-field">
        <label>{item.label}{item.required ? " *" : ""}
        {item.type === "select" ? <select required={item.required} value={form.champs[item.key]}
          onChange={(event) => changeField(item.key, event.target.value)}>
          <option value="">Choisir</option>
          {item.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select> : item.type === "etiquette" ? <select required={item.required} value={form.champs[item.key]}
          onChange={(event) => { closePhoto(); changeField(item.key, event.target.value); }}>
          <option value="">Choisir une photo enregistrée</option>
          {photos.map((photo) => <option key={photo.id} value={photo.id}>{photo.nom_produit} · lot {photo.numero_lot}</option>)}
        </select> : <input type={item.type === "number" ? "text" : item.type} inputMode={item.type === "number" ? "decimal" : undefined}
          required={item.required} maxLength={500} value={form.champs[item.key]}
          onChange={(event) => changeField(item.key, event.target.value)} />}
        </label>
        {item.type === "etiquette" && <>
          <small>{photoQuery ? "Résultats de la recherche." : "Photos des 30 derniers jours. Recherchez aussi les photos plus anciennes."}</small>
          <span className="haccp-releve-photo-search">
            <input aria-label="Rechercher une photo par produit ou lot" value={photoTerm}
              onChange={(event) => setPhotoTerm(event.target.value)} />
            <button type="button" disabled={!photoTerm.trim()} onClick={() => {
              closePhoto();
              changeField(item.key, "");
              setPhotoQuery(photoTerm.trim());
              setPhotoSearchVersion((value) => value + 1);
            }}>Rechercher</button>
          </span>
          {photosTruncated && <small>60 photos affichées. Précisez le produit ou le lot pour affiner la recherche.</small>}
          {photosLoading && <small role="status">Chargement des photos…</small>}
          {!photosLoading && !photoError && !photos.length && <small>Aucune photo trouvée. Photographiez l'étiquette ou essayez une autre recherche.</small>}
          {photoError && <div role="alert">{photoError} <button type="button" onClick={() => setPhotoSearchVersion((value) => value + 1)}>Réessayer les photos</button></div>}
          {form.champs[item.key] && <button type="button" onClick={() => showPhoto(form.champs[item.key])}>
            <ImageIcon size={18} aria-hidden="true" /> Voir la photo
          </button>}
          {photoSrc && <div className="haccp-releve-photo">
            <button type="button" onClick={closePhoto}>Fermer la photo</button>
            <img src={photoSrc} alt="Étiquette archivée" />
          </div>}
        </>}
      </div>)}
      <HaccpSignature onChange={(value) => change("signature_image", value)} />
      {error && <div role="alert" className="haccp-releve-error">{error}</div>}
      <div className="haccp-releve-actions">
        <button type="submit" disabled={busy || !establishmentName.trim()}>Enregistrer</button>
        <button type="submit" value="print" disabled={busy || !establishmentName.trim()}>Enregistrer et imprimer</button>
      </div>
      {!establishmentName.trim() && <p role="alert">Choisissez d'abord l'établissement.</p>}
      {busy && <p role="status">Enregistrement en cours, veuillez patienter.</p>}
    </form>}
    {panel === "history" && <>
      {truncated && <p>Les 100 relevés les plus récents sont affichés.</p>}
      {!records.length && <p>Aucun relevé enregistré.</p>}
      <ul className="haccp-releve-list">{records.map((item) => <li key={item.id}>
        <button type="button" disabled={busy} onClick={() => openRecord(item.id)}>
          <strong>{item.titre}</strong><small>{stamp(item.created_at)} · {item.operateur}</small>
        </button>
      </li>)}</ul>
    </>}
    {["saved", "detail"].includes(panel) && record && <>
      {panel === "saved" && <p className="haccp-releve-saved" role="status">Relevé enregistré.</p>}
      <h3>{record.titre}</h3>
      <p>{stamp(record.created_at)} · {record.operateur}</p>
      {panel === "detail" && <>
        <dl>{record.colonnes.map((label, index) => record.lignes[0][index] && <div key={`${label}-${index}`}>
          <dt>{label}</dt><dd>{record.lignes[0][index]}</dd>
        </div>)}</dl>
        {record.signature_image && <img className="haccp-releve-signature-image" src={record.signature_image} alt={`Signature manuscrite de ${record.operateur}`} />}
        {record.champs?.etiquette_id && <button type="button" onClick={() => showPhoto(record.champs.etiquette_id)}>Voir la photo de l'étiquette</button>}
        {photoError && <p role="alert">{photoError}</p>}
        {photoSrc && <div className="haccp-releve-photo">
          <button type="button" onClick={closePhoto}>Fermer la photo</button><img src={photoSrc} alt="Étiquette archivée" />
        </div>}
      </>}
      <p>Impression sur le PC Windows relié au même compte et sur son imprimante par défaut.</p>
      {job && <p role="status">{
        job.detail || (job.status === "pending" ? "En attente du PC Windows." : "Pris en charge par le PC.")
      }</p>}
      {printError && <p role="alert" className="haccp-releve-error">{printError}</p>}
      <div className="haccp-releve-actions">
        {isWaiting(job) ? <button type="button" disabled={printBusy} onClick={checkPrint}>Vérifier l'état</button>
          : <button type="button" disabled={printBusy} onClick={() => queuePrint(record)}>
            {job ? "Nouvelle impression" : "Imprimer depuis le PC"}
          </button>}
        {job?.status === "pending" && <button type="button" disabled={printBusy} onClick={cancelPrint}>Annuler la demande</button>}
        <button type="button" disabled={printBusy} onClick={() => { setPanel("home"); setPrintError(""); closePhoto(); }}>Terminer</button>
      </div>
    </>}
  </section>;
}
