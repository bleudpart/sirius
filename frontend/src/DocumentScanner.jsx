import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { API_BASE_URL } from "./lib/api";
import { buildReceiptDraft, fiscalIdentifierWarnings, readDocumentLocally, scanMoney, SCAN_FIELDS } from "./documentScan";
import "./DocumentScanner.css";

async function responseData(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Erreur HTTP ${response.status}`);
  return data;
}

export default function DocumentScanner({ initialDossier, initialFolder = "Comptabilité", onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [camera, setCamera] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [kind, setKind] = useState("document");
  const [folder, setFolder] = useState(initialDossier?.title || initialFolder);
  const [dossierId, setDossierId] = useState(initialDossier?.id || "");
  const [dossiers, setDossiers] = useState(initialDossier ? [initialDossier] : []);
  const [fields, setFields] = useState({ ...SCAN_FIELDS });
  const [text, setText] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [identifiersChecked, setIdentifiersChecked] = useState(false);
  const [seller, setSeller] = useState("");
  const [customer, setCustomer] = useState("");
  const [draft, setDraft] = useState("");
  const [template, setTemplate] = useState("professionnel");
  const [description, setDescription] = useState("");
  const video = useRef(null);
  const nativeCapture = useRef(null);
  const stream = useRef(null);
  const readController = useRef(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const cancelRead = useRef(false);
  const identifierWarnings = fiscalIdentifierWarnings(fields.fiscal_identifiers);
  const identifiersNeedReview = identifierWarnings.length > 0 && !identifiersChecked;

  const stopCamera = () => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setCamera(false);
    setCameraReady(false);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelRead.current = true;
      stream.current?.getTracks().forEach((track) => track.stop());
      readController.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!file) { setPreview(""); return undefined; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    if (initialDossier) return undefined;
    let active = true;
    fetch(`${API_BASE_URL}/work-dossiers`).then(responseData)
      .then((data) => { if (active) setDossiers(data.dossiers); })
      .catch((cause) => { if (active) setError(`Chargement des dossiers : ${cause.message}`); });
    return () => { active = false; };
  }, [initialDossier]);
  useEffect(() => {
    if (camera && video.current && stream.current) {
      video.current.srcObject = stream.current;
      video.current.play().catch((cause) => setError(`Aperçu caméra indisponible : ${cause.message}`));
    }
  }, [camera]);

  const chooseFile = (selected) => {
    if (!selected) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(selected.type) || !selected.size || selected.size > 20 * 1048576) {
      setError("Choisissez une image JPEG, PNG ou WebP de 20 Mo maximum.");
      return;
    }
    setFile(selected);
    setFields({ ...SCAN_FIELDS });
    setText("");
    setDraft("");
    setDescription("");
    setReviewed(false);
    setIdentifiersChecked(false);
    setError("");
  };
  const openCamera = async () => {
    if (Capacitor.isNativePlatform()) { nativeCapture.current.click(); return; }
    if (lock.current || stream.current) return;
    lock.current = true;
    setBusy("camera");
    setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Caméra indisponible. Choisissez une image à la place.");
      const capture = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      if (!alive.current) { capture.getTracks().forEach((track) => track.stop()); return; }
      stream.current = capture;
      setCamera(true);
    } catch (cause) {
      if (alive.current) setError(`Impossible d'ouvrir la caméra : ${cause.message}`);
    } finally {
      lock.current = false;
      if (alive.current) setBusy("");
    }
  };
  const photograph = () => {
    const source = video.current;
    if (!source?.videoWidth || !source.videoHeight) { setError("La caméra n'est pas encore prête."); return; }
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 2000 / Math.max(source.videoWidth, source.videoHeight));
    canvas.width = Math.round(source.videoWidth * scale);
    canvas.height = Math.round(source.videoHeight * scale);
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!alive.current) return;
      if (!blob) { setError("La capture de la photo a échoué."); return; }
      chooseFile(new File([blob], "document-scane.jpg", { type: "image/jpeg" }));
      stopCamera();
    }, "image/jpeg", 0.92);
  };
  const read = async () => {
    if (!file || lock.current) return;
    lock.current = true;
    cancelRead.current = false;
    readController.current = new AbortController();
    setBusy("ocr"); setError(""); setReviewed(false);
    setIdentifiersChecked(false);
    try {
      const result = await readDocumentLocally(file,
        (message) => { if (alive.current && !cancelRead.current) setProgress(message); },
        { signal: readController.current.signal });
      if (alive.current && !cancelRead.current) {
        setText(result.text); setFields(result.fields); setDescription(result.text.slice(0, 10000)); setDraft("");
      }
    } catch (cause) {
      if (alive.current && !cancelRead.current) setError(`Lecture impossible : ${cause.message}. Vous pouvez saisir les champs manuellement et conserver la photo.`);
    } finally {
      lock.current = false;
      if (alive.current) { setBusy(""); setProgress(""); }
    }
  };
  const update = (key, value) => {
    setFields((current) => ({ ...current, [key]: value }));
    setReviewed(false); setDraft("");
    if (key === "fiscal_identifiers") setIdentifiersChecked(false);
  };
  const save = async (event) => {
    event.preventDefault();
    if (lock.current || !file) return;
    if (!folder.trim()) { setError("Choisissez le dossier de destination."); return; }
    for (const name of ["total_ttc", "tva"]) {
      if (fields[name] && scanMoney(fields[name]) === null) { setError("Les montants doivent être positifs avec deux décimales maximum."); return; }
    }
    if (kind !== "document" && !reviewed) { setError("Relisez et validez les informations comptables."); return; }
    if (kind !== "document" && identifiersNeedReview) { setError("Comparez les identifiants fiscaux avec la photo et confirmez leur vérification."); return; }
    lock.current = true; setBusy("save"); setError("");
    try {
      const metadata = {
        dossier: folder.trim(), work_dossier_id: dossierId || null, kind,
        accounting: kind === "document" ? null : {
          ...fields, date: fields.date || null, supplier: fields.supplier.trim(),
          total_ttc: fields.total_ttc ? scanMoney(fields.total_ttc) : null,
          tva: fields.tva ? scanMoney(fields.tva) : null,
        },
        reviewed: kind === "document" || reviewed,
        text: text.slice(0, 30000), draft: draft.slice(0, 30000),
        presentation: kind === "document" ? null : { template, seller, customer, description },
      };
      const form = new FormData();
      form.append("file", file);
      form.append("metadata", JSON.stringify(metadata));
      const result = await fetch(`${API_BASE_URL}/document-scans`, { method: "POST", body: form }).then(responseData);
      window.dispatchEvent(new Event("sirius-files-updated"));
      onSaved(result);
    } catch (cause) {
      if (alive.current) setError(`Enregistrement impossible : ${cause.message}`);
    } finally {
      lock.current = false;
      if (alive.current) setBusy("");
    }
  };

  return createPortal(<section className="document-scanner" role="dialog" aria-modal="true" aria-labelledby="document-scanner-title">
    <form className="document-scanner-card" onSubmit={save}>
      <header><h2 id="document-scanner-title">Scanner un document</h2>
        <button type="button" disabled={busy === "save"} onClick={onClose} aria-label="Fermer le scanner">×</button>
      </header>
      <p>Photo, relecture, puis classement. La lecture du texte se fait sur cet appareil, sans envoi à un service IA.</p>
      <fieldset disabled={!!busy}>
        <div className="document-scanner-actions">
          <button type="button" onClick={openCamera}>Ouvrir la caméra</button>
          <label className="document-scanner-file">Choisir une image<input type="file" accept="image/jpeg,image/png,image/webp"
            onChange={(event) => { chooseFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
          <input ref={nativeCapture} hidden type="file" accept="image/jpeg,image/png,image/webp" capture="environment"
            onChange={(event) => { chooseFile(event.target.files?.[0]); event.target.value = ""; }} />
        </div>
        {camera && <div className="document-scanner-preview">
          <video ref={video} autoPlay playsInline muted onLoadedData={() => setCameraReady(true)} />
          <button type="button" onClick={photograph} disabled={!cameraReady}>Prendre la photo</button>
          <button type="button" onClick={stopCamera}>Fermer la caméra</button>
        </div>}
        {preview && <div className="document-scanner-preview"><img src={preview} alt="Document à vérifier avant classement" />
          <p>{file.name} · Vérifiez le cadrage et la lisibilité.</p></div>}
        <label>Destination<select value={dossierId} onChange={(event) => {
          setDossierId(event.target.value);
          const chosen = dossiers.find((item) => item.id === event.target.value);
          setFolder(chosen?.title || "Comptabilité");
        }}><option value="">Dossier de la médiathèque</option>
          {dossiers.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></label>
        {!dossierId && <label>Nom du dossier<input required maxLength={120} value={folder}
          onChange={(event) => setFolder(event.target.value)} placeholder="Factures, Tickets, Client…" /></label>}
        <label>Document<select value={kind} onChange={(event) => { setKind(event.target.value); setReviewed(false); setDraft(""); }}>
          <option value="document">Document à classer</option><option value="purchase">Achat · facture ou ticket fournisseur</option>
          <option value="sale">Vente · mon ticket de caisse</option>
        </select></label>
        {file && <button type="button" onClick={read}>Lire le document</button>}
        {kind !== "document" && <>
          <p>Les champs sont des propositions à vérifier. Une case vide signifie « non identifié », jamais zéro.</p>
          <div className="document-scanner-fields">
            <label>{kind === "sale" ? "Commerce figurant sur le ticket" : "Fournisseur"}<input maxLength={160} value={fields.supplier} onChange={(event) => update("supplier", event.target.value)} /></label>
            <label>Date du ticket<input type="date" value={fields.date} onChange={(event) => update("date", event.target.value)} /></label>
            <label>Total TTC<input inputMode="decimal" value={fields.total_ttc} onChange={(event) => update("total_ttc", event.target.value)} /></label>
            <label>Montant TVA (pas le taux)<input inputMode="decimal" value={fields.tva} onChange={(event) => update("tva", event.target.value)} /></label>
            <label>Devise<select value={fields.currency} onChange={(event) => update("currency", event.target.value)}><option>EUR</option><option>CHF</option><option>USD</option><option>GBP</option></select></label>
          </div>
          <label>Référence du ticket / facture d'origine<input maxLength={120} value={fields.ticket_number} onChange={(event) => update("ticket_number", event.target.value)} /></label>
          <label>Identifiants fiscaux · reproduire ceux du justificatif<textarea maxLength={2000} value={fields.fiscal_identifiers} onChange={(event) => update("fiscal_identifiers", event.target.value)} placeholder="SIRET, SIREN, numéro de TVA, NIF…" /></label>
          {identifierWarnings.length > 0 && <div role="alert">
            {identifierWarnings.map((warning, index) => <p key={index}>{warning}</p>)}
            <label><input type="checkbox" checked={identifiersChecked} onChange={(event) => {
              setIdentifiersChecked(event.target.checked); setReviewed(false); setDraft("");
            }} /> J'ai comparé ces identifiants avec la photo et corrigé les erreurs de lecture éventuelles.</label>
          </div>}
          <label>Modèle papier A4<select value={template} onChange={(event) => setTemplate(event.target.value)}>
            <option value="professionnel">Professionnel · bleu nuit et or</option>
            <option value="classique">Classique · noir et blanc</option>
          </select></label>
          <label>Description / articles à présenter<textarea maxLength={10000} value={description}
            onChange={(event) => { setDescription(event.target.value); setReviewed(false); setDraft(""); }} /></label>
          {kind === "sale" && <>
            <label>Mes coordonnées de vendeur<textarea value={seller} maxLength={2000} onChange={(event) => { setSeller(event.target.value); setDraft(""); }} placeholder="Raison sociale, adresse, identifiant légal…" /></label>
            <label>Coordonnées du client<textarea value={customer} maxLength={2000} onChange={(event) => { setCustomer(event.target.value); setDraft(""); }} /></label>
          </>}
          <label><input type="checkbox" checked={reviewed} disabled={identifiersNeedReview} onChange={(event) => setReviewed(event.target.checked)} /> J'ai relu les champs et laissé vides les informations non identifiées.</label>
          <button type="button" disabled={!reviewed || !file || identifiersNeedReview} onClick={() => setDraft(buildReceiptDraft({ kind, fields, seller, customer, description }))}>
            {kind === "sale" ? "Préparer le brouillon de facture" : "Préparer la fiche de dépense"}
          </button>
        </>}
        {text && <details><summary>Texte lu · à corriger si nécessaire</summary>
          <textarea aria-label="Texte du document" value={text} onChange={(event) => { setText(event.target.value); setDraft(""); setReviewed(false); }} maxLength={30000} /></details>}
        {draft && <label>Brouillon modifiable · conservé avec le justificatif<textarea className="document-scanner-draft" value={draft} maxLength={30000} onChange={(event) => setDraft(event.target.value)} /></label>}
        <button type="submit" className="document-scanner-save" disabled={!file || (kind !== "document" && (!reviewed || identifiersNeedReview))}>
          Enregistrer dans « {folder || "le dossier choisi"} »
        </button>
        {kind !== "document" && <p>Après enregistrement, le PDF A4 sera disponible dans le dossier. Une vente reste un brouillon non émis.</p>}
      </fieldset>
      {busy && <p role="status">{busy === "ocr" ? progress || "Lecture locale en cours…" : busy === "save" ? "Enregistrement du document…" : "Ouverture de la caméra…"}</p>}
      {busy === "ocr" && <button type="button" onClick={() => {
        cancelRead.current = true;
        setProgress("Lecture annulée. Arrêt du lecteur…");
        readController.current?.abort();
      }}>Annuler la lecture</button>}
      {error && <p role="alert">{error}</p>}
    </form>
  </section>, document.body);
}
