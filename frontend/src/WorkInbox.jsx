import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { newChronosRequestId, localTimeCandidates } from "./chronos";
import "./WorkInbox.css";

const LABELS = { COMPLETED: "Terminé", PENDING: "À préparer", BLOCKED: "Bloqué",
  WAITING_CONFIRMATION: "À valider", RUNNING: "En cours", CANCELLED: "Arrêté",
  EXPIRED: "Expiré", SKIPPED: "Ignoré", SCHEDULED: "Programmé", DUE: "Échéance atteinte",
  RESOLVED: "Facture soldée ou refusée", UNAVAILABLE: "À vérifier", ACCOUNT_UNAVAILABLE: "Compte indisponible" };
async function read(response) {
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(typeof data.detail === "string" ? data.detail : "Opération refusée ; vérifiez les champs.");
    error.status = response.status;
    throw error;
  }
  return data;
}
function isoFromLocal(value) {
  const candidates = localTimeCandidates(value);
  if (candidates.length !== 1) throw new Error("Horaire absent ou ambigu au changement d'heure ; choisissez une autre heure.");
  return new Date(candidates[0]).toISOString();
}

export default function WorkInbox({ dossierId = "", invoices = [], onSelectDossier }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const [due, setDue] = useState("");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(null);
  const [stop, setStop] = useState(null);
  const [filter, setFilter] = useState("attention");
  const locked = useRef(false);
  const alive = useRef(true);
  const controllers = useRef(new Set());
  const pendingRef = useRef(null);
  const loadVersion = useRef(0);

  const request = useCallback(async (path, options = {}) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 130000);
    try {
      return await read(await fetch(`${API_BASE_URL}${path}`, { credentials: "include", ...options, signal: controller.signal }));
    } catch (failure) {
      if (failure.name === "AbortError") throw new Error("Réponse interrompue. Consultez le même parcours ; un envoi peut avoir eu lieu.");
      throw failure;
    } finally { clearTimeout(timer); controllers.current.delete(controller); }
  }, []);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    let result;
    try {
      result = await request("/work-hub");
    } catch (error) {
      if (alive.current && version === loadVersion.current) throw error;
      return;
    }
    if (!alive.current || version !== loadVersion.current) return;
    if (!result.workspace_id || !Array.isArray(result.runs) || !result.metrics) throw new Error("Boîte de travail incomplète.");
    if (alive.current && version === loadVersion.current) setData(result);
    return result;
  }, [request]);

  useEffect(() => {
    alive.current = true;
    const active = controllers.current;
    let loading = false;
    const refresh = async () => {
      if (loading || locked.current || document.visibilityState === "hidden") return;
      loading = true;
      try { await load(); }
      catch (failure) { if (alive.current) setError(failure.message); }
      finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 30000);
    const visible = () => { if (document.visibilityState !== "hidden") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    return () => {
      alive.current = false; clearInterval(timer);
      document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", visible);
      active.forEach((controller) => controller.abort()); active.clear();
    };
  }, [load]);

  const perform = async (path, body, creation = false) => {
    if (locked.current) return;
    loadVersion.current += 1;
    locked.current = true; setBusy(true); setError("");
    try {
      const result = await request(path, { method: "POST", headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!result.id || !Array.isArray(result.steps)) throw new Error("État du parcours incomplet.");
      if (alive.current) setStop(null);
      if (creation) { pendingRef.current = null; if (alive.current) setPending(null); }
      await load();
    } catch (failure) {
      if (creation && failure.status === 422) {
        pendingRef.current = null;
        if (alive.current) setPending(null);
      }
      if (alive.current) setError(`${failure.message} Ne recréez pas un envoi pour contourner une réponse perdue.`);
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  const prepare = (kind) => {
    if (locked.current) return;
    try {
      let operation = pendingRef.current;
      if (!operation) {
        const dueAt = isoFromLocal(due);
        if (new Date(dueAt) <= new Date()) throw new Error("Choisissez une échéance future.");
        if (kind === "invoice" && (!dossierId || !invoiceId)) throw new Error("Choisissez un dossier et une facture suivie.");
        if (kind === "reminder" && !text.trim()) throw new Error("Précisez le texte du rappel.");
        operation = { path: kind === "invoice" ? "/work-hub/invoice-followup" : "/work-hub/reminders",
          body: { request_id: newChronosRequestId(), ...(kind === "invoice"
            ? { dossier_id: dossierId, invoice_id: invoiceId, followup_at: dueAt } : { text: text.trim(), due_at: dueAt }) } };
        pendingRef.current = operation; setPending(operation);
      }
      void perform(operation.path, operation.body, true);
    } catch (failure) { setError(failure.message); }
  };
  const metric = data?.metrics;
  const visibleRuns = data?.runs.filter((run) => filter === "all" || !["COMPLETED", "CANCELLED"].includes(run.state)) || [];
  return <section className="work-inbox" aria-label="À traiter avec SIRIUS">
    <h2>À traiter avec SIRIUS</h2>
    <p>Préparer, valider, suivre : les mêmes parcours que dans ARIANE et la conversation.</p>
    <p>Service : {API_BASE_URL} · espace {data?.workspace_id || "en cours de vérification"}.</p>
    {data && <><p>{data.continuity}</p><p>{data.notification_limits}</p><p>Dernière lecture : {data.checked_at}.</p></>}
    <button type="button" disabled={busy} onClick={async () => {
      try { const result = await load(); if (result && alive.current) setError(""); }
      catch (failure) { if (alive.current) setError(failure.message); }
    }}>Actualiser À traiter</button>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Traitement en cours. Une réponse perdue ne signifie pas absence d'effet.</p>}
    {data?.business && <section aria-label="Signaux et validations des dossiers">
      <h3>Signaux métier et engagements</h3>
      {data.business.truncated && <p>Vue métier partielle : limites des registres atteintes.</p>}
      {data.business.missing_info.map((item, index) => <p key={index}>{item}</p>)}
      {data.business.proposals.map((proposal) => <details key={proposal.id}>
        <summary>{proposal.title}</summary><p>{proposal.reason}</p>
        <pre>{JSON.stringify(proposal.why_suggested, null, 2)}</pre>
        <p>À préparer depuis le dossier ou le module métier ; aucune action extérieure automatique.</p>
      </details>)}
      {!dossierId && onSelectDossier && <details><summary>Ouvrir un dossier pour préparer</summary>
        {data.business.dossiers.map((dossier) => <button type="button" key={dossier.id}
          onClick={() => onSelectDossier(dossier.id)}>Préparer dans {dossier.title}</button>)}
      </details>}
      {data.business.commitments.map((item) => <article key={`${item.entry_id}-${item.task_id || ""}`}>
        <strong>{item.text}</strong><p>Échéance : {item.due_date || "non précisée"} · responsable {item.owner || "non précisé"}.</p>
        {onSelectDossier && <button type="button" onClick={() => onSelectDossier(item.dossier_id)}>Consulter le dossier {item.dossier_id}</button>}
      </article>)}
      <h3>Validations et suivis de dossier</h3>
      {data.business.queue.map((item) => <details key={item.entry.id}>
        <summary>{item.stage === "to_confirm" ? "À relire" : "Suivi manuel"} · {item.entry.kind} · {item.dossier_id}</summary>
        {item.source_changed && <p>La source a changé ; nouvelle préparation nécessaire.</p>}
        <pre>{JSON.stringify(item.entry.content, null, 2)}</pre>
        <p>La validation de dossier n'autorise aucun envoi. Les envois Outlook sont des parcours distincts ci-dessous.</p>
        {onSelectDossier && <button type="button" onClick={() => onSelectDossier(item.dossier_id)}>Examiner la validation {item.entry.id}</button>}
      </details>)}
    </section>}
    <fieldset disabled={busy || !!pending}>
      <legend>Préparer une relance Outlook ou un rappel</legend>
      <label>Échéance du rappel / suivi (heure de cet appareil)<input type="datetime-local" value={due}
        onChange={(event) => setDue(event.target.value)} /></label>
      {dossierId && <>
        <label>Facture suivie dans ce dossier<select value={invoiceId} onChange={(event) => setInvoiceId(event.target.value)}>
          <option value="">Choisir une facture</option>
          {invoices.map((item) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}
        </select></label>
        <button type="button" disabled={!invoiceId || !due} onClick={() => prepare("invoice")}>Préparer la relance et son suivi</button>
      </>}
      {!dossierId && <p>Choisissez un dossier et une facture suivie dans Dossiers pour préparer une relance Outlook.</p>}
      <label>Texte du rappel<input maxLength={300} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <button type="button" disabled={!text.trim() || !due} onClick={() => prepare("reminder")}>Préparer ce rappel</button>
    </fieldset>
    {pending && <div><p>Référence de demande : {pending.body.request_id}. Réessayez uniquement cette référence.</p>
      <button type="button" disabled={busy} onClick={() => prepare("retry")}>Retrouver la même demande</button></div>}
    <label>Afficher<select value={filter} onChange={(event) => setFilter(event.target.value)}>
      <option value="attention">À valider, reprendre ou vérifier</option><option value="all">Tous les parcours consultés</option>
    </select></label>
    {data?.runs_truncated && <p>Liste limitée aux cent derniers parcours ; les plus anciens restent dans leur suivi par référence.</p>}
    {!visibleRuns.length && <p>Aucun parcours dans cette vue.</p>}
    {visibleRuns.map((run) => <article key={run.id}>
      <h3>{run.objective} · {LABELS[run.state] || run.state}</h3>
      <p>Référence {run.id} · reprise jusqu'au {run.expires_at}.</p>
      {run.steps.map((step) => <section key={step.id}>
        <strong>{step.id} · {LABELS[step.state] || step.state}</strong>
        {step.reason && <p>{step.reason}</p>}
        {step.receipt && <p>{step.receipt.reason} · preuve Microsoft {step.receipt.request_id || "indisponible"}.</p>}
        {step.approval && <p>Accord enregistré le {step.approval.confirmed_at}.</p>}
        {step.prepared && <details open><summary>Vérifier avant de valider</summary>
          {step.action === "work.invoice_send" ? <>
            <p>Compte Outlook : {step.prepared.inputs.sender}</p>
            <p>Destinataire : {step.prepared.inputs.to}</p>
            <p>Objet : {step.prepared.inputs.subject}</p>
            <pre>{step.prepared.inputs.readable_message || step.prepared.inputs.message}</pre>
            <p>Suivi interne à programmer : {step.prepared.inputs.followup_at}.</p>
            <p>{step.prepared.inputs.notice}</p>
            <p>Aperçu valable jusqu'au {step.prepared.inputs.expires_at}.</p>
            <details><summary>Sources, signature et données exactes</summary>
              <pre>{JSON.stringify(step.prepared.inputs, null, 2)}</pre>
            </details>
          </> : <pre>{JSON.stringify(step.prepared.inputs, null, 2)}</pre>}
          <p>Empreinte : {step.prepared.fingerprint}</p>
        </details>}
        {step.state === "WAITING_CONFIRMATION" && !["EXPIRED", "CANCELLED"].includes(run.state)
          && <button type="button" disabled={busy} onClick={() => perform(`/ariane/runs/${run.id}/steps/${step.id}/confirm`,
            { confirm: true, fingerprint: step.prepared.fingerprint })}>Valider uniquement {step.id} · {run.id}</button>}
      </section>)}
      {!["COMPLETED", "EXPIRED", "CANCELLED"].includes(run.state) && <>
        <button type="button" disabled={busy} onClick={() => perform(`/ariane/runs/${run.id}/resume`)}>Reprendre {run.id}</button>
        <button type="button" disabled={busy} onClick={() => setStop(run.id)}>Ignorer / arrêter {run.id}</button>
        {stop === run.id && <div role="group" aria-label="Confirmer l'arrêt du parcours">
          <p>Arrête les prochaines étapes, sans annuler un message engagé ni les rappels déjà créés.</p>
          <button type="button" disabled={busy} onClick={() => perform(`/ariane/runs/${run.id}/cancel`)}>Confirmer l'arrêt</button>
          <button type="button" onClick={() => setStop(null)}>Conserver</button>
        </div>}
      </>}
    </article>)}
    <h3>Rappels et surveillances</h3>
    {data?.reminders_truncated && <p>Cent derniers rappels uniquement.</p>}
    {data?.reminders.map((reminder) => <article key={reminder.id}><strong>{reminder.text}</strong>
      <p>{reminder.due_at} · {LABELS[reminder.state] || reminder.state}</p>
      {reminder.evidence && <pre>{JSON.stringify(reminder.evidence, null, 2)}</pre>}
      {reminder.state === "SCHEDULED" && <button type="button" disabled={busy}
        onClick={() => perform(`/work-hub/reminders/${reminder.id}/cancel-preview`)}>Préparer la suspension {reminder.id}</button>}
    </article>)}
    <h3>Notifications internes</h3>
    {data?.notifications_truncated && <p>Cent dernières notifications uniquement.</p>}
    {data?.notifications.map((notice) => <details key={notice.id}><summary>{notice.text} · {notice.created_at}</summary>
      <pre>{JSON.stringify(notice.evidence, null, 2)}</pre></details>)}
    {metric && <section aria-label="Résultats mesurés">
      <h3>Résultats mesurés, pas estimés</h3>
      <p>{metric.completed} / {metric.examined} parcours terminés · taux {metric.completion_rate_pct == null ? "non calculable" : `${metric.completion_rate_pct} %`}.</p>
      <p>{metric.waiting} accord(s) attendu(s), {metric.blocked} bloqué(s), {metric.cancelled} arrêté(s), {metric.expired} expiré(s).</p>
      <p>{metric.human_confirmations} validation(s) humaine(s) enregistrée(s) ;
        {" "}{metric.recovered_steps} étape(s) aboutie(s) après plusieurs tentatives ;
        {" "}{metric.send_reuse_steps} étape(s) ayant réutilisé une tentative d'envoi sans réenvoi.</p>
      <p>{metric.provider_accepted_all_time} envoi(s) accepté(s) par Microsoft ; {metric.provider_unknown_all_time} résultat(s) incertain(s).
        Accepté ne signifie pas livré.</p>
      <p>Temps cumulé mesuré des étapes terminées : {metric.measured_duration_ms} ms. Ce n'est pas le délai ressenti ni du temps économisé.</p>
      <p>Périmètre : {metric.scope}. Temps économisé et livraison : non mesurés.</p>
    </section>}
  </section>;
}
