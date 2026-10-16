import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { newChronosRequestId } from "./chronos";
import { downloadWorkJson } from "./workModuleBackup";
import "./NummariusAnalytics.css";

const ROOT = `${API_BASE_URL}/ariane/market-runs`;
const LABELS = { PENDING: "En attente", RUNNING: "En cours", COMPLETED: "Terminé",
  BLOCKED: "Bloqué", INTERRUPTED: "Interrompu", EXPIRED: "Expiré" };

async function read(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Parcours ARIANE indisponible.");
  return data;
}

export default function ArianeMarketRuns({ auditOnly = false }) {
  const [runs, setRuns] = useState([]);
  const [current, setCurrent] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [symbols, setSymbols] = useState(["AAPL", "MSFT"]);
  const [threshold, setThreshold] = useState("30");
  const [period, setPeriod] = useState("1y");
  const [pending, setPending] = useState(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    fetch(ROOT, { credentials: "include", signal: controller.signal }).then(read).then((data) => {
      if (!Array.isArray(data.items)) throw new Error("Suivi ARIANE reçu incomplet.");
      if (!controller.signal.aborted) setRuns(data.items);
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => { alive.current = false; controller.abort(); };
  }, []);

  const operation = async (url, options = {}) => {
    setBusy(true); setError("");
    try {
      const result = await read(await fetch(url, { credentials: "include", ...options }));
      if (!result.id || !Array.isArray(result.steps)) throw new Error("Résultat ARIANE incomplet ; consultez le suivi de la même référence.");
      if (!alive.current) return;
      setCurrent(result);
      setPending(null);
      setRuns((previous) => [result, ...previous.filter((item) => item.id !== result.id)].slice(0, 20));
    } catch (failure) {
      if (alive.current) setError(`${failure.message} Aucun ordre ni alerte exécuté. Retrouvez le suivi ou réessayez la même demande.`);
    } finally { if (alive.current) setBusy(false); }
  };
  const launch = () => {
    try {
      const request = pending || {
        request_id: newChronosRequestId(), symbols, period, volatility_threshold_pct: Number(threshold),
      };
      setPending(request);
      void operation(ROOT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
    } catch (failure) { setError(failure.message); }
  };
  const rules = current?.steps.find((step) => step.id === "rules")?.output;
  const summary = current?.steps.find((step) => step.id === "summary")?.output;

  return <section className="numm-tech numm-tech-card" data-testid="ariane-market-runs">
    <h2>{auditOnly ? "NÉMÉSIS · traces ARIANE / PORTUS" : "ARIANE · parcours financier exécutable"}</h2>
    <p>Lectures PORTUS en parallèle → règles déterministes → synthèse. Chaque étape terminée est conservée ;
      une reprise ne relit que les étapes manquantes.</p>
    <p>Analyse des actions choisies, pas d'un portefeuille personnel. Aucune alerte, notification, récurrence ou opération boursière créée.</p>
    <p>Ce suivi et ses preuves sont enregistrés dans le service SIRIUS connecté, pour votre compte, séparément des listes manuelles
      locales et de leur sauvegarde. Utilisez l'export des preuves pour conserver les résultats du parcours.</p>
    {!auditOnly && <fieldset disabled={busy || !!pending} className="numm-tech-choices">
      <legend>Préparer une analyse en lecture seule</legend>
      {["AAPL", "MSFT", "NVDA", "TSLA"].map((symbol) => <label key={symbol}><input type="checkbox"
        checked={symbols.includes(symbol)} onChange={() => setSymbols((previous) => previous.includes(symbol)
          ? previous.filter((item) => item !== symbol) : [...previous, symbol])} />{symbol}</label>)}
      <label>Période <select value={period} onChange={(event) => setPeriod(event.target.value)}>
        <option value="1m">1 mois</option><option value="3m">3 mois</option><option value="1y">1 an</option><option value="5y">5 ans</option>
      </select></label>
      <label>Seuil de volatilité annualisée (%) <input type="number" min="0.01" max="1000" step="0.01"
        value={threshold} onChange={(event) => setThreshold(event.target.value)} /></label>
    </fieldset>}
    {!auditOnly && <button type="button" disabled={busy || !symbols.length || !(Number(threshold) > 0 && Number(threshold) <= 1000)}
      onClick={launch}>{pending ? "Réessayer la même demande" : "Lancer les lectures et calculs"}</button>}
    {pending && <p>Référence de demande : {pending.request_id}. Conservez-la si la réponse est interrompue ; la même demande ne crée pas de doublon.</p>}
    {busy && <p role="status">Parcours en cours. Les résultats terminés restent enregistrés en cas de coupure.</p>}
    {error && <p role="alert">{error}</p>}
    <h3>Parcours enregistrés · vingt derniers au maximum</h3>
    {!runs.length && <p>Aucun parcours chargé.</p>}
    <ul>{runs.map((run) => <li key={run.id}><button type="button" disabled={busy}
      onClick={() => operation(`${ROOT}/${run.id}`)}>Suivi {run.id}</button> · {run.config.symbols.join(", ")} · {run.created_at}</li>)}</ul>
    {current && <section>
      <h3>Référence {current.id} · {LABELS[current.state] || current.state}</h3>
      <button type="button" onClick={() => {
        try { downloadWorkJson(JSON.stringify(current, null, 2), `ariane-preuves-${current.id}.json`); }
        catch (failure) { setError(failure.message || "Export des preuves impossible."); }
      }}>Exporter les résultats et preuves JSON</button>
      <p>Expiration de reprise : {current.expires_at}. Les étapes déjà terminées gardent leurs dates et leurs données d'origine :
        reprendre ne signifie pas actualiser toute l'analyse.</p>
      {!auditOnly && current.state !== "COMPLETED" && current.state !== "EXPIRED" && <button type="button"
        disabled={busy} onClick={() => operation(`${ROOT}/${current.id}/resume`, { method: "POST" })}>Reprendre les étapes manquantes</button>}
      <ol>{current.steps.map((step) => <li key={step.id}>
        <strong>{step.id}</strong> · {LABELS[step.state] || step.state}
        {step.output?.source && <details><summary>Sources, valeurs et méthode</summary>
          <p><a href={step.output.source_url} target="_blank" rel="noreferrer">{step.output.source}</a> · séance {step.output.as_of}
            {" · "}{step.output.currency} · reçu {step.output.fetched_at}</p>
          <p>Volatilité historique : {step.output.volatility_20d_annualized_pct ?? "indisponible"} % · données {step.output.data_version}</p>
          <p>Calcul {step.output.calculation_version} · paramètres {JSON.stringify(step.output.calculation_parameters)}</p>
          {step.snapshot_age_calendar_days > 7 && <p role="alert">Historique ancien : il ne représente pas un cours actuel.</p>}
        </details>}
      </li>)}</ol>
      {summary && <p>{summary.text}</p>}
      {!summary && <p>Analyse incomplète : les étapes manquantes empêchent le bilan final. Aucun résultat global de réussite n'est annoncé.</p>}
      {rules && <><h3>Conditions vérifiées</h3><p>Seuil strict : volatilité &gt; {rules.rule_parameters.volatility_threshold_pct} %.</p>
        <ul>{rules.findings.map((finding) => <li key={finding.symbol}>{finding.symbol} : {finding.observed} % &gt; {finding.threshold} % · {finding.explanation}</li>)}</ul>
        {!rules.findings.length && <p>Aucun dépassement de cette règle précise. Cela ne signifie pas absence de risque.</p>}
        {rules.missing.map((item, index) => <p key={`${item.symbol}-${index}`}>{item.symbol} · {item.reason}</p>)}
      </>}
      <details><summary>Journal NÉMÉSIS des étapes</summary>
        <ol>{current.trace.map((event) => <li key={event.id}>{event.at} · {event.step} · {LABELS[event.outcome] || event.outcome}
          {event.reason && ` · ${event.reason}`}</li>)}</ol>
        {current.trace_truncated && <p>Journal partiel : cent derniers événements.</p>}
      </details>
    </section>}
  </section>;
}
