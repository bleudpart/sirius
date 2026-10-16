import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { localTimeCandidates, newChronosRequestId } from "./chronos";
import { downloadWorkJson } from "./workModuleBackup";
import "./NummariusAnalytics.css";
import "./FinanceWorkspace.css";

const ROOT = `${API_BASE_URL}/nummarius`;
const SYMBOLS = ["AAPL", "MSFT", "NVDA", "TSLA"];
const CONDITIONS = { price_above: "Clôture au-dessus de", price_below: "Clôture au-dessous de",
  variation_above: "Variation journalière au-dessus de (%)", cross_above_mm200: "Franchissement MM200 à la hausse",
  cross_below_mm200: "Franchissement MM200 à la baisse" };
const number = (value) => value == null ? "indisponible" : value.toLocaleString("fr-FR", { maximumFractionDigits: 2 });

async function request(path, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 35000);
  try {
    const response = await fetch(`${ROOT}${path}`, { credentials: "include", ...options, signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Demande financière refusée ; vérifiez les champs.");
    return result;
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}

export default function FinanceWorkspace({ routinesOnly = false, auditOnly = false }) {
  const [overview, setOverview] = useState(null);
  const [valuation, setValuation] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [recovery, setRecovery] = useState("");
  const [rows, setRows] = useState([{ symbol: "AAPL", quantity: "1", average_cost: "0" }]);
  const [csv, setCsv] = useState("symbol,quantity,average_cost,currency\nAAPL,1,100,USD");
  const [symbol, setSymbol] = useState("AAPL");
  const [condition, setCondition] = useState("price_above");
  const [threshold, setThreshold] = useState("200");
  const [start, setStart] = useState("");
  const [recurrence, setRecurrence] = useState("daily");
  const [period, setPeriod] = useState("1y");
  const [routineSymbols, setRoutineSymbols] = useState(["AAPL"]);
  const [volatility, setVolatility] = useState("30");
  const attempt = useRef(null);
  const alive = useRef(false);
  const locked = useRef(false);

  const load = useCallback(async (signal) => {
    const [summary, portfolio] = await Promise.all([
      request("/workspace", { signal }),
      !routinesOnly && !auditOnly ? request("/portfolio", { signal }) : null,
    ]);
    if (!summary.alerts?.items || !summary.routines?.items || !Array.isArray(summary.notifications) || !Array.isArray(summary.events)
      || (portfolio && !Array.isArray(portfolio.positions))) throw new Error("Réponse financière incomplète ; aucune réussite supposée.");
    if (!signal?.aborted && alive.current) { setOverview(summary); setValuation(portfolio); }
  }, [routinesOnly, auditOnly]);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void load(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => { alive.current = false; controller.abort(); };
  }, [load]);

  const operation = async (action) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (cause) { if (alive.current) setError(cause.message || "Opération impossible. Conservez la référence et réessayez."); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  const stage = (action, csvText) => operation(async () => {
    const saved = attempt.current || { path: csvText !== undefined ? "/portfolio/csv/preview" : "/actions/preview",
      body: { request_id: newChronosRequestId(), ...(csvText !== undefined ? { text: csvText } : { action }) } };
    attempt.current = saved;
    const result = await request(saved.path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(saved.body) });
    if (!result.id || result.state !== "WAITING_CONFIRMATION" || !result.action) throw new Error("Aperçu financier incomplet.");
    if (alive.current) setPreview(result);
  });
  const confirm = () => operation(async () => {
    const result = await request(`/actions/${preview.id}/confirm`, { method: "POST" });
    if (result.state !== "COMPLETED" || !result.result?.id) throw new Error("Résultat non vérifiable ; consultez le suivi.");
    if (!alive.current) return;
    setPreview(null); attempt.current = null; setNotice("Modification confirmée et enregistrée. Aucun ordre de bourse transmis.");
    await load();
  });
  const clear = () => { setPreview(null); attempt.current = null; setError(""); setNotice("Aperçu fermé sans nouvelle confirmation ; un résultat déjà confirmé reste enregistré."); };
  const resumePreview = () => operation(async () => {
    const result = await request(`/actions/${recovery.trim()}`);
    if (!result.id || !result.action || result.state !== "WAITING_CONFIRMATION") throw new Error("Aperçu incomplet.");
    if (alive.current) setPreview(result);
  });
  const disabled = busy || !!preview || !!attempt.current;

  return <section className="numm-tech numm-tech-card finance-workspace" data-testid="finance-workspace">
    <h2>{auditOnly ? "NÉMÉSIS · décisions et surveillances financières" : routinesOnly ? "CHRONOS → ARIANE → PORTUS" : "Portefeuille, surveillances et routines"}</h2>
    <p>Données du compte dans le service SIRIUS connecté. Aucun ordre, courtier, courriel ni push externe.
      Les routines et surveillances nécessitent que ce serveur soit allumé ; notifications ci-dessous.</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <button type="button" disabled={busy} onClick={() => operation(() => load())}>Actualiser le suivi financier</button>
    {!auditOnly && <>
      <label>Retrouver un aperçu par sa référence <input value={recovery} disabled={busy}
        onChange={(event) => setRecovery(event.target.value)} /></label>
      <button type="button" disabled={busy || !/^[a-f0-9]{32}$/.test(recovery.trim())}
        onClick={resumePreview}>Retrouver cet aperçu</button>
      {attempt.current && !preview && <div role="group" aria-label="Reprendre la préparation">
        <p>Référence de demande : {attempt.current.body.request_id}. Réessayez le même aperçu après une coupure.</p>
        <button type="button" disabled={busy} onClick={() => stage()}>Réessayer le même aperçu</button>
        <button type="button" disabled={busy} onClick={clear}>Abandonner cette préparation</button>
      </div>}
      {preview && <div role="group" aria-label="Confirmation financière">
        <h3>WAITING_CONFIRMATION · {preview.id}</h3>
        <p>{preview.summary}</p><p>Valable jusqu'au {preview.expires_at}. Une réponse perdue se reprend avec cette même référence.</p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(preview.action, null, 2)}</pre>
        <button type="button" disabled={busy} onClick={confirm}>Confirmer cet aperçu financier</button>
        <button type="button" disabled={busy} onClick={clear}>Fermer sans confirmer</button>
      </div>}
      {!routinesOnly && <fieldset disabled={disabled}><legend>Positions manuelles · remplacement intégral après confirmation</legend>
        <p>Quatre actions, USD uniquement. Coût moyen à saisir frais inclus. Une liste vide efface les positions déclarées, sans vente.</p>
        {rows.map((row, index) => <div key={index}>
          <label>Action <select value={row.symbol} onChange={(event) => setRows(rows.map((p, i) => i === index ? { ...p, symbol: event.target.value } : p))}>
            {SYMBOLS.map((item) => <option key={item}>{item}</option>)}</select></label>
          {["quantity", "average_cost"].map((field) => <label key={field}>{field === "quantity" ? "Quantité" : "Coût moyen USD"}
            <input type="number" min={field === "quantity" ? "0.000001" : "0"} step="any" value={row[field]}
              onChange={(event) => setRows(rows.map((p, i) => i === index ? { ...p, [field]: event.target.value } : p))} /></label>)}
          <button type="button" onClick={() => setRows(rows.filter((_p, i) => i !== index))}>Retirer la ligne {index + 1}</button>
        </div>)}
        <button type="button" disabled={rows.length >= 4} onClick={() => setRows([...rows, { symbol: "MSFT", quantity: "1", average_cost: "0" }])}>Ajouter une ligne</button>
        <button type="button" onClick={() => stage({ kind: "portfolio", positions: rows.map((p) => ({
          ...p, quantity: p.quantity.trim() ? Number(p.quantity) : null, average_cost: p.average_cost.trim() ? Number(p.average_cost) : null, currency: "USD",
        })) })}>Prévisualiser le remplacement</button>
        <label>CSV des positions (virgules, point décimal, maximum quatre lignes)
          <textarea rows={5} value={csv} onChange={(event) => setCsv(event.target.value)} /></label>
        <label>Lire un fichier CSV <input type="file" accept=".csv,text/csv" onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void operation(async () => {
            if (file.size > 100_000) throw new Error("CSV limité à 100 ko ; aucun import effectué.");
            const text = await file.text();
            if (alive.current) setCsv(text);
          });
        }} /></label>
        <button type="button" onClick={() => stage(null, csv)}>Prévisualiser le CSV</button>
      </fieldset>}
      {!routinesOnly && <fieldset disabled={disabled}><legend>Nouvelle surveillance confirmée</legend>
        <label>Action surveillée <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>{SYMBOLS.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>Condition <select value={condition} onChange={(e) => setCondition(e.target.value)}>{Object.entries(CONDITIONS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        {!condition.includes("mm200") && <label>Seuil USD ou % <input type="number" min="0.01" step="any" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>}
        <p>Évaluation toutes les quinze minutes sur clôtures journalières. Une notification maximum par règle et séance ; pas un cours en direct.</p>
        <button type="button" onClick={() => stage({ kind: "alert", symbol, condition,
          threshold: condition.includes("mm200") ? null : threshold.trim() ? Number(threshold) : null })}>Préparer la surveillance</button>
      </fieldset>}
      <fieldset disabled={disabled}><legend>Routine CHRONOS en lecture seule</legend>
        <p>Choisissez explicitement les actions à analyser. Les changements de portefeuille ne modifient pas la routine.</p>
        <label>Actions de la routine <select multiple aria-label="Actions de la routine" value={routineSymbols}
          onChange={(e) => setRoutineSymbols([...e.target.selectedOptions].map((o) => o.value))}>
          {SYMBOLS.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>Premier déclenchement (heure locale de cet appareil)
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>Récurrence <select value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
          <option value="once">Une fois</option><option value="daily">Toutes les 24 heures UTC</option><option value="weekly">Tous les 7 jours UTC</option>
        </select></label>
        <label>Période <select value={period} onChange={(e) => setPeriod(e.target.value)}>
          <option value="1m">1 mois</option><option value="3m">3 mois</option><option value="1y">1 an</option><option value="5y">5 ans</option>
        </select></label>
        <label>Seuil de volatilité (%) <input type="number" min="0.01" max="1000" value={volatility} onChange={(e) => setVolatility(e.target.value)} /></label>
        <p>L'aperçu affiche l'heure UTC exacte. Au changement d'heure, l'heure locale peut décaler. Après coupure, seule la dernière échéance est traitée.</p>
        <button type="button" onClick={() => {
          const candidates = localTimeCandidates(start);
          if (candidates.length !== 1) { setError("Heure invalide ou ambiguë au changement d'heure ; choisissez un autre créneau."); return; }
          const stamp = candidates[0];
          void stage({ kind: "routine", symbols: routineSymbols, period,
            start_at: stamp.toISOString(), recurrence, volatility_threshold_pct: volatility.trim() ? Number(volatility) : null });
        }}>Préparer la routine CHRONOS</button>
      </fieldset>
    </>}
    {valuation && <section>
      <h3>Positions déclarées · {valuation.state} · USD</h3>
      <div className="numm-tech-table-wrap"><table className="numm-tech-table"><thead><tr><th>Action</th><th>Quantité</th><th>Valeur USD</th><th>Gain latent USD</th><th>Poids %</th><th>Source</th></tr></thead>
        <tbody>{valuation.positions.map((p) => <tr key={p.symbol}><th>{p.symbol}</th><td>{number(p.quantity)}</td><td>{number(p.value)}</td>
          <td>{number(p.unrealized_pnl)}</td><td>{number(p.weight_pct)}{p.weight_pct > 35 ? " · concentration > 35 %" : ""}</td>
          <td>{p.source ? <><a href={p.source.source_url} target="_blank" rel="noreferrer">{p.source.source}</a> · {p.source.as_of}
            {p.source.age_calendar_days > 7 && " · source ancienne"}</> : "Donnée indisponible"}</td></tr>)}</tbody></table></div>
      <p>Total : {number(valuation.total_value)} USD · latent : {number(valuation.unrealized_pnl)} USD.
        Volatilité théorique : {number(valuation.volatility_pct)} % · baisse maximale théorique : {number(valuation.max_drawdown_pct)} %.</p>
      {valuation.series?.length > 1 && <svg viewBox="0 0 600 150" role="img" aria-label="Historique théorique du portefeuille à quantités constantes">
        <polyline fill="none" stroke="currentColor" strokeWidth="2" points={(() => {
          const values = valuation.series.map((p) => p.value), low = Math.min(...values), span = Math.max(...values) - low || 1;
          return values.map((v, i) => `${i / (values.length - 1) * 600},${145 - (v - low) / span * 140}`).join(" ");
        })()} /></svg>}
      {valuation.limitations.map((text) => <p key={text}>{text}</p>)}
      <button type="button" onClick={() => {
        try { downloadWorkJson(JSON.stringify(valuation, null, 2), "portus-positions-et-sources.json"); }
        catch (cause) { setError(cause.message || "Export impossible."); }
      }}>Exporter positions et calculs</button>
    </section>}
    {overview && <>
      {["alerts", "routines"].filter((kind) => !routinesOnly || kind === "routines").map((kind) => <section key={kind}>
        <h3>{kind === "alerts" ? "Surveillances" : "Routines CHRONOS"}</h3>
        {overview[kind].truncated && <p>Liste limitée aux cent dernières configurations.</p>}
        {!overview[kind].items.length && <p>Aucune configuration enregistrée.</p>}
        <ul>{overview[kind].items.map((item) => <li key={item.id}>
          {item.id} · {item.symbol || item.symbols.join(", ")} · {item.disabled ? "Suspendu" : "Autorisé"} · {item.condition || item.recurrence}
          {item.start_at && ` · début ${item.start_at}`}
          {!auditOnly && !item.disabled && <button type="button" disabled={disabled} onClick={() => stage({ kind: "disable",
            target_kind: kind === "alerts" ? "alert" : "routine", target_id: item.id })}>Préparer la suspension</button>}
        </li>)}</ul>
      </section>)}
      <h3>Notifications financières · cent dernières</h3>
      {!overview.notifications.length && <p>Aucune notification enregistrée.</p>}
      <ul>{overview.notifications.map((item) => <li key={item.id}>{item.created_at} · {item.text}
        <details><summary>Données ayant déclenché ce message</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(item.evidence, null, 2)}</pre></details>
      </li>)}</ul>
      <details open={auditOnly}><summary>Journal NÉMÉSIS · cent derniers événements financiers</summary>
        <ul>{overview.events.map((item) => <li key={item.id}>{item.at} · {item.outcome} · {item.summary}
          {item.evidence && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(item.evidence, null, 2)}</pre>}</li>)}</ul>
      </details>
    </>}
  </section>;
}
