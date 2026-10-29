import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, PackageCheck, Scissors, Printer, RotateCcw, ScanLine, LoaderCircle } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Camera as NativeCamera, CameraDirection, CameraResultType, CameraSource } from "@capacitor/camera";
import { API_BASE_URL } from "./lib/api";
import { printHaccpDocument } from "./haccpDocuments";
import HaccpPrinter, { haccpPrintRequest, haccpPrintStatus, printHaccpOpening } from "./HaccpPrinter";
import { haccpFetch } from "./haccpRequest";
import "./HaccpWorkspace.css";

const API = `${API_BASE_URL}/haccp`;
const displayTime = (value) => value ? new Date(value).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : "Non calculée";

async function checkResponse(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.detail === "string" ? body.detail
      : `Opération refusée (${response.status}). Vérifiez la saisie et votre connexion.`);
  }
  return response;
}

export default function HaccpLabelCapture({ savedRecord = null }) {
  const [mode, setMode] = useState("reception");
  const [operator, setOperator] = useState("Cuisine");
  const [file, setFile] = useState(null);
  const [hours, setHours] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [hasRule, setHasRule] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(savedRecord);
  const [error, setError] = useState("");
  const [printState, setPrintState] = useState("");
  const [preview, setPreview] = useState(null);
  const captureId = useRef(null);
  const submitted = useRef(null);
  const previewRef = useRef(null);
  const frame = useRef(null);
  const input = useRef(null);
  const pending = useRef(false);
  const takingPhoto = useRef(false);
  const mounted = useRef(true);
  const clearPrintFrame = useCallback(() => {
    frame.current?.remove();
    frame.current = null;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; clearPrintFrame();
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, [clearPrintFrame]);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined;
    let active = true;
    const listener = App.addListener("appRestoredResult", (event) => {
      if (active && event.pluginId === "Camera") {
        setError("La capture a été interrompue par le redémarrage de l’application. Aucune photo restaurée n’a été envoyée : vérifiez le registre et reprenez le scan avec les bons paramètres.");
      }
    });
    listener.catch((failure) => {
      if (active) setError(`Suivi du retour caméra indisponible : ${failure.message}`);
    });
    return () => {
      active = false;
      listener.then((handle) => handle.remove()).catch((failure) => {
        console.error("HACCP : fermeture du suivi caméra impossible.", failure);
      });
    };
  }, []);

  const changeMode = (next) => {
    setMode(next); setConfirmed(false); setResult(null); setError(""); setPrintState("");
  };
  const save = async (event, selectedFile = file) => {
    event?.preventDefault();
    if (pending.current) return;
    setError(""); setResult(null); setPrintState("");
    if (!selectedFile || !operator.trim()) {
      setError("Choisissez une photo et indiquez l’opérateur.");
      return;
    }
    if (mode === "ouverture" && hasRule && (!confirmed || !reason.trim() || !Number.isSafeInteger(Number(hours)) || Number(hours) <= 0)) {
      setError("Renseignez une durée en heures entières, sa justification et confirmez la règle.");
      return;
    }
    const operation = { type_operation: mode };
    if (mode === "ouverture" && hasRule) {
      Object.assign(operation, {
        duree_conservation_heures: Number(hours),
        justification_duree: reason.trim(), regle_confirmee: confirmed,
      });
    }
    const body = new FormData();
    body.append("file", selectedFile);
    body.append("operateur", operator.trim());
    body.append("operation", JSON.stringify(operation));
    const snapshot = JSON.stringify({ operation, operateur: operator.trim() });
    if (submitted.current && submitted.current !== snapshot) {
      setError("Une tentative existe pour cette photo. Rétablissez les mêmes paramètres pour vérifier son résultat, ou reprenez une photo pour une nouvelle fiche.");
      return;
    }
    if (!captureId.current) captureId.current = crypto.randomUUID();
    submitted.current = snapshot;
    body.append("capture_id", captureId.current);
    pending.current = true; setBusy(true);
    try {
      const record = await haccpFetch(`${API}/etiquettes/scan`, {
        method: "POST", credentials: "include", body,
      }, async (response) => (await checkResponse(response)).json());
      if (mounted.current) {
        setResult(record); setFile(null); setConfirmed(false);
        if (input.current) input.current.value = "";
      }
    } catch (failure) {
      if (mounted.current) setError(`${failure.message} Si la connexion a été coupée, vérifiez le registre avant de renvoyer la photo.`);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const selectPhoto = (selected) => {
    if (!selected || !mounted.current) return;
    setFile(selected); setResult(null); setPrintState("");
    captureId.current = null; submitted.current = null;
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = URL.createObjectURL(selected);
    setPreview(previewRef.current);
    return save(null, selected);
  };
  const scan = async () => {
    if (pending.current || takingPhoto.current) return;
    if (!Capacitor.isNativePlatform()) {
      input.current?.click();
      return;
    }
    takingPhoto.current = true;
    setBusy(true); setError("");
    try {
      const photo = await NativeCamera.getPhoto({
        source: CameraSource.Camera,
        resultType: CameraResultType.Uri,
        direction: CameraDirection.Rear,
        quality: 90,
        width: 2400,
        height: 2400,
        correctOrientation: true,
        allowEditing: false,
        saveToGallery: false,
      });
      if (!mounted.current) return;
      if (!photo.webPath) throw new Error("La caméra n’a pas retourné de photo lisible.");
      const response = await fetch(photo.webPath);
      if (!response.ok) throw new Error("La photo prise ne peut pas être lue.");
      const blob = await response.blob();
      if (!blob.size || blob.size > 20 * 1024 * 1024) throw new Error("Photo vide ou supérieure à 20 Mo : reprenez le scan.");
      if (!["jpeg", "png", "webp"].includes(photo.format)) throw new Error("Format de photo non pris en charge.");
      await selectPhoto(new File([blob], `etiquette.${photo.format}`, { type: `image/${photo.format}` }));
    } catch (failure) {
      const cancelled = failure.message === "User cancelled photos app"
        || ["OS-PLUG-CAMR-0006", "OS-PLUG-CAMR-0013"].includes(failure.code);
      if (mounted.current && !cancelled) {
        setError(`Appareil photo indisponible : ${failure.message || "vérifiez les autorisations caméra dans les paramètres."}`);
      }
    } finally {
      takingPhoto.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const print = async () => {
    if (!result || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const html = await haccpFetch(`${API}/registre/${result.id}/etiquette`, {},
        async (response) => (await checkResponse(response)).text());
      if (mounted.current) printHaccpDocument(html, frame, setError);
    } catch (failure) {
      if (mounted.current) setError(failure.message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const queuePrint = async () => {
    if (!result || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const job = await printHaccpOpening(result.id);
      setPrintState(`${haccpPrintStatus(job.status, job.transport)}. ${job.detail || ""} Aucun doublon ne sera envoyé automatiquement.`);
    } catch (failure) {
      setError(failure.message);
      setPrintState("Demande non confirmée. Consultez l’état et vérifiez le papier avant toute autre impression.");
    }
    finally { pending.current = false; setBusy(false); }
  };
  const checkPrintState = async () => {
    setError("");
    try {
      const state = await haccpPrintRequest("/etat");
      const job = state.jobs.find((item) => item.label_id === result.id);
      setPrintState(job ? `${haccpPrintStatus(job.status, job.transport)}. ${job.detail || ""}`
        : "Aucune demande trouvée pour cette ouverture.");
    } catch (failure) { setError(failure.message); }
  };

  return (
    <section aria-label="Capture des étiquettes ΣIRIUS" className="haccp-ui workspace-surface haccp-card haccp-capture">
      <p className="haccp-kicker">{savedRecord ? "Preuve archivée" : "Capture intelligente"}</p>
      <h3>ΣIRIUS · {savedRecord ? "Vérifier l’étiquette archivée" : "Scanner une étiquette"}</h3>
      {!savedRecord && <ol className="haccp-steps" aria-label="Étapes de capture"><li><span>1</span>Choisir l’action</li><li><span>2</span>Photographier</li><li><span>3</span>Vérifier et imprimer</li></ol>}
      {!savedRecord && !result && <form onSubmit={save}>
        <fieldset disabled={busy} className="haccp-capture-fields">
          <legend>Action</legend>
          <div className="haccp-modes" role="group" aria-label="Type d’opération">
            <button type="button" aria-pressed={mode === "reception"} onClick={() => changeMode("reception")}><PackageCheck size={20} aria-hidden="true" />Réception</button>
            <button type="button" aria-pressed={mode === "ouverture"} onClick={() => changeMode("ouverture")}><Scissors size={20} aria-hidden="true" />Ouverture produit</button>
          </div>
          <label>Opérateur
            <input value={operator} maxLength={100} required onChange={(e) => setOperator(e.target.value)} />
          </label>
          {mode === "ouverture" && <>
            <p>L’heure d’ouverture enregistrée sera celle du serveur à l’envoi. Scanner immédiatement après l’ouverture ; aucune durée J+3 n’est présumée.</p>
            <label className="haccp-check"><input type="checkbox" checked={hasRule} onChange={(e) => { setHasRule(e.target.checked); setConfirmed(false); }} /> Appliquer une durée fabricant/PMS validée pour ce produit et ses conditions de stockage</label>
            {hasRule ? <>
              <label>Durée après ouverture (heures entières)
                <input type="number" min="1" step="1" value={hours} required onChange={(e) => { setHours(e.target.value); setConfirmed(false); }} />
              </label>
              <label>Justification : indication fabricant ou référence PMS
                <textarea value={reason} maxLength={500} required onChange={(e) => { setReason(e.target.value); setConfirmed(false); }} />
              </label>
              <label className="haccp-check"><input type="checkbox" checked={confirmed} required onChange={(e) => setConfirmed(e.target.checked)} /> Je confirme cette durée et ses conditions pour le produit photographié.</label>
            </> : <p role="status">Sans règle confirmée : ouverture archivée avec alerte, sans DLC secondaire ni étiquette d’utilisation.</p>}
          </>}
          <input ref={input} type="file" style={{ display: "none" }} accept="image/jpeg,image/png,image/webp" capture="environment" aria-label="Photo de l’étiquette" onChange={(e) => {
            const selected = e.target.files?.[0] || null;
            selectPhoto(selected);
          }} />
          <button type="button" className="haccp-scan haccp-primary" aria-busy={busy} disabled={busy || !operator.trim() || (mode === "ouverture" && hasRule && (!confirmed || !reason.trim() || !Number.isSafeInteger(Number(hours)) || Number(hours) <= 0))} onClick={scan}>
            {busy ? <LoaderCircle className="haccp-loading" size={30} aria-hidden="true" /> : <Camera size={30} aria-hidden="true" />}
            <span>{busy ? "Analyse et archivage…" : "Scanner étiquette"}</span>
            <ScanLine size={22} aria-hidden="true" />
          </button>
          <p className="haccp-camera-hint">Photographiez une étiquette nette et complète. L’analyse démarre dès le choix de la photo.</p>
          {file && error && <button type="submit"><RotateCcw size={18} aria-hidden="true" />Réessayer la même photo sans doublon</button>}
        </fieldset>
      </form>}
      <p className="haccp-notice">Analyse OpenAI, archivage sur le serveur. Aucun contrôle physique ou de température n’est certifié.</p>
      {!savedRecord && !result && <details><summary>Configurer l’imprimante (une seule fois)</summary><HaccpPrinter /></details>}
      {preview && <img src={preview} alt="Photo originale à relire avant validation" style={{ maxWidth: "100%", maxHeight: 500, objectFit: "contain" }} />}
      {error && <p role="alert">{error}</p>}
      {result && <div className={`haccp-result ${result.conforme_reception ? "" : "haccp-result-warning"}`} role="status">
        <h4>{result.conforme_reception ? "Aucune anomalie détectée sur l’étiquette — à vérifier" : "Vérification requise — ne pas valider l’utilisation"}</h4>
        <p>{result.nom_produit} · Lot {result.numero_lot} · {result.type_date} : {result.dlc_ou_ddm || "Illisible ou absente"}</p>
        <p>Catégorie : {result.categorie || "Non classé"} · Température réelle : non vérifiée par le scan.</p>
        {result.chemin_photo && result.chemin_donnees && <details>
          <summary>Photo et métadonnées archivées — voir les emplacements</summary>
          <p>Emplacements sur le serveur du registre, pas sur le téléphone :</p>
          <p style={{ overflowWrap: "anywhere" }}>Photo : <code>{result.chemin_photo}</code></p>
          <p style={{ overflowWrap: "anywhere" }}>Données SQLite : <code>{result.chemin_donnees}</code></p>
          {result.date_reception && <p>Réception enregistrée : {displayTime(result.date_reception)} (Europe/Paris)</p>}
        </details>}
        {result.commentaire_anomalie && <p>{result.commentaire_anomalie}</p>}
        {result.type_operation === "ouverture" && <>
          <p>Ouverture : {displayTime(result.date_ouverture)} · DLC secondaire : {displayTime(result.dlc_secondaire)} (Europe/Paris)</p>
          <p>Durée déclarée : {result.duree_conservation_heures ?? "Non renseignée"} h · Référence : {result.justification_duree || "Aucune"}</p>
          {result.dlc_secondaire && result.conforme_reception && <>
            <p>Vérifiez la photo, le produit, le lot et les dates avant de valider.</p>
            <button className="haccp-primary" disabled={busy || !!printState} onClick={queuePrint}><Printer size={20} aria-hidden="true" />J’ai vérifié : valider et imprimer</button>
            {printState && <button disabled={busy} onClick={checkPrintState}>Voir l’état d’impression</button>}
            <details><summary>Secours manuel (risque de doublon)</summary><p>Uniquement si aucune demande n’a été envoyée au relais. Vérifiez le registre et le papier avant toute impression manuelle.</p><button disabled={busy || !!printState} onClick={print}>Imprimer l’étiquette d’ouverture manuellement</button></details>
          </>}
          {printState && <p role="status">{printState}</p>}
        </>}
      </div>}
      {result && !savedRecord && <button type="button" disabled={busy} onClick={() => {
        setResult(null); setError(""); setPrintState(""); setConfirmed(false); setFile(null);
        captureId.current = null; submitted.current = null;
        if (previewRef.current) URL.revokeObjectURL(previewRef.current);
        previewRef.current = null; setPreview(null);
      }}><Camera size={20} aria-hidden="true" />Scanner une autre étiquette</button>}
    </section>
  );
}
