import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { checkHaccpResponse, haccpFetch } from "./haccpRequest";
import { downloadHaccpBlob } from "./haccpDocuments";

export const RECEPTION_DESTINATIONS = {
  traceabilite: "A · Journal de traçabilité",
  stock: "B · Lots / alertes DLC",
  allergenes: "C · Observations allergènes",
  achats: "D · Achats / rapprochement BL",
};
const STATES = { pending: "en attente", done: "enregistré", error: "échec" };
const ROOT = `${API_BASE_URL}/haccp/receptions`;

export function checkDistribution(value, id) {
  const entries = value?.destinations;
  if (value?.reception_id !== id || !Array.isArray(entries) || entries.length !== 4
      || new Set(entries.map((item) => item?.destination)).size !== 4
      || entries.some((item) => !Object.hasOwn(RECEPTION_DESTINATIONS, item?.destination)
        || !Object.hasOwn(STATES, item?.statut) || !Number.isSafeInteger(item.tentatives) || item.tentatives < 0
        || (item.statut === "error" && typeof item.erreur !== "string"))) {
    throw new Error("État de distribution invalide : vérifiez le registre avant toute nouvelle capture.");
  }
  const expected = entries.every((item) => item.statut === "done") ? "complete"
    : entries.some((item) => item.statut !== "pending") ? "partial" : "pending";
  if (value.statut !== expected) throw new Error("État de distribution incohérent.");
  const review = value.observation_allergenes;
  if (review != null && (typeof review.verification_requise !== "boolean"
      || !["non_verifiee", "partielle", "complete"].includes(review.lecture)
      || !["nouveaux_allergenes", "nouvelles_traces"].every((field) => Array.isArray(review[field])
        && review[field].every((item) => typeof item === "string")))) {
    throw new Error("Observation d’allergènes invalide : vérification nécessaire.");
  }
  return value;
}

export default function HaccpReceptionStatus({ record, onDistributionChange }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const current = ++generation.current;
    const controller = new AbortController();
    setState(null);
    setError("");
    const load = async () => {
      try {
        const value = record.distribution || await haccpFetch(`${ROOT}/${record.id}/distribution`,
          { signal: controller.signal }, async (response) => (await checkHaccpResponse(response)).json());
        const validated = checkDistribution(value, record.id);
        if (mounted.current && current === generation.current) setState(validated);
      } catch (failure) {
        if (mounted.current && current === generation.current && !controller.signal.aborted) setError(failure.message);
      }
    };
    void load();
    return () => { mounted.current = false; controller.abort(); };
  }, [record.id, record.distribution]);

  const act = async (action) => {
    if (pending.current) return;
    pending.current = true;
    const current = action === "original" ? generation.current : ++generation.current;
    setBusy(true);
    setError("");
    try {
      if (action === "original") {
        const blob = await haccpFetch(`${ROOT}/${record.id}/original`, {},
          async (response) => (await checkHaccpResponse(response)).blob());
        if (mounted.current) downloadHaccpBlob(blob, record.chemin_image_brute?.split("/").pop() || `REC_${record.id}`);
      } else {
        const value = await haccpFetch(`${ROOT}/${record.id}/${action === "retry" ? "reprise" : "distribution"}`,
          { method: action === "retry" ? "POST" : "GET" },
          async (response) => (await checkHaccpResponse(response)).json());
        const validated = checkDistribution(value, record.id);
        if (mounted.current && current === generation.current) {
          setState(validated);
          onDistributionChange?.(validated);
        }
      }
    } catch (failure) {
      if (mounted.current) setError(failure.message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <section className="haccp-distribution" aria-label="Distribution de la réception">
    <h4>Distribution de la réception #{record.id}</h4>
    {!state && !error && <p role="status">Lecture de l’état des quatre destinations…</p>}
    {state && <>
      <p role={state.statut === "complete" ? "status" : "alert"}>{state.statut === "complete"
        ? "Distribution technique effectuée (4/4)."
        : "Distribution incomplète : reprenez les destinations manquantes, sans refaire de photo."}</p>
      <ul>{state.destinations.map((item) => <li key={item.destination}>
        {RECEPTION_DESTINATIONS[item.destination]} : <strong>{STATES[item.statut]}</strong>
        {item.erreur && <p>{item.erreur}</p>}
      </li>)}</ul>
      {state.observation_allergenes?.verification_requise && <div role="alert">
        <strong>Contrôle des allergènes requis.</strong>
        {!!state.observation_allergenes.nouveaux_allergenes.length && <p>Nouveaux allergènes présents : {state.observation_allergenes.nouveaux_allergenes.join(", ")}.</p>}
        {!!state.observation_allergenes.nouvelles_traces.length && <p>Nouvelles traces possibles : {state.observation_allergenes.nouvelles_traces.join(", ")}.</p>}
        {!state.observation_allergenes.reference_reception_id && <p>Première observation ou lecture non comparable : relisez la déclaration du fournisseur.</p>}
        <p>Vérifiez les recettes concernées ; la matrice de la carte n’a pas été modifiée automatiquement.</p>
      </div>}
    </>}
    <p>Cette distribution ne valide ni la réception physique, ni la quantité réellement livrée, ni l’absence d’allergènes.</p>
    <div className="haccp-reception-actions">
      <button type="button" disabled={busy} onClick={() => act("refresh")}>Actualiser la distribution</button>
      {state && state.statut !== "complete" && <button type="button" disabled={busy} onClick={() => act("retry")}>Reprendre sans doublon</button>}
      <button type="button" disabled={busy} onClick={() => act("original")}>Télécharger l’original vérifié</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
