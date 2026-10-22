import { useCallback, useEffect, useRef, useState } from "react";

const euros = (cents) => (cents / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });

export default function BudgetLabWorkspace({ request, auditOnly = false }) {
  const [text, setText] = useState("date,label,amount,currency\n");
  const [history, setHistory] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [consent, setConsent] = useState(false);
  const [shadowConsent, setShadowConsent] = useState(false);
  const locked = useRef(false);
  const lifecycle = useRef(null);

  const load = useCallback(async (signal) => {
    const [saved, limits] = await Promise.all([
      request("/budget/history", { signal }), request("/lab/policy", { signal }),
    ]);
    if (!Array.isArray(saved.analyses) || !Array.isArray(saved.decisions) || !Array.isArray(saved.experiments)
      || typeof limits.cerebras?.enabled !== "boolean" || typeof limits.cerebras?.reason !== "string")
      throw new Error("Suivi budget/laboratoire incomplet.");
    if (!signal.aborted) { setHistory(saved); setPolicy(limits); }
  }, [request]);
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    locked.current = true; setBusy(true);
    void load(controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setError(cause.message || "Chargement impossible.");
    }).finally(() => {
      if (!controller.signal.aborted) { locked.current = false; setBusy(false); }
    });
    return () => controller.abort();
  }, [load]);

  const operation = async (action) => {
    if (locked.current) return;
    const signal = lifecycle.current.signal;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(signal); }
    catch (cause) { if (!signal.aborted) setError(cause.message || "Opération impossible."); }
    finally { if (!signal.aborted) { locked.current = false; setBusy(false); } }
  };
  const analyze = () => operation(async (signal) => {
    const saved = await request("/budget/analyze", { method: "POST", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!saved.id || !Array.isArray(saved.months) || !Array.isArray(saved.candidates) || !Array.isArray(saved.limitations))
      throw new Error("Analyse incomplète ; consultez l'historique avant de réessayer.");
    if (!signal.aborted) setAnalysis(saved);
    await load(signal);
    if (!signal.aborted) setNotice("Analyse enregistrée. Aucun abonnement ni virement modifié.");
  });
  const usage = (candidate, used) => operation(async (signal) => {
    const result = await request(`/budget/${analysis.id}/usage/${candidate.id}`, { method: "PUT", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ used }) });
    if (result.executed !== false || typeof result.recommendation !== "string")
      throw new Error("Décision non vérifiable ; actualisez le suivi.");
    await load(signal);
    if (!signal.aborted) setNotice(result.recommendation);
  });
  return <section aria-label="Budget personnel et laboratoire">
    <h3>Budget personnel · EUR · recommandations uniquement</h3>
    <p>Les analyses sont conservées dans le service SIRIUS connecté, par compte. Le CSV brut n'est pas conservé :
      seuls les totaux, les libellés récurrents et leurs preuves sont enregistrés. Aucune transmission à Cerebras.</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <button type="button" disabled={busy} onClick={() => operation((signal) => load(signal))}>Actualiser budget et laboratoire</button>
    {!auditOnly && <fieldset disabled={busy}>
      <legend>Importer un relevé CSV normalisé</legend>
      <p>En-tête exact : date,label,amount,currency. Dates AAAA-MM-JJ, virgule comme séparateur, point décimal,
        débits négatifs, crédits positifs, EUR seulement, 2 000 lignes maximum.
        Vérifiez les doublons dans le fichier source ; les imports ne sont jamais additionnés entre eux.</p>
      <label>Fichier CSV <input type="file" accept=".csv,text/csv" onChange={(event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        void operation(async (signal) => {
          if (file.size > 200000) throw new Error("Fichier trop volumineux : 200 Ko maximum.");
          const content = await file.text();
          if (!signal.aborted) { setText(content); setAnalysis(null); }
        });
        event.target.value = "";
      }} /></label>
      <label>Contenu du relevé <textarea rows={6} value={text} maxLength={200000}
        onChange={(event) => { setText(event.target.value); setAnalysis(null); }} /></label>
      <button type="button" onClick={analyze}>Analyser et enregistrer ce relevé</button>
    </fieldset>}
    {history && <>
      <h4>Historique · vingt dernières analyses et essais, cent décisions récentes</h4>
      {!history.analyses.length && <p>Aucune analyse budgétaire.</p>}
      <ul>{history.analyses.map((item) => <li key={item.id}>
        <button type="button" disabled={busy} onClick={() => setAnalysis(item)}>
          Relevé du {item.first_date} au {item.last_date} · {item.transaction_count} opérations
        </button>
      </li>)}</ul>
    </>}
    {analysis && <>
      <h4>Solde des opérations importées, pas du compte bancaire</h4>
      <ul>{analysis.months.map((month) => <li key={month.month}>{month.month} · entrées {euros(month.income_cents)}
        {" · sorties "}{euros(month.expenses_cents)} · différence {euros(month.net_cents)}</li>)}</ul>
      {analysis.limitations.map((message) => <p key={message}>{message}</p>)}
      <h4>Récurrences possibles · confirmation humaine de l'usage</h4>
      {!analysis.candidates.length && <p>Aucune récurrence correspondant aux critères ; cela ne prouve pas l'absence d'abonnements.</p>}
      <ul>{analysis.candidates.map((candidate) => {
        const decision = history?.decisions.find((item) => item.analysis_id === analysis.id && item.candidate_id === candidate.id);
        return <li key={candidate.id}>
          <strong>{candidate.label}</strong> · {candidate.occurrences} débits · estimation mensuelle {euros(candidate.monthly_cents)}
          <p>{candidate.evidence} Du {candidate.first_date} au {candidate.last_date}.</p>
          {decision && <p>Usage déclaré : {decision.used ? "utilisé" : "inutilisé"}. {decision.recommendation}
            {" "}Économie annuelle potentielle, non garantie : {euros(decision.potential_annual_cents)}. Rien exécuté.</p>}
          {!auditOnly && <>
            <button type="button" disabled={busy} onClick={() => usage(candidate, true)}>Je confirme l'utiliser</button>
            <button type="button" disabled={busy} onClick={() => usage(candidate, false)}>Je confirme ne plus l'utiliser</button>
          </>}
        </li>;
      })}</ul>
    </>}
    <h3>Laboratoire technique volontaire · budget 0 €</h3>
    <p>{policy?.cerebras.reason || "Chargement des limites du laboratoire."}</p>
    <p>Banc d'essai dans le processus serveur, pas un bac à sable système : six exemples CSV fictifs fixes,
      deux parseurs prédéfinis. Aucun réseau, code généré, secret, changement de code ou déploiement.
      Les essais manuels et la veille périodique sont séparés.</p>
    <h4>Veille shadow locale · propositions uniquement</h4>
    <p>Catalogue autorisé : découpage naïf et parseur CSV strict, sans découverte Internet ni nouvelle API.
      Après activation, un essai au plus toutes les 24 heures, premier essai après 24 heures,
      uniquement si le service connecté est allumé. Aucun rattrapage massif, aucun appel Cerebras.</p>
    <p>État : {history?.shadow?.enabled ? "activée" : "désactivée"}.
      {history?.shadow?.next_run_at && ` Prochain essai au plus tôt : ${history.shadow.next_run_at}.`}</p>
    {!auditOnly && <fieldset disabled={busy || !history}>
      <legend>Autorisation persistante de veille locale</legend>
      {!history?.shadow?.enabled && <label><input type="checkbox" checked={shadowConsent}
        onChange={(event) => setShadowConsent(event.target.checked)} />
        J'autorise les essais quotidiens fictifs et leurs propositions, sans modification du code</label>}
      <button type="button" disabled={!history?.shadow?.enabled && !shadowConsent} onClick={() => operation(async (signal) => {
        const result = await request("/lab/shadow", { method: "PUT", signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !history.shadow?.enabled }) });
        if (typeof result.enabled !== "boolean") throw new Error("État de veille non vérifiable ; actualisez le suivi.");
        await load(signal);
        if (!signal.aborted) { setShadowConsent(false); setNotice(result.enabled ? "Veille locale autorisée." : "Veille locale arrêtée. Les résultats déjà enregistrés sont conservés."); }
      })}>{history?.shadow?.enabled ? "Arrêter la veille shadow" : "Activer la veille shadow locale"}</button>
    </fieldset>}
    {!auditOnly && <fieldset disabled={busy || !policy}>
      <legend>Autorisation d'un seul essai local</legend>
      <label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        J'autorise cet essai local sur données fictives</label>
      <button type="button" disabled={!consent} onClick={() => operation(async (signal) => {
        setConsent(false);
        const result = await request("/lab/local", { method: "POST", signal });
        if (!result.id || result.cost_eur !== 0 || result.external_calls !== 0 || !Array.isArray(result.results))
          throw new Error("Résultat du laboratoire incomplet ; actualisez le journal.");
        await load(signal);
        if (!signal.aborted) setNotice("Essai enregistré, coût 0 €, aucun appel externe ni code modifié.");
      })}>Lancer cet essai local</button>
    </fieldset>}
    <ul>{history?.experiments.map((run) => <li key={run.id}>
      {run.created_at} · {run.mode === "shadow" ? "Veille shadow" : "Essai manuel"} · {run.state || "COMPLETED"}
      {run.cost_eur != null && <> · {run.cost_eur} € · {run.external_calls} appel externe</>}
      {run.state === "RUNNING" && <p>Essai engagé, résultat non confirmé. Une interruption du serveur peut empêcher sa finalisation.</p>}
      {run.error && <p role="alert">{run.error}</p>}
      <ul>{run.results?.map((result) => <li key={result.tool}>{result.tool} : {result.correct}/{result.cases} cas corrects
        {" · "}{result.elapsed_ms} ms</li>)}</ul><p>{run.scope}</p>
      {run.proposal && <p>Proposition : {run.proposal} Aucun correctif appliqué.</p>}
    </li>)}</ul>
  </section>;
}
