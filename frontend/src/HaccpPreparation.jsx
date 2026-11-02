import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { checkHaccpResponse, haccpFetch } from "./haccpRequest";
import HaccpLabelCapture from "./HaccpLabelCapture";
import HaccpPrinter from "./HaccpPrinter";
import "./HaccpWorkspace.css";

const EMPTY = { product: "", lot: "", manufacturedAt: "", utcOffset: "", hours: "", conditions: "", reason: "", operator: "Cuisine" };

export default function HaccpPreparation({ establishmentName, sessionReady }) {
  const [draft, setDraft] = useState(EMPTY);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const attempt = useRef(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const change = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value, ...(field === "manufacturedAt" ? { utcOffset: "" } : {}) }));
    setConfirmed(false);
    setError("");
  };
  const canSubmit = sessionReady && establishmentName.trim() && draft.product.trim() && draft.operator.trim()
    && draft.manufacturedAt && Number.isSafeInteger(Number(draft.hours)) && Number(draft.hours) > 0
    && draft.conditions.trim() && draft.reason.trim() && confirmed && !busy && !result;

  const save = async (event) => {
    event.preventDefault();
    if (pending.current) return;
    if (!canSubmit) {
      setError("Ouvrez le dossier et renseignez le produit, sa fabrication exacte, l’opérateur et la règle de conservation confirmée.");
      return;
    }
    const payload = {
      nom_produit: draft.product.trim(), numero_lot: draft.lot.trim() || null,
      restaurant_name: establishmentName.trim(), operateur: draft.operator.trim(),
      date_fabrication: draft.manufacturedAt + draft.utcOffset, duree_conservation_heures: Number(draft.hours),
      conditions_conservation: draft.conditions.trim(), justification_duree: draft.reason.trim(),
      regle_confirmee: confirmed,
    };
    const snapshot = JSON.stringify(payload);
    if (attempt.current && attempt.current.snapshot !== snapshot) {
      setError("Une tentative existe déjà. Rétablissez les mêmes données pour la vérifier, ou consultez le registre avant de choisir « Nouvelle préparation ».");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!attempt.current) attempt.current = { id: crypto.randomUUID(), snapshot };
      const record = await haccpFetch(`${API_BASE_URL}/haccp/preparations`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, capture_id: attempt.current.id }),
      }, async (response) => (await checkHaccpResponse(response)).json());
      if (!record || record.type_operation !== "preparation" || !Number.isSafeInteger(record.id) || record.id < 1
          || typeof record.nom_produit !== "string" || !record.nom_produit.trim()
          || typeof record.conditions_conservation !== "string" || !record.conditions_conservation.trim()
          || !Number.isFinite(Date.parse(record.date_fabrication)) || !Number.isFinite(Date.parse(record.dlc_secondaire))) {
        throw new Error("Réponse de préparation invalide. Vérifiez le registre avant toute impression.");
      }
      if (mounted.current) setResult(record);
    } catch (failure) {
      if (failure.status === 422) attempt.current = null;
      if (mounted.current) setError(failure.status === 422 ? failure.message
        : `${failure.message} En cas de coupure, réessayez les mêmes données sans doublon ou vérifiez le registre.`);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const reset = () => {
    attempt.current = null;
    setDraft((current) => ({ ...EMPTY, operator: current.operator }));
    setConfirmed(false);
    setResult(null);
    setError("");
  };

  return <section className="workspace-surface haccp-card haccp-preparation" aria-label="Étiquette de préparation">
    <h3>Préparation · Fabrication et DLC</h3>
    <p>Saisissez l’heure réelle de fabrication en Europe/Paris : « le matin » ne suffit pas. Aucune photo ni analyse IA n’est nécessaire.</p>
    <p className="haccp-notice">La durée et les conditions doivent être validées pour ce produit dans votre PMS.
      Aucune durée J+3 n’est imposée. Si votre règle prévoit 72 heures après fabrication, saisissez 72 :
      il s’agit d’heures écoulées, pas d’une fin de journée automatique.</p>
    {(!sessionReady || !establishmentName.trim()) && <p role="status">Ouvrez le dossier de l’établissement puis choisissez « Reprendre / Continuer » si proposé.</p>}
    {!result && <form onSubmit={save}>
      <fieldset className="haccp-capture-fields" disabled={busy || !sessionReady || !establishmentName.trim()}>
        <legend>Produit fabriqué sur place</legend>
        <label>Nom du produit
          <input required maxLength={255} value={draft.product} onChange={(event) => change("product", event.target.value)} />
        </label>
        <label>Lot de préparation (facultatif, sinon généré)
          <input maxLength={128} value={draft.lot} onChange={(event) => change("lot", event.target.value)} />
        </label>
        <label>Date et heure de fabrication (Europe/Paris)
          <input type="datetime-local" step="1" required value={draft.manufacturedAt} onChange={(event) => change("manufacturedAt", event.target.value)} />
        </label>
        <details><summary>Changement d’heure : préciser une heure répétée</summary>
          <label>Décalage UTC de l’heure de fabrication
            <select value={draft.utcOffset} onChange={(event) => change("utcOffset", event.target.value)}>
              <option value="">Automatique — Europe/Paris</option>
              <option value="+02:00">Heure d’été — UTC+02:00</option>
              <option value="+01:00">Heure d’hiver — UTC+01:00</option>
            </select>
          </label>
          <p>Lors du passage à l’heure d’hiver, précisez laquelle des deux occurrences vous avez relevée. Une heure inexistante ou un décalage incohérent sera refusé.</p>
        </details>
        <label>Durée de conservation validée (heures entières)
          <input type="number" min="1" step="1" required value={draft.hours} onChange={(event) => change("hours", event.target.value)} />
        </label>
        <label>Conditions de conservation : température, contenant et précautions
          <textarea required maxLength={500} value={draft.conditions} onChange={(event) => change("conditions", event.target.value)} />
        </label>
        <label>Référence de la règle PMS applicable à ce produit
          <textarea required maxLength={500} value={draft.reason} onChange={(event) => change("reason", event.target.value)} />
        </label>
        <label>Opérateur
          <input required maxLength={100} value={draft.operator} onChange={(event) => change("operator", event.target.value)} />
        </label>
        <label className="haccp-check"><input type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          Je confirme la fabrication saisie et la règle de conservation validée pour ce produit et ses conditions.
        </label>
        <button type="submit" className="haccp-primary" disabled={!canSubmit} aria-busy={busy}>
          {busy ? "Enregistrement de la préparation…" : "Calculer la DLC et générer l’étiquette"}
        </button>
      </fieldset>
    </form>}
    {error && <p role="alert">{error}</p>}
    {result && <HaccpLabelCapture key={result.id} savedRecord={result} />}
    {(result || attempt.current) && <>
      {!result && <p>Avant de repartir sur une nouvelle fiche après une erreur, vérifiez que la précédente n’est pas déjà au registre.</p>}
      <button type="button" disabled={busy} onClick={reset}>Nouvelle préparation</button>
    </>}
    <details><summary>Configurer l’imprimante (une seule fois)</summary><HaccpPrinter /></details>
  </section>;
}
