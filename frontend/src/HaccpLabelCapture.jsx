import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { printHaccpDocument } from "./haccpDocuments";
import HaccpPrinter, { haccpPrintRequest, haccpPrintStatus } from "./HaccpPrinter";
import { haccpFetch } from "./haccpRequest";

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
      const job = await haccpPrintRequest("/demandes", { label_id: result.id, reviewed: true });
      setPrintState(`${haccpPrintStatus(job.status)}. Aucun doublon ne sera envoyé automatiquement.`);
    } catch (failure) { setError(failure.message); }
    finally { pending.current = false; setBusy(false); }
  };
  const checkPrintState = async () => {
    setError("");
    try {
      const state = await haccpPrintRequest("/etat");
      const job = state.jobs.find((item) => item.label_id === result.id);
      setPrintState(job ? `${haccpPrintStatus(job.status)}. ${job.detail || ""}`
        : "Aucune demande trouvée pour cette ouverture.");
    } catch (failure) { setError(failure.message); }
  };

  return (
    <section aria-label="Capture des étiquettes ΣIRIUS" className="hc-section">
      <h3>ΣIRIUS · {savedRecord ? "Vérifier l’étiquette archivée" : "Scanner une étiquette"}</h3>
      {!savedRecord && <p>1. Choisir l’action · 2. Photographier · 3. Vérifier et imprimer.</p>}
      <p>Analyse OpenAI, archivage sur le serveur. Aucun contrôle physique ou de température n’est certifié.</p>
      {!savedRecord && !result && <details><summary>Configurer l’imprimante (une seule fois)</summary><HaccpPrinter /></details>}
      {!savedRecord && !result && <form onSubmit={save}>
        <fieldset disabled={busy} style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <legend>Action</legend>
          <div role="group" aria-label="Type d’opération">
            <button type="button" className={`hc-tab ${mode === "reception" ? "on" : ""}`} aria-pressed={mode === "reception"} onClick={() => changeMode("reception")}>Réception</button>
            <button type="button" className={`hc-tab ${mode === "ouverture" ? "on" : ""}`} aria-pressed={mode === "ouverture"} onClick={() => changeMode("ouverture")}>Ouverture produit</button>
          </div>
          <label>Opérateur
            <input className="cmd-input" value={operator} maxLength={100} required onChange={(e) => setOperator(e.target.value)} />
          </label>
          {mode === "ouverture" && <>
            <p>L’heure d’ouverture enregistrée sera celle du serveur à l’envoi. Scanner immédiatement après l’ouverture ; aucune durée J+3 n’est présumée.</p>
            <label><input type="checkbox" checked={hasRule} onChange={(e) => { setHasRule(e.target.checked); setConfirmed(false); }} /> Appliquer une durée fabricant/PMS validée pour ce produit et ses conditions de stockage</label>
            {hasRule ? <>
              <label>Durée après ouverture (heures entières)
                <input className="cmd-input" type="number" min="1" step="1" value={hours} required onChange={(e) => { setHours(e.target.value); setConfirmed(false); }} />
              </label>
              <label>Justification : indication fabricant ou référence PMS
                <textarea className="cmd-input" value={reason} maxLength={500} required onChange={(e) => { setReason(e.target.value); setConfirmed(false); }} />
              </label>
              <label><input type="checkbox" checked={confirmed} required onChange={(e) => setConfirmed(e.target.checked)} /> Je confirme cette durée et ses conditions pour le produit photographié.</label>
            </> : <p role="status">Sans règle confirmée : ouverture archivée avec alerte, sans DLC secondaire ni étiquette d’utilisation.</p>}
          </>}
          <input ref={input} type="file" style={{ display: "none" }} accept="image/jpeg,image/png,image/webp" capture="environment" aria-label="Photo de l’étiquette" onChange={(e) => {
            const selected = e.target.files?.[0] || null;
            setFile(selected); setResult(null); setPrintState("");
            captureId.current = null; submitted.current = null;
            if (previewRef.current) URL.revokeObjectURL(previewRef.current);
            previewRef.current = selected ? URL.createObjectURL(selected) : null;
            setPreview(previewRef.current);
            if (selected) save(null, selected);
          }} />
          <button type="button" className="cmd-send" style={{ minHeight: 56 }} disabled={!operator.trim() || (mode === "ouverture" && hasRule && (!confirmed || !reason.trim() || !Number.isSafeInteger(Number(hours)) || Number(hours) <= 0))} onClick={() => input.current?.click()}>{busy ? "Analyse et archivage…" : "Scanner étiquette"}</button>
          {file && error && <button type="submit" className="cmd-send">Réessayer la même photo sans doublon</button>}
        </fieldset>
      </form>}
      {preview && <img src={preview} alt="Photo originale à relire avant validation" style={{ maxWidth: "100%", maxHeight: 500, objectFit: "contain" }} />}
      {error && <p role="alert">{error}</p>}
      {result && <div role="status">
        <h4>{result.conforme_reception ? "Aucune anomalie détectée sur l’étiquette — à vérifier" : "Vérification requise — ne pas valider l’utilisation"}</h4>
        <p>{result.nom_produit} · Lot {result.numero_lot} · {result.type_date} : {result.dlc_ou_ddm || "Illisible ou absente"}</p>
        {result.commentaire_anomalie && <p>{result.commentaire_anomalie}</p>}
        {result.type_operation === "ouverture" && <>
          <p>Ouverture : {displayTime(result.date_ouverture)} · DLC secondaire : {displayTime(result.dlc_secondaire)} (Europe/Paris)</p>
          <p>Durée déclarée : {result.duree_conservation_heures ?? "Non renseignée"} h · Référence : {result.justification_duree || "Aucune"}</p>
          {result.dlc_secondaire && result.conforme_reception && <>
            <p>Vérifiez la photo, le produit, le lot et les dates avant de valider.</p>
            <button className="cmd-send" style={{ minHeight: 56 }} disabled={busy || !!printState} onClick={queuePrint}>J’ai vérifié : valider et imprimer</button>
            {printState && <button disabled={busy} onClick={checkPrintState}>Voir l’état d’impression</button>}
            <details><summary>Secours manuel (risque de doublon)</summary><p>Uniquement si aucune demande n’a été envoyée au relais. Vérifiez le registre et le papier avant toute impression manuelle.</p><button className="cmd-send" disabled={busy || !!printState} onClick={print}>Imprimer l’étiquette d’ouverture manuellement</button></details>
          </>}
          {printState && <p role="status">{printState}</p>}
        </>}
      </div>}
      {result && !savedRecord && <button type="button" className="cmd-send" disabled={busy} onClick={() => {
        setResult(null); setError(""); setPrintState(""); setConfirmed(false); setFile(null);
        captureId.current = null; submitted.current = null;
        if (previewRef.current) URL.revokeObjectURL(previewRef.current);
        previewRef.current = null; setPreview(null);
      }}>Scanner une autre étiquette</button>}
    </section>
  );
}
