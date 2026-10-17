import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { newChronosRequestId } from "./chronos";
import { downloadWorkJson } from "./workModuleBackup";
import "./ArianeActions.css";

const ROOT = `${API_BASE_URL}/ariane`;
const LABELS = { PENDING: "En attente", RUNNING: "En cours", COMPLETED: "Terminé", SKIPPED: "Ignoré",
  BLOCKED: "Bloqué", WAITING_CONFIRMATION: "Votre accord est requis", EXPIRED: "Expiré", CANCELLED: "Arrêté" };
export const ACTION_TEMPLATES = {
  analysis: { title: "Analyser AAPL et vérifier sa volatilité", steps: [
    { id: "analyse", action: "portus.analysis", inputs: { symbol: "AAPL", period: "1y" } },
    { id: "regles", action: "portus.volatility_rules", depends_on: ["analyse"],
      bindings: { analysis: { step: "analyse", path: ["analysis"] } }, inputs: { volatility_threshold_pct: 30 } },
  ] },
  alert: { title: "Préparer une surveillance AAPL à 200 USD", steps: [
    { id: "apercu", action: "finance.prepare",
      inputs: { action: { kind: "alert", symbol: "AAPL", condition: "price_above", threshold: 200 } } },
    { id: "validation", action: "finance.confirm", depends_on: ["apercu"],
      bindings: { preview: { step: "apercu", path: ["data"] } } },
  ] },
  review: { title: "Consulter mon portefeuille et mes surveillances", steps: [
    { id: "portefeuille", action: "finance.portfolio" }, { id: "surveillances", action: "finance.overview" },
  ] },
};

async function read(response) {
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Requête ARIANE refusée ; vérifiez les entrées et le contrat.");
  return result;
}
const pretty = (value) => JSON.stringify(value, null, 2);

function Evidence({ value, title }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{title}</summary>
    {open && <pre>{pretty(value)}</pre>}
  </details>;
}

export default function ArianeActions({ auditOnly = false }) {
  const [catalog, setCatalog] = useState([]);
  const [runs, setRuns] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [current, setCurrent] = useState(null);
  const [template, setTemplate] = useState("analysis");
  const [objective, setObjective] = useState(ACTION_TEMPLATES.analysis.title);
  const [steps, setSteps] = useState(pretty(ACTION_TEMPLATES.analysis.steps));
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stopPreview, setStopPreview] = useState(false);
  const alive = useRef(true);
  const locked = useRef(false);
  const requests = useRef(new Set());
  const nextRequest = useRef(null);

  const fetchData = async (url, options = {}) => {
    const controller = new AbortController();
    requests.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 130000);
    try {
      return await read(await fetch(url, { credentials: "include", ...options, signal: controller.signal }));
    } catch (failure) {
      if (failure.name === "AbortError") throw new Error("Lecture interrompue ou délai dépassé. Consultez la même référence avant de réessayer.");
      throw failure;
    } finally {
      clearTimeout(timer); requests.current.delete(controller);
    }
  };
  useEffect(() => {
    alive.current = true;
    const controllers = requests.current;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    Promise.all([fetch(`${ROOT}/actions`, { credentials: "include", signal: controller.signal }).then(read),
      fetch(`${ROOT}/runs`, { credentials: "include", signal: controller.signal }).then(read)]).then(([actions, history]) => {
      if (!Array.isArray(actions.actions) || !Array.isArray(history.items)) throw new Error("Catalogue ou historique ARIANE incomplet.");
      if (!alive.current) return;
      setCatalog(actions.actions); setRuns(history.items); setTruncated(!!history.truncated);
    }).catch((failure) => {
      if (alive.current) setError(failure.name === "AbortError" ? "Chargement du catalogue interrompu ; rouvrez ce panneau." : failure.message);
    }).finally(() => { clearTimeout(timer); controllers.delete(controller); });
    return () => { alive.current = false; controllers.forEach((item) => item.abort()); controllers.clear(); };
  }, []);

  const operation = async (url, options = {}, creation = false) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try {
      const result = await fetchData(url, options);
      if (!result.id || !Array.isArray(result.steps) || !result.summary) throw new Error("État du parcours incomplet ; consultez le suivi de la même référence.");
      if (!alive.current) return;
      setCurrent(result); setStopPreview(false);
      if (creation) { setPending(null); nextRequest.current = null; }
      setRuns((previous) => [{ id: result.id, objective: result.plan.objective, created_at: result.created_at },
        ...previous.filter((item) => item.id !== result.id)].slice(0, 20));
    } catch (failure) {
      if (alive.current) setError(`${failure.message} Une action peut déjà être enregistrée : ne créez pas une nouvelle demande pour contourner une coupure.`);
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const launch = () => {
    if (locked.current) return;
    try {
      const parsed = JSON.parse(steps);
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > 12 || steps.length > 100000 || !objective.trim()) {
        throw new Error("Un objectif et une à douze étapes sont requis, 100 ko maximum.");
      }
      const body = nextRequest.current || { request_id: newChronosRequestId(), objective: objective.trim(), steps: parsed };
      nextRequest.current = body; setPending(body);
      void operation(`${ROOT}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: pretty(body) }, true);
    } catch (failure) { setError(failure.message); }
  };
  const terminal = current && ["COMPLETED", "EXPIRED", "CANCELLED"].includes(current.state);

  return <section className="ariane-actions numm-tech numm-tech-card" data-testid="ariane-actions">
    <h2>{auditOnly ? "NÉMÉSIS · preuves des actions communes" : "ARIANE · actions communes"}</h2>
    <p>Un objectif, des étapes reliées, un résultat vérifiable. Seules les actions du catalogue serveur peuvent être exécutées.
      Les listes manuelles ci-dessous et les anciens parcours financiers restent séparés.</p>
    <p>Chaque modification attend votre accord sur ses entrées exactes. Aucun ordre boursier.
      Une relance Outlook exige la validation de son message et de son suivi dans la boîte À traiter.
      Les données, aperçus et preuves sont conservés pour votre compte dans le service connecté.</p>
    <details><summary>Catalogue et règles d'autonomie · {catalog.length} actions</summary>
      {catalog.map((action) => <details key={action.name}><summary>{action.title} · {action.module} · {action.name}</summary>
        <p>Version {action.version} · {action.kind} · risque {action.risk} · {action.confirmation_required ? "Accord requis" : "Sans modification métier"}
          {" · "}{action.timeout_seconds} s par tentative, {action.max_attempts} tentatives au maximum.
          {" "}{action.reversible ? "Compensation disponible" : "Pas de compensation automatique"}.</p>
        <p>Sources imposées : {pretty(action.required_sources || [])}</p>
        <Evidence title="Schémas d'entrée et de sortie" value={{ inputs: action.input_schema, output: action.output_schema }} />
      </details>)}
    </details>
    {!auditOnly && <>
      <fieldset disabled={busy || !!pending}>
        <legend>Préparer un parcours</legend>
        <label>Parcours guidé <select value={template} onChange={(event) => {
          const key = event.target.value; setTemplate(key);
          setObjective(ACTION_TEMPLATES[key].title); setSteps(pretty(ACTION_TEMPLATES[key].steps));
        }}>{Object.entries(ACTION_TEMPLATES).map(([key, item]) => <option key={key} value={key}>{item.title}</option>)}</select></label>
        <label>Objectif <input value={objective} maxLength={300} onChange={(event) => setObjective(event.target.value)} /></label>
        <details><summary>Étapes et paramètres avancés</summary>
          <p>Modifiez les symboles ou seuils ici. Les liaisons pointent vers une dépendance explicite.
            Une condition « when » utilise eq, gt ou lt ; une source absente bloque, sans inventer de valeur.</p>
          <label>Plan JSON <textarea rows={12} maxLength={100000} value={steps} onChange={(event) => setSteps(event.target.value)} /></label>
        </details>
      </fieldset>
      <button type="button" disabled={busy || !catalog.length} onClick={launch}>
        {pending ? "Réessayer la même référence" : "Démarrer la préparation et les lectures"}</button>
      {pending && <p>Référence de demande à conserver : {pending.request_id}. Paramètres verrouillés tant que son résultat n'est pas retrouvé.</p>}
    </>}
    {busy && <p role="status">Traitement en cours. Les étapes terminées restent sauvegardées ; une modification sensible attendra votre validation.</p>}
    {error && <p role="alert">{error}</p>}
    <h3>Parcours communs enregistrés</h3>
    {!runs.length && <p>Aucun parcours commun chargé.</p>}
    {truncated && <p>Historique tronqué aux vingt derniers parcours.</p>}
    <ul>{runs.map((item) => <li key={item.id}><button type="button" disabled={busy}
      onClick={() => operation(`${ROOT}/runs/${item.id}`)}>Consulter {item.id}</button> · {item.objective} · {item.created_at}</li>)}</ul>
    {current && <section>
      <h3>{current.plan.objective} · {LABELS[current.state] || current.state}</h3>
      <p>Référence {current.id} · reprise jusqu'au {current.expires_at}. Reprendre conserve les captures déjà terminées, sans les actualiser.</p>
      <p>{Object.entries(current.summary).map(([name, count]) => `${LABELS[name] || name} : ${count}`).join(" · ")}</p>
      <button type="button" disabled={busy} onClick={() => operation(`${ROOT}/runs/${current.id}`)}>Actualiser cet état</button>
      <button type="button" onClick={() => {
        try { downloadWorkJson(pretty(current), `ariane-actions-${current.id}.json`); }
        catch (failure) { setError(failure.message || "Export des preuves impossible."); }
      }}>Exporter les preuves des actions communes</button>
      {!auditOnly && !terminal && <>
        <button type="button" disabled={busy} onClick={() => operation(`${ROOT}/runs/${current.id}/resume`, { method: "POST" })}>Reprendre ce parcours commun</button>
        <button type="button" disabled={busy} onClick={() => setStopPreview(true)}>Arrêter les prochaines étapes</button>
        {stopPreview && <div role="group" aria-label="Confirmer l'arrêt">
          <p>L'arrêt empêche les étapes non commencées. Une étape déjà engagée peut finir ; rien n'est annulé ni compensé.</p>
          <button type="button" disabled={busy} onClick={() => operation(`${ROOT}/runs/${current.id}/cancel`, { method: "POST" })}>Confirmer l'arrêt du parcours</button>
          <button type="button" disabled={busy} onClick={() => setStopPreview(false)}>Conserver le parcours</button>
        </div>}
      </>}
      <ol>{current.steps.map((step) => <li key={step.id}>
        <strong>{step.id}</strong> · {step.action} · {LABELS[step.state] || step.state}
        <p>Dépendances : {step.depends_on?.join(", ") || "aucune"} · {step.attempts} tentative(s)
          {step.attempt_limit ? ` / ${step.attempt_limit} maximum` : ""}
          {step.duration_ms != null ? ` · ${step.duration_ms} ms` : ""}.</p>
        {step.reason && <p>{step.reason}</p>}
        {step.retry_after && <p>Reprise d'une tentative interrompue possible après {step.retry_after}, pas avant.</p>}
        {step.approval && <p>Accord explicite enregistré : {step.approval.confirmed_at}.</p>}
        {step.prepared && <details open={step.state === "WAITING_CONFIRMATION"}><summary>Entrées exactes et empreinte de validation</summary>
          <pre>{pretty(step.prepared.inputs)}</pre><p>{step.prepared.fingerprint}</p>
        </details>}
        {!auditOnly && !terminal && step.state === "WAITING_CONFIRMATION" && <button type="button" disabled={busy}
          onClick={() => operation(`${ROOT}/runs/${current.id}/steps/${step.id}/confirm`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: pretty({ confirm: true, fingerprint: step.prepared.fingerprint }),
          })}>J'autorise uniquement l'étape {step.id}</button>}
        {step.output?.analysis && <p>{step.output.analysis.symbol} · {step.output.analysis.source}
          {" · "}séance {step.output.analysis.as_of} · reçu {step.output.analysis.fetched_at}
          {" · "}données {step.output.analysis.data_version}</p>}
        {step.output?.findings && <p>{step.output.findings.length} dépassement(s), {step.output.missing.length} réserve(s).
          Résultats descriptifs, pas une recommandation personnalisée.</p>}
        {step.output && <Evidence title="Résultat et données utilisées" value={step.output} />}
      </li>)}</ol>
      <details><summary>Journal NÉMÉSIS des actions communes</summary>
        {current.events_truncated && <p>Journal tronqué aux cent derniers événements.</p>}
        {current.cancellation && <p>Arrêt demandé le {current.cancellation.cancelled_at} ; pas de compensation.</p>}
        <pre>{pretty(current.events)}</pre>
      </details>
    </section>}
  </section>;
}
