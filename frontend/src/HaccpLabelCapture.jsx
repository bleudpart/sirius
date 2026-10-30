import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, PackageCheck, Scissors, Printer, RotateCcw, ScanLine, LoaderCircle } from "lucide-react";
import { API_BASE_URL } from "./lib/api";
import { printHaccpDocument } from "./haccpDocuments";
import HaccpPrinter, { haccpPrintRequest, haccpPrintStatus, printHaccpOpening } from "./HaccpPrinter";
import { haccpFetch } from "./haccpRequest";
import "./HaccpWorkspace.css";

const API = `${API_BASE_URL}/haccp`;
const displayTime = (value) => value ? new Date(value).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : "Non calculée";
const noop = () => Promise.resolve();

async function checkResponse(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.detail === "string" ? body.detail
      : `Opération refusée (${response.status}). Vérifiez la saisie et votre connexion.`);
  }
  return response;
}

export default function HaccpLabelCapture({
  savedRecord = null,
  kitchenMode = false,
  establishmentName = "Restaurant",
  sessionReady = true,
  onCaptureSaved = noop,
}) {
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
  const [printSuccess, setPrintSuccess] = useState(false);
  const [preview, setPreview] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const captureId = useRef(null);
  const submitted = useRef(null);
  const previewRef = useRef(null);
  const frame = useRef(null);
  const video = useRef(null);
  const canvas = useRef(null);
  const stream = useRef(null);
  const pending = useRef(false);
  const takingPhoto = useRef(false);
  const mounted = useRef(true);
  const resetTimer = useRef(null);
  const clearPrintFrame = useCallback(() => {
    frame.current?.remove();
    frame.current = null;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; clearPrintFrame();
      if (resetTimer.current) clearTimeout(resetTimer.current);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, [clearPrintFrame]);
  useEffect(() => {
    let active = true;
    const activeVideo = video.current;
    if (savedRecord) return undefined;
    const startCamera = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("La caméra intégrée n’est pas disponible dans ce navigateur. Ouvrez la page en HTTPS ou dans l’application compatible.");
        return;
      }
      let cameraStream;
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (!active) {
          cameraStream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = cameraStream;
        if (activeVideo) {
          activeVideo.srcObject = cameraStream;
          await activeVideo.play();
        }
        if (active) {
          setCameraReady(true);
          setError("");
        }
      } catch (failure) {
        cameraStream?.getTracks().forEach((track) => track.stop());
        if (stream.current === cameraStream) stream.current = null;
        if (activeVideo) activeVideo.srcObject = null;
        if (active) {
          setCameraReady(false);
          setError(`Caméra indisponible : ${failure.message || "autorisez l’accès à la caméra puis réessayez."}`);
        }
      }
    };
    void startCamera();
    return () => {
      active = false;
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      if (activeVideo) activeVideo.srcObject = null;
    };
  }, [cameraAttempt, savedRecord]);

  const changeMode = (next) => {
    setMode(next); setConfirmed(false); setResult(null); setError(""); setPrintState("");
  };
  const save = async (event, selectedFile = file) => {
    event?.preventDefault();
    if (pending.current) return;
    setError(""); setResult(null); setPrintState("");
    if (!sessionReady) {
      setError("Ouvrez ou reprenez le dossier de l’établissement avant le scan.");
      return;
    }
    if (!establishmentName.trim()) {
      setError("Sélectionnez ou saisissez le restaurant actif avant le scan.");
      return;
    }
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
    body.append("restaurant_name", establishmentName.trim());
    body.append("operation", JSON.stringify(operation));
    const snapshot = JSON.stringify({
      operation,
      operateur: operator.trim(),
      restaurant_name: establishmentName.trim(),
    });
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
      }
      try {
        await onCaptureSaved(record);
      } catch (failure) {
        if (mounted.current) setError(`Scan archivé, mais la liste du dossier n’a pas pu être actualisée : ${failure.message}`);
      }
    } catch (failure) {
      if (mounted.current) setError(`${failure.message} Si la connexion a été coupée, vérifiez le registre avant de renvoyer la photo.`);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const capture = async () => {
    if (pending.current || takingPhoto.current || !cameraReady || result) return;
    takingPhoto.current = true;
    setCapturing(true); setError("");
    try {
      const activeVideo = video.current;
      const activeCanvas = canvas.current;
      if (!activeVideo || !activeCanvas || !activeVideo.videoWidth || !activeVideo.videoHeight) {
        throw new Error("Le flux vidéo n’est pas encore prêt. Réessayez dans un instant.");
      }
      activeCanvas.width = activeVideo.videoWidth;
      activeCanvas.height = activeVideo.videoHeight;
      const context = activeCanvas.getContext("2d");
      if (!context) throw new Error("La capture de l’image vidéo est indisponible.");
      context.drawImage(activeVideo, 0, 0, activeCanvas.width, activeCanvas.height);
      const blob = await new Promise((resolve, reject) => {
        activeCanvas.toBlob((image) => image
          ? resolve(image)
          : reject(new Error("La caméra n’a pas pu créer l’image. Réessayez.")), "image/jpeg", 0.94);
      });
      if (!mounted.current) return;
      if (!blob.size || blob.size > 20 * 1024 * 1024) {
        throw new Error("Capture vide ou supérieure à 20 Mo. Réessayez en cadrant plus près.");
      }
      const selectedFile = new File([blob], "etiquette.jpg", { type: "image/jpeg" });
      setFile(selectedFile); setResult(null); setPrintState("");
      captureId.current = null; submitted.current = null;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = URL.createObjectURL(selectedFile);
      setPreview(previewRef.current);
      await save(null, selectedFile);
    } catch (failure) {
      if (mounted.current) setError(failure.message || "Capture impossible. Le flux caméra reste actif ; réessayez.");
    } finally {
      takingPhoto.current = false;
      if (mounted.current) setCapturing(false);
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
      if (kitchenMode && job.status === "accepted") showKitchenPrintSuccess();
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
      if (kitchenMode && job?.status === "accepted") showKitchenPrintSuccess();
    } catch (failure) { setError(failure.message); }
  };
  const resetCapture = () => {
    setResult(null); setError(""); setPrintState(""); setPrintSuccess(false); setConfirmed(false); setFile(null);
    captureId.current = null; submitted.current = null;
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null; setPreview(null);
  };
  const showKitchenPrintSuccess = () => {
    setPrintSuccess(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      if (!mounted.current) return;
      resetCapture();
      resetTimer.current = null;
    }, 1500);
  };

  return (
    <section aria-label={kitchenMode ? "Cuisine simplifiée — capture HACCP" : "Capture des étiquettes ΣIRIUS"}
      className={`haccp-ui workspace-surface haccp-card haccp-capture${kitchenMode ? " haccp-kitchen" : ""}`}>
      {!kitchenMode && <p className="haccp-kicker">{savedRecord ? "Preuve archivée" : "Capture intelligente"}</p>}
      <h3>{kitchenMode ? "Cuisine · Scanner une étiquette" : `ΣIRIUS · ${savedRecord ? "Vérifier l’étiquette archivée" : "Scanner une étiquette"}`}</h3>
      {!savedRecord && !kitchenMode && <ol className="haccp-steps" aria-label="Étapes de capture"><li><span>1</span>Choisir l’action</li><li><span>2</span>Photographier</li><li><span>3</span>Vérifier et imprimer</li></ol>}
      {!savedRecord && <form onSubmit={save}>
        <fieldset disabled={busy || capturing || !!result || !sessionReady} className="haccp-capture-fields">
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
          <div className={`haccp-camera-stage${capturing || busy ? " is-capturing" : ""}${cameraReady ? " is-ready" : ""}`}>
            <video ref={video} autoPlay playsInline muted aria-label="Aperçu en direct de la caméra arrière" />
            <div className="haccp-viewfinder" aria-hidden="true"><span className="haccp-laser" /></div>
            {!cameraReady && <p className="haccp-camera-state" role="status">{error || "Démarrage de la caméra…"}</p>}
            {(capturing || busy) && <p className="haccp-camera-state haccp-camera-loading" role="status">
              <LoaderCircle className="haccp-loading" size={26} aria-hidden="true" />Analyse de l’étiquette en cours…
            </p>}
            <canvas ref={canvas} className="haccp-capture-canvas" aria-hidden="true" />
            <button type="button" className={`haccp-scan haccp-primary haccp-camera-action${kitchenMode ? " haccp-kitchen-scan" : ""}`}
              aria-busy={capturing || busy}
                disabled={!cameraReady || busy || capturing || !!result || !sessionReady || !establishmentName.trim()
                  || !operator.trim() || (mode === "ouverture" && hasRule
                    && (!confirmed || !reason.trim() || !Number.isSafeInteger(Number(hours)) || Number(hours) <= 0))}
                onClick={capture}>
              {capturing || busy ? <LoaderCircle className="haccp-loading" size={30} aria-hidden="true" /> : <Camera size={30} aria-hidden="true" />}
              <span>{capturing || busy ? "Analyse de l’étiquette en cours…" : "Capturer l’étiquette"}</span>
              <ScanLine size={22} aria-hidden="true" />
            </button>
          </div>
          {!cameraReady && <button type="button" disabled={busy || capturing} onClick={() => setCameraAttempt((attempt) => attempt + 1)}>
            <RotateCcw size={18} aria-hidden="true" />Réessayer l’accès caméra
          </button>}
          {file && error && <button type="submit"><RotateCcw size={18} aria-hidden="true" />Réessayer la même photo sans doublon</button>}
        </fieldset>
      </form>}
      <p className="haccp-notice">{kitchenMode
        ? "Après le scan, vérifiez le produit, le lot et la date avant de confirmer l’impression. La température n’est pas mesurée."
        : "Analyse OpenAI, archivage sur le serveur. Aucun contrôle physique ou de température n’est certifié."}</p>
      {!kitchenMode && !savedRecord && !result && <details><summary>Configurer l’imprimante (une seule fois)</summary><HaccpPrinter /></details>}
      {preview && <img src={preview} alt="Photo originale à relire avant validation" style={{ maxWidth: "100%", maxHeight: 500, objectFit: "contain" }} />}
      {error && <p role="alert">{error}</p>}
      {printSuccess && <p className="haccp-print-success" role="status">
        Demande d’impression envoyée — vérifiez la sortie papier. Préparation du scan suivant…
      </p>}
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
            <button className={`haccp-primary${kitchenMode ? " haccp-kitchen-print" : ""}`} disabled={busy || !!printState} onClick={queuePrint}>
              <Printer size={20} aria-hidden="true" />{kitchenMode
                ? "J’ai vérifié le produit, le lot et la DLC — imprimer"
                : "J’ai vérifié : valider et imprimer"}
            </button>
            {printState && <button disabled={busy} onClick={checkPrintState}>Voir l’état d’impression</button>}
            {!kitchenMode && <details><summary>Secours manuel (risque de doublon)</summary><p>Uniquement si aucune demande n’a été envoyée au relais. Vérifiez le registre et le papier avant toute impression manuelle.</p><button disabled={busy || !!printState} onClick={print}>Imprimer l’étiquette d’ouverture manuellement</button></details>}
          </>}
          {printState && <p role="status">{printState}</p>}
        </>}
      </div>}
      {result && !savedRecord && !printSuccess && <button type="button" disabled={busy} onClick={resetCapture}><Camera size={20} aria-hidden="true" />Scanner une autre étiquette</button>}
    </section>
  );
}
