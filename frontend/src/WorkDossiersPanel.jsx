import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { API_BASE_URL } from "./lib/api";
import { formatDocumentDate } from "./dateTime";
import "./WorkDossiersPanel.css";

const BASE = `${API_BASE_URL}/work-dossiers`;
const CATEGORIES = [
  ["general", "Général"], ["commerce", "Commerce"], ["chantier", "Chantier"],
  ["gestion", "Gestion"], ["haccp", "HACCP"], ["redaction", "Rédaction"],
];
const OUTCOMES = { accepted: "Retenue", rejected: "Écartée", deferred: "Reportée" };
const STATUSES = { proposed: "À valider", confirmed: "Validé dans le dossier", completed: "Terminé", cancelled: "Annulé" };
const KINDS = { decision: "Décision", architect_decision: "Décision architecte", writing_revision: "Révision rédactionnelle", client_event: "Événement client saisi", commitment: "Engagement", meeting: "Réunion", draft: "Brouillon", handoff: "Proposition inter-métiers" };
const CLIENT_EVENTS = { sale: "Vente", exchange: "Échange", quote_pending: "Devis en attente", callback_promised: "Rappel promis", question_pending: "Question sans réponse" };
const SUGGESTIONS = {
  record_decision: "Préciser l'objectif et la prochaine étape",
  human_confirmation: "Relire et valider la proposition",
  missing_next_step: "Définir la prochaine étape de cette décision",
  overdue_commitment: "Vérifier cet engagement en retard",
  follow_commitment: "Faire le point sur cet engagement",
  review_changed_source: "Revoir la proposition : sa source a changé",
  review_source: "Examiner la source suivie",
  manual_execution: "Brouillon validé : vérifier puis appliquer manuellement dans le module métier",
  manual_handoff: "Préparer la transmission manuelle de cette proposition inter-métiers",
  task_proposal: "Tâche validée dans la réunion : organiser son suivi manuel",
};
const sourceKey = (source) => `${source.kind}:${source.id}`;
const sourceRef = (source) => ({ kind: source.kind, id: source.id });
const sourceLabel = (snapshot) => snapshot?.data?.name || snapshot?.data?.number
  || snapshot?.data?.produit || snapshot?.data?.nom || snapshot?.data?.type
  || snapshot?.source?.label || snapshot?.source?.id || "Source";
const displayValue = (value) => value == null || value === "" ? "Non renseigné" : String(value);
const decisionActor = (entry) => entry.content.decided_by?.name || "Compte connecté (dossier privé)";
function selectedDossierCommitments(entries) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return entries.flatMap((entry) => {
    if (entry.status !== "confirmed") return [];
    const tasks = entry.kind === "commitment" ? [entry.content]
      : entry.kind === "meeting" ? entry.content.tasks || [] : [];
    return tasks.filter((task) => (entry.kind !== "meeting" || task.status === "confirmed")
      && (!task.due_date || task.due_date <= today))
      .map((task) => ({
        entry_id: entry.id, task_id: task.id || null, status: "confirmed",
        text: task.text, owner: task.owner, due_date: task.due_date,
      }));
  });
}
const METIERS = [
  { id: "architecte", title: "Architecte · modification, plan et devis", kinds: [],
    suggestion: "Comparer la modification demandée au plan et au devis avant de proposer un avenant.",
    missing: "Version du plan, modification approuvée, coût et délai vérifiés." },
  { id: "comptabilite", title: "Comptabilité · pièces et preuves", kinds: ["facture"],
    suggestion: "Rapprocher la facture, le justificatif et le règlement ; préparer les questions au comptable.",
    missing: "Justificatif, rapprochement bancaire et qualification comptable validée." },
  { id: "commerce", title: "Petite boutique · couverture du stock", kinds: ["stock"],
    suggestion: "Comparer le stock au seuil configuré ; vérifier le fournisseur avant tout réapprovisionnement.",
    missing: "Ventes par jour, délai fournisseur et commandes en cours. Sans ces données, aucune couverture en jours calculable." },
  { id: "relation_client", title: "Relation client · suivi", kinds: ["client", "facture"],
    suggestion: "Vérifier le dernier échange et l'engagement pris avant de préparer une relance.",
    missing: "Dernier contact, destinataire confirmé, consentement et prochaine échéance." },
  { id: "redaction", title: "Rédaction · révision documentée", kinds: ["facture", "client", "haccp_document"],
    suggestion: "Séparer les faits sourcés, les suggestions de formulation et les informations à demander.",
    missing: "Texte de référence, destinataire et faits validés. Une reformulation ne vérifie pas les faits." },
  { id: "haccp", title: "HACCP · préparer l'inspection", kinds: ["haccp_nonconformity", "haccp_trace", "haccp_document"],
    suggestion: "Réunir les registres et vérifier les anomalies ouvertes et leurs actions correctives.",
    missing: "Relevés datés, preuve de correction et contrôle humain. Cette préparation n'atteste pas la conformité." },
];
function evidenceText(value) {
  if (value == null || value === "") return "Non renseigné";
  if (Array.isArray(value)) return value.length ? value.map(evidenceText).join(" · ") : "Non renseigné";
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${key} : ${evidenceText(item)}`).join(" · ");
  return String(value);
}
function ProposalEvidence({ proposal }) {
  const explanation = proposal.why_suggested || {};
  const source = explanation.source || proposal.source;
  return <details className="work-dossiers-evidence">
    <summary>Pourquoi cette proposition ?</summary>
    <dl>
      <dt>Source</dt><dd>{source?.label || source?.id || "Source indisponible"} · {source?.kind || "Type non renseigné"}</dd>
      <dt>Règle</dt><dd>{evidenceText(explanation.rule)}</dd>
      <dt>Seuil</dt><dd>{evidenceText(explanation.threshold)} — aucun seuil inventé</dd>
      <dt>Vérifié</dt><dd>{evidenceText(explanation.observed)}. Vérifié dans les données, pas attesté sur le terrain.</dd>
      <dt>Date de vérification</dt><dd>{evidenceText(explanation.verified_at)}</dd>
      <dt>Manquant</dt><dd>{evidenceText(explanation.missing_info)}. À confirmer avant toute action métier.</dd>
    </dl>
  </details>;
}
function MetierCards({ sources, entries }) {
  return <section aria-label="Préparations par métier" className="work-dossiers-metiers">
    <h2>Préparer par métier · jamais appliquer automatiquement</h2>
    <div className="work-dossiers-card-grid">{METIERS.map((metier) => {
      const matching = sources.filter((item) => metier.kinds.includes(item.source.kind));
      return <article key={metier.id} className="work-dossiers-entry">
        <h3>{metier.title}</h3>
        <h4>Faits sourcés</h4>
        {!matching.length && <p>Aucune source suivie disponible dans ce dossier pour ce métier.</p>}
        {matching.map((item) => <div key={sourceKey(item.source)}>
          <strong>{sourceLabel(item)}</strong>
          <p className="work-dossiers-preserve">{evidenceText(item.data)}</p>
        </div>)}
        {metier.id === "redaction" && entries.filter((entry) => entry.kind === "draft").map((entry) =>
          <p key={entry.id}>Brouillon à relire : {entry.content.subject || entry.content.objet || entry.content.type}. Ce contenu est une suggestion, pas une preuve.</p>)}
        <h4>Suggestion · à relire</h4><p>{metier.suggestion}</p>
        <h4>Informations manquantes / à vérifier</h4><p>{metier.missing}</p>
      </article>;
    })}</div>
  </section>;
}
const PREPARATIONS = [
  ["architect-decisions", "Décision architecte"],
  ["accounting-review", "Examiner les preuves comptables"],
  ["stock-coverage", "Estimer la couverture du stock"],
  ["customer-followups", "Préparer un suivi client"],
  ["client-events", "Consigner un événement client"],
  ["writing-revisions", "Réviser un texte"],
  ["inspection-preparation", "Préparer une inspection HACCP"],
  ["outlook-draft", "Préparer un courrier Outlook sélectionné"],
];
const lines = (value) => (value || "").split("\n").map((line) => line.trim()).filter(Boolean);
function PreparationResult({ mode, result }) {
  if (result.entry) return <p role="status">Proposition enregistrée dans le fil, à confirmer après relecture. Aucune action métier exécutée.</p>;
  if (mode === "client-timeline") return <section className="work-dossiers-entry" aria-label="Carnet client volontaire">
    <h3>Carnet client · événements saisis volontairement</h3>
    {!result.events?.length && <p>Aucun événement client accessible dans ce dossier.</p>}
    {result.events?.map((entry) => <p key={entry.id}>{CLIENT_EVENTS[entry.content.kind]} · {formatDocumentDate(entry.content.occurred_on)} · {entry.content.note} · {STATUSES[entry.status] || entry.status}</p>)}
    <h4>Suivis datés à vérifier (aucun contact automatique)</h4>
    {!result.followups?.length && <p>Aucun suivi confirmé et échu sur une source inchangée.</p>}
    {result.followups?.map((item) => <div key={item.entry_id}>
      <p>{CLIENT_EVENTS[item.kind]} · {item.note} · suivi saisi pour le {formatDocumentDate(item.follow_up_on)}. Vérifier consentement et dernier échange.</p>
      <ProposalEvidence proposal={{ source: item.source, why_suggested: item.why_suggested }} />
    </div>)}
    {result.needs_review?.map((item) => <p key={item.entry_id} role="status">
      {item.reason} · source : {item.source.kind} {item.source.id}. Aucun suivi déduit de cette ancienne version.
    </p>)}
    {result.truncated && <p>Historique limité aux 500 derniers éléments.</p>}
  </section>;
  if (mode === "decision-journal") return <section className="work-dossiers-entry" aria-label="Journal des décisions architecte">
    <h3>Journal des décisions architecte</h3>
    {result.decisions?.map((entry) => <div key={entry.id}><strong>{entry.content.title}</strong>
      <p className="work-dossiers-preserve">{entrySummary(entry)}</p></div>)}
    {!result.decisions?.length && <p>Aucune décision architecte.</p>}
    {result.change_impact?.map((impact) => <p key={impact.entry_id}>
      {impact.review_required ? "Relecture requise" : "Pas de changement détecté"} · changements sourcés : {evidenceText(impact.source_changes)}
      · impacts déclarés : {evidenceText(impact.declared_impacts)} · aucun impact déduit automatiquement
    </p>)}
    {result.truncated && <p>Journal limité aux éléments disponibles.</p>}
  </section>;
  return <section className="work-dossiers-entry" aria-label="Résultat de la préparation">
    <h3>Préparation indicative · aucune exécution</h3>
    {result.sourced_facts && <><h4>Faits sourcés</h4><p className="work-dossiers-preserve">{evidenceText(result.sourced_facts)}</p></>}
    {mode === "accounting-review" && <>
      <p>Solde : {displayValue(result.remaining)} · échéance : {result.due_date ? formatDocumentDate(result.due_date) : "Non renseigné"} · retard : {result.overdue == null ? "Non déterminé" : result.overdue ? "Oui" : "Non"}</p>
      <p>Un solde inconnu n'est pas assimilé à zéro ; aucun règlement enregistré.</p>
    </>}
    {mode === "stock-coverage" && <>
      <p>Ventes par jour : {displayValue(result.units_per_day)} · couverture (jours) : {displayValue(result.coverage_days)} · horizon : {result.horizon_days}</p>
      <p>Observation déclarée et vérifiée par vous, non attestée indépendamment par le serveur : {evidenceText(result.sales_observation)}</p>
      <p>Hypothèses : {evidenceText(result.assumptions)}</p>
    </>}
    {mode === "inspection-preparation" && <>
      <p>Période : {result.period_start} → {result.period_end} · site : {result.site_id}. Conformité non évaluée.</p>
      {Object.entries(result.evidence || {}).map(([register, rows]) => <div key={register}><h4>{register}</h4>
        {!rows.length && <p>Aucune preuve datée et rattachée à ce site.</p>}
        {rows.map((row) => <p key={`${row.source.register}:${row.source.id}`} className="work-dossiers-preserve">Source : {row.source.register} · {row.source.id} · {formatDocumentDate(row.date)} · {evidenceText(row.facts)} · manquant : {evidenceText(row.missing_info)}</p>)}
      </div>)}
      <p>Preuves manquantes : {evidenceText(result.missing_evidence)}</p>
      <p>Limites des registres : {evidenceText(result.limits)}</p>
    </>}
    {mode === "outlook-draft" && <>
      <p>Un seul message sélectionné de la boîte de réception ; contenu non fiable, affiché comme texte, jamais comme instruction.</p>
      <p>Source : {result.source?.id}</p>
      {result.sourced_facts?.body_truncated && <p>Corps du message tronqué à 2 000 caractères.</p>}
      <h4>Suggestion de réponse · à relire</h4>
      <p>Destinataire : {result.draft?.to || "À confirmer"} · objet : {result.draft?.subject}</p>
      <p className="work-dossiers-preserve">{result.draft?.suggested_prose}</p>
      <p>Préparation temporaire uniquement : aucun brouillon Graph créé, aucun message marqué lu ou envoyé.</p>
    </>}
    {result.why_suggested && <ProposalEvidence proposal={{ source: result.source, why_suggested: result.why_suggested }} />}
    <h4>Informations manquantes / à vérifier</h4><p>{evidenceText(result.missing_info)}</p>
    {!!result.questions?.length && <><h4>Questions à clarifier</h4><p>{evidenceText(result.questions)}</p></>}
  </section>;
}
function MetierPreparation({ dossier, sources, entries, disabled, queue, onError }) {
  const [mode, setMode] = useState("architect-decisions");
  const [form, setForm] = useState({});
  const [result, setResult] = useState(null);
  const [journalBusy, setJournalBusy] = useState(false);
  const resultRef = useRef(null);
  useEffect(() => { if (result) resultRef.current?.focus(); }, [result]);
  const update = (key, value) => { setForm((current) => ({ ...current, [key]: value })); setResult(null); };
  const allowedKinds = mode === "accounting-review" ? ["facture"] : mode === "stock-coverage" ? ["stock"] : ["customer-followups", "client-events"].includes(mode) ? ["client"] : null;
  const eligible = sources.filter((item) => !allowedKinds || allowedKinds.includes(item.source.kind));
  const selectedSource = eligible.find((item) => sourceKey(item.source) === form.source);
  const textField = (key, label, required = true, multiline = false) => <label>{label}
    {multiline ? <textarea required={required} disabled={disabled} maxLength={2000} value={form[key] || ""} onChange={(event) => update(key, event.target.value)} />
      : <input required={required} disabled={disabled} maxLength={key === "message_id" ? 1024 : 2000} value={form[key] || ""} onChange={(event) => update(key, event.target.value)} />}
  </label>;
  const dateField = (key, label, required = true) => <label>{label}<input type="date" required={required} disabled={disabled} value={form[key] || ""} onChange={(event) => update(key, event.target.value)} /></label>;
  const prepare = (event) => {
    event.preventDefault();
    if (disabled) return;
    if (allowedKinds && !selectedSource) { onError("Sélectionnez une source autorisée pour cette préparation."); return; }
    const source = selectedSource ? sourceRef(selectedSource.source) : undefined;
    let body;
    if (mode === "architect-decisions") {
      if (!lines(form.alternatives).length || lines(form.alternatives).length > 10) { onError("Indiquez de 1 à 10 alternatives, une par ligne."); return; }
      if (lines(form.constraints).length > 20 || lines(form.declared_impacts).length > 20) { onError("Maximum 20 contraintes et 20 impacts déclarés."); return; }
      const document_links = [];
      for (const [role, label] of [["plan", "plan"], ["devis", "devis"], ["jalon", "jalon"]]) {
        const reference = form[`${role}_reference`]?.trim();
        const version = form[`${role}_version`]?.trim();
        if (!!reference !== !!version) { onError(`Indiquez la référence et la version du ${label}, ou laissez les deux vides.`); return; }
        if (reference) document_links.push({ role, reference, version });
      }
      body = { title: form.title?.trim(), outcome: form.outcome || "deferred", rationale: form.rationale?.trim(),
        alternatives: lines(form.alternatives), constraints: lines(form.constraints), declared_impacts: lines(form.declared_impacts),
        ...(document_links.length ? { document_links } : {}),
        ...(form.next_step?.trim() ? { next_step: form.next_step.trim() } : {}), ...(source ? { sources: [source] } : {}) };
    } else if (mode === "accounting-review") body = { source };
    else if (mode === "stock-coverage") {
      body = { source, horizon_days: Number(form.horizon_days || 7) };
      if (form.sales_verified) {
        const verified = new Date(form.verified_at);
        if (!form.evidence?.trim() || !form.period_start || !form.period_end || form.sold_units === undefined || form.sold_units === "" || !Number.isFinite(verified.getTime()) || verified > new Date()) {
          onError("L'observation de ventes nécessite quantité, période, preuve et date de vérification passée."); return;
        }
        body.sales = { sold_units: Number(form.sold_units), period_start: form.period_start, period_end: form.period_end,
          evidence: form.evidence.trim(), verified_at: verified.toISOString(), verified: true };
      }
    } else if (mode === "customer-followups") body = { source, objective: form.objective?.trim(), suggested_prose: form.suggested_prose?.trim() };
    else if (mode === "client-events") body = { source, kind: form.event_kind || "exchange",
      note: form.note?.trim(), occurred_on: form.occurred_on,
      ...(form.follow_up_on ? { follow_up_on: form.follow_up_on } : {}) };
    else if (mode === "writing-revisions") {
      if (lines(form.missing_facts).length > 20) { onError("Maximum 20 faits manquants, un par ligne."); return; }
      body = { title: form.title?.trim(), suggested_prose: form.suggested_prose?.trim(), missing_facts: lines(form.missing_facts),
        ...(source ? { sources: [source] } : {}), ...(form.revision_of ? { revision_of: form.revision_of } : {}) };
    } else if (mode === "inspection-preparation") body = { period_start: form.period_start, period_end: form.period_end, site_id: form.site_id?.trim() };
    else body = { message_id: form.message_id?.trim(), suggested_prose: form.suggested_prose?.trim() };
    const persistent = ["architect-decisions", "customer-followups", "client-events", "writing-revisions"].includes(mode);
    const selectedMode = mode;
    setResult(null);
    queue({
      title: `${persistent ? "Enregistrer la proposition" : "Préparer sans enregistrer"} : ${PREPARATIONS.find(([key]) => key === mode)[1]} ?`,
      actionLabel: persistent ? "Enregistrer la proposition" : "Lancer la préparation",
      text: `${dossier.title}\n${evidenceText(body)}\n${mode === "outlook-draft" ? "Lecture d'un seul message reçu ; aucune analyse de la boîte ni création de brouillon Outlook." : persistent ? "Proposition locale à confirmer dans le fil. Aucun changement métier." : "Calcul / lecture uniquement ; aucune preuve ni conformité inventée."}`,
      operation: async () => {
        const data = await request(`/${encodeURIComponent(dossier.id)}/${selectedMode}`, { method: "POST", body: JSON.stringify(body) });
        setResult({ mode: selectedMode, data });
      },
    });
  };
  return <details className="work-dossiers-preparation"><summary>Préparations métier et courrier sélectionné</summary>
    <p>Sources suivies autorisées, hypothèses déclarées et validation humaine. Les calculs ne remplacent pas les preuves.</p>
    <form className="work-dossiers-form" onSubmit={prepare}>
      <label>Préparation<select disabled={disabled} value={mode} onChange={(event) => { setMode(event.target.value); setForm({}); setResult(null); }}>
        {PREPARATIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      {!["outlook-draft", "inspection-preparation"].includes(mode) && <label>Source de la préparation<select required={!!allowedKinds} disabled={disabled} value={form.source || ""} onChange={(event) => update("source", event.target.value)}>
        <option value="">Choisir une source{!allowedKinds ? " (facultatif)" : ""}</option>
        {eligible.map((item) => <option key={sourceKey(item.source)} value={sourceKey(item.source)}>{sourceLabel(item)} · {item.source.kind}</option>)}
      </select></label>}
      {mode === "architect-decisions" && <>
        {textField("title", "Titre de la modification")}
        <label>Choix architecte<select disabled={disabled} value={form.outcome || "deferred"} onChange={(event) => update("outcome", event.target.value)}>{Object.entries(OUTCOMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {textField("rationale", "Justification architecte", true, true)}
        {textField("alternatives", "Alternatives (une par ligne)", true, true)}
        {textField("constraints", "Contraintes de plan / devis (une par ligne)", false, true)}
        {textField("declared_impacts", "Impacts déclarés, non déduits (un par ligne)", false, true)}
        {textField("next_step", "Suite de la modification", false)}
        {["plan", "devis", "jalon"].map((role) => <div key={role}>
          {textField(`${role}_reference`, `Référence ${role} (déclarée)`, false)}
          {textField(`${role}_version`, `Version ${role} (déclarée)`, false)}
        </div>)}
        <p>Références et versions déclarées, sans accès automatique aux plans ou devis. Liez une source suivie pour détecter ses changements ; coûts et délais ne sont pas recalculés.</p>
      </>}
      {mode === "stock-coverage" && <>
        <label>Horizon (jours)<input type="number" min="1" max="366" required disabled={disabled} value={form.horizon_days || 7} onChange={(event) => update("horizon_days", event.target.value)} /></label>
        <label><input type="checkbox" disabled={disabled} checked={!!form.sales_verified} onChange={(event) => update("sales_verified", event.target.checked)} />J'atteste avoir vérifié une observation de ventes</label>
        {form.sales_verified && <>
          <label>Unités vendues<input type="number" min="0" step="1" required disabled={disabled} value={form.sold_units ?? ""} onChange={(event) => update("sold_units", event.target.value)} /></label>
          {dateField("period_start", "Début des ventes")}{dateField("period_end", "Fin des ventes")}
          {textField("evidence", "Preuve de ventes", true, true)}
          <label>Ventes vérifiées le<input type="datetime-local" required disabled={disabled} value={form.verified_at || ""} onChange={(event) => update("verified_at", event.target.value)} /></label>
        </>}
        <p>Sans observation vérifiée ou avec une vitesse nulle, la couverture reste inconnue. Aucune commande automatique.</p>
      </>}
      {mode === "customer-followups" && <>{textField("objective", "Objectif du suivi client")}{textField("suggested_prose", "Suggestion de courrier client", true, true)}<p>Client choisi manuellement ; historique des contacts non déduit.</p></>}
      {mode === "client-events" && <>
        <label>Nature de l'événement<select disabled={disabled} value={form.event_kind || "exchange"} onChange={(event) => update("event_kind", event.target.value)}>
          {Object.entries(CLIENT_EVENTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        {textField("note", "Échange ou promesse consignée", true, true)}
        {dateField("occurred_on", "Date de l'événement")}
        {dateField("follow_up_on", "Date de suivi souhaitée", false)}
        <p>Événement déclaré par vous : ni consentement ni dernier contact vérifiés automatiquement. Un suivi daté est seulement proposé après confirmation.</p>
      </>}
      {mode === "writing-revisions" && <>
        {textField("title", "Titre de la révision")}{textField("suggested_prose", "Suggestion de révision", true, true)}
        {textField("missing_facts", "Faits manquants (un par ligne)", false, true)}
        <label>Révision précédente (facultative)<select disabled={disabled} value={form.revision_of || ""} onChange={(event) => update("revision_of", event.target.value)}>
          <option value="">Nouvelle rédaction</option>{entries.filter((entry) => entry.kind === "writing_revision").map((entry) => <option key={entry.id} value={entry.id}>{entry.content.title} · révision {entry.content.revision}</option>)}
        </select></label>
      </>}
      {mode === "inspection-preparation" && <>{dateField("period_start", "Début de l'inspection")}{dateField("period_end", "Fin de l'inspection")}{textField("site_id", "Identifiant du site")}<p>Seules les preuves datées et rattachées au site sont incluses. Les preuves sans site restent manquantes ; conformité non évaluée.</p></>}
      {mode === "outlook-draft" && <>{textField("message_id", "Identifiant du message Outlook reçu")}{textField("suggested_prose", "Votre suggestion de réponse Outlook", true, true)}
        <p>Choisissez un seul message de votre boîte de réception connectée et copiez son identifiant. Aucun balayage de la boîte ; aucun envoi ni brouillon distant. Une connexion manquante est signalée par le serveur.</p></>}
      <button type="submit" disabled={disabled || (!!allowedKinds && !selectedSource)}>Relire la préparation</button>
    </form>
    <button type="button" disabled={disabled || journalBusy} onClick={async () => {
      setJournalBusy(true); onError("");
      try { setResult({ mode: "decision-journal", data: await request(`/${encodeURIComponent(dossier.id)}/decision-journal`) }); }
      catch (cause) { setResult(null); onError(cause.message); }
      finally { setJournalBusy(false); }
    }}>Voir le journal architecte</button>
    <button type="button" disabled={disabled || journalBusy} onClick={async () => {
      setJournalBusy(true); onError("");
      try { setResult({ mode: "client-timeline", data: await request(`/${encodeURIComponent(dossier.id)}/client-events`) }); }
      catch (cause) { setResult(null); onError(cause.message); }
      finally { setJournalBusy(false); }
    }}>Voir le carnet client</button>
    {result && <div ref={resultRef} tabIndex={-1}><PreparationResult mode={result.mode} result={result.data} /></div>}
  </details>;
}
function entrySummary(entry) {
  const content = entry.content;
  if (["decision", "architect_decision"].includes(entry.kind)) return `${OUTCOMES[content.outcome]}\nPourquoi : ${content.rationale}\nQui : ${decisionActor(entry)}\nSuite : ${content.next_step || "À préciser"}${entry.kind === "architect_decision" ? `\nAlternatives : ${evidenceText(content.alternatives)}\nContraintes : ${evidenceText(content.constraints)}\nRéférences déclarées : ${evidenceText(content.document_links)}\nImpacts déclarés, non déduits : ${evidenceText(content.declared_impacts)}` : ""}`;
  if (entry.kind === "writing_revision" || content.type === "customer_followup") return `Faits sourcés : ${evidenceText(content.sourced_facts)}\nSuggestion : ${content.suggested_prose}\nManquant : ${evidenceText(content.missing_facts)}\n${evidenceText(content.checks)}`;
  if (entry.kind === "client_event") return `${CLIENT_EVENTS[content.kind]} · ${formatDocumentDate(content.occurred_on)}\n${content.note}\nSuivi déclaré : ${content.follow_up_on ? formatDocumentDate(content.follow_up_on) : "Aucune date"}\nContact manuel et consentement à vérifier.`;
  if (entry.kind === "commitment") return `${content.text}\nResponsable : ${content.owner}\nÉchéance : ${content.due_date ? formatDocumentDate(content.due_date) : "À préciser"}`;
  if (entry.kind === "meeting") return `${content.title}\n${content.notes}\nTâches proposées :\n${content.tasks.map((task) => `${task.text} — ${task.owner}`).join("\n")}`;
  if (entry.kind === "handoff") return `${content.objective}\nDestination : ${content.target} · transmission manuelle`;
  if (content.type === "invoice_followup") return `Destinataire : ${content.to || "À renseigner"}\nObjet : ${content.subject}\n${content.message}`;
  if (content.type === "stock_reorder") return `${content.lines.map((line) => `${line.label} · quantité ${line.qty} · prix ${displayValue(line.unit_price)}`).join("\n")}\n${content.notes}`;
  return `${content.objet}\nContrôle : ${content.control_type}\nRésultat : ${displayValue(content.resultat)}\nAnomalie : ${displayValue(content.anomalie)}\nAction corrective : ${displayValue(content.action_corrective)}`;
}

async function request(path = "", options) {
  const response = await fetch(`${BASE}${path}`, {
    ...options, credentials: "include", ...(options ? { headers: { "Content-Type": "application/json", ...options.headers } } : {}),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === "string" ? data.detail : `Erreur HTTP ${response.status}`);
  }
  return response.json();
}

function FieldCapture({ onText, disabled, onError }) {
  const [photo, setPhoto] = useState(null);
  const [listening, setListening] = useState(false);
  const recognition = useRef(null);
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const localVoice = SpeechRecognition && "processLocally" in SpeechRecognition.prototype;
  useEffect(() => () => recognition.current?.abort(), []);
  useEffect(() => { if (disabled) recognition.current?.abort(); }, [disabled]);
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);

  const capture = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      onError("Choisissez une photo JPEG, PNG ou WebP de moins de 5 Mo.");
      return;
    }
    setPhoto({ url: URL.createObjectURL(file), name: file.name });
  };
  const dictate = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const session = new SpeechRecognition();
    session.processLocally = true;
    session.lang = "fr-FR";
    session.onresult = (event) => onText(event.results[0][0].transcript);
    session.onerror = (event) => {
      setListening(false);
      onError(`Dictée locale indisponible (${event.error}). Saisissez votre note au clavier.`);
    };
    session.onend = () => setListening(false);
    recognition.current = session;
    try {
      session.start();
      setListening(true);
    } catch (cause) {
      onError(`Impossible de démarrer la dictée locale : ${cause.message}`);
    }
  };
  return <div className="work-dossiers-capture">
    <label>Photo terrain (aperçu local)
      <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={disabled} onChange={capture} />
    </label>
    {photo && <figure><img src={photo.url} alt={`Observation terrain : ${photo.name}`} />
      <figcaption>{photo.name} · non enregistrée ni transmise</figcaption>
      <button type="button" onClick={() => setPhoto(null)}>Retirer la photo</button>
    </figure>}
    {localVoice ? <button type="button" disabled={disabled} onClick={dictate}>
      {listening ? "Arrêter la dictée" : "Dicter sur cet appareil"}
    </button> : <small>Dictée locale non disponible sur ce navigateur. La saisie et la photo restent accessibles.</small>}
    <span role="status">{listening ? "Microphone actif · transcription locale" : ""}</span>
  </div>;
}

function WorkThread({ dossier, revision, disabled, queue, onError, onOpenThemis, onOpenHaccp, onThread }) {
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [mode, setMode] = useState("decision");
  const [form, setForm] = useState({});
  const [tasks, setTasks] = useState([]);
  const [taskText, setTaskText] = useState("");
  const [taskOwner, setTaskOwner] = useState("");
  const [meetingActions, setMeetingActions] = useState(null);
  const [scenario, setScenario] = useState(null);
  const [scenarioSource, setScenarioSource] = useState("");
  const [amount, setAmount] = useState("");
  const [manualReasons, setManualReasons] = useState({});
  const [simulating, setSimulating] = useState(false);
  const [visibleCount, setVisibleCount] = useState(12);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    onThread(null);
    request(`/${encodeURIComponent(dossier.id)}/thread`).then((data) => {
      if (active) { setThread(data); onThread(data); }
    }).catch((cause) => { if (active) { setThread(null); setLoadError(cause.message); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [dossier.id, revision, reload, onThread]);
  const update = (key, value) => { setForm((current) => ({ ...current, [key]: value })); setScenario(null); if (key === "text") setMeetingActions(null); };
  const sources = thread?.sources || [];
  const source = sources.find((item) => sourceKey(item.source) === form.source);
  const simulationSource = sources.find((item) => sourceKey(item.source) === scenarioSource);
  const entries = thread?.entries || [];
  const entryById = (id) => entries.find((entry) => entry.id === id);
  const sourceControls = (refs) => refs.map((ref) => {
    const snapshot = sources.find((item) => sourceKey(item.source) === sourceKey(ref));
    const open = ref.module === "haccp" ? onOpenHaccp : ref.module === "themis" ? onOpenThemis : null;
    return <div key={sourceKey(ref)} className="work-dossiers-source">
      <small>Source : {ref.module === "haccp" ? "HACCP" : "THÉMIS"} · {snapshot ? sourceLabel(snapshot) : ref.label || ref.id}</small>
      <button type="button" disabled={!open} onClick={() => open(ref)}>Vérifier la source</button>
    </div>;
  });
  const queueWrite = (path, body, title, text, method = "POST", done) => queue({
    title, text, operation: async () => {
      await request(`/${encodeURIComponent(dossier.id)}${path}`, {
        method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (done) done();
    },
  });
  const submit = (event) => {
    event.preventDefault();
    if (disabled) return;
    if (mode !== "draft" && !form.text?.trim()) { onError("Renseignez le contenu avant de le relire."); return; }
    if (mode === "commitment" && !form.owner?.trim()) { onError("Nommez le responsable de l'engagement."); return; }
    if (mode === "meeting" && !form.title?.trim()) { onError("Renseignez le titre de la réunion."); return; }
    if (mode === "meeting" && (taskText.trim() || taskOwner.trim())) {
      onError("Ajoutez la tâche en cours à la liste ou effacez ses champs avant de relire le compte rendu."); return;
    }
    const ref = source ? sourceRef(source.source) : undefined;
    let path;
    let body;
    if (mode === "decision") {
      path = "/decisions";
      body = { outcome: form.outcome || "deferred", rationale: form.text.trim(),
        ...(form.next_step?.trim() ? { next_step: form.next_step.trim() } : {}), ...(ref ? { source: ref } : {}) };
    } else if (mode === "commitment") {
      path = "/commitments";
      body = { text: form.text.trim(), owner: form.owner.trim(),
        ...(form.due_date ? { due_date: form.due_date } : {}), ...(ref ? { source: ref } : {}) };
    } else if (mode === "meeting") {
      path = "/meetings";
      body = { title: form.title.trim(), notes: form.text.trim(), tasks };
    } else if (mode === "handoff") {
      if (!ref) { onError("Suivez une source métier avant de préparer une proposition inter-métiers."); return; }
      path = "/handoffs";
      body = { target: form.target || "general", objective: form.text.trim(), sources: [ref] };
    } else {
      if (!ref) { onError("Sélectionnez une source suivie pour préparer un brouillon."); return; }
      path = "/drafts";
      body = { source: ref, ...(source.source.kind === "stock" && form.quantity ? { quantity: Number(form.quantity) } : {}) };
    }
    const summary = mode === "draft" ? `Préparer un brouillon depuis ${sourceLabel(source)}${form.quantity && source.source.kind === "stock" ? ` · quantité ${form.quantity}` : ""}.\nLe contenu sera proposé, jamais envoyé ni exécuté.`
      : `${form.title || KINDS[mode]}\n${form.text}\n${form.owner ? `Responsable : ${form.owner}\n` : ""}${form.due_date ? `Échéance : ${formatDocumentDate(form.due_date)}\n` : ""}${mode === "decision" ? `Décision : ${OUTCOMES[body.outcome]}\nSuite : ${body.next_step || "À préciser"}\n` : ""}${source ? `Source : ${sourceLabel(source)}\n` : ""}${mode === "handoff" ? `Destination : ${body.target}\n` : ""}${tasks.length && mode === "meeting" ? `Tâches proposées :\n${tasks.map((task) => `${task.text} — ${task.owner}`).join("\n")}` : ""}`;
    queueWrite(path, body, "Enregistrer cette proposition ?", summary, "POST", () => { setForm({}); setTasks([]); });
  };
  const simulate = async (event) => {
    event.preventDefault();
    if (disabled || simulating) return;
    if (!simulationSource || amount.trim() === "" || !Number.isFinite(Number(amount))) {
      onError("Choisissez une source et une valeur numérique pour la simulation."); return;
    }
    setSimulating(true);
    setScenario(null);
    onError("");
    try {
      const body = { source: sourceRef(simulationSource.source),
        ...(simulationSource.source.kind === "stock" ? { quantity_delta: Number(amount) } : { payment: Number(amount) }) };
      const result = await request(`/${encodeURIComponent(dossier.id)}/simulations`, { method: "POST", body: JSON.stringify(body) });
      setScenario({ ...result, label: sourceLabel(simulationSource) });
    } catch (cause) { onError(cause.message); }
    finally { setSimulating(false); }
  };
  if (loading) return <p role="status">Chargement du fil de travail…</p>;
  if (loadError) return <section className="work-dossiers-thread">
    <p role="alert">Fil de travail indisponible : {loadError}. Les notes et signaux existants restent accessibles.</p>
    <button type="button" onClick={() => setReload((current) => current + 1)}>Réessayer le fil</button>
  </section>;
  const decision = entries.find((entry) => entry.kind === "decision" && !["cancelled", "completed"].includes(entry.status));
  const renderEntry = (entry) => {
    const content = entry.content;
    return <article id={`work-entry-${entry.id}`} key={entry.id} className="work-dossiers-entry">
      <h3>{KINDS[entry.kind] || entry.kind} · {content.title || content.subject || content.text || content.objet || OUTCOMES[content.outcome] || content.type || content.target || CLIENT_EVENTS[content.kind]}</h3>
      <div className="work-dossiers-meta"><span>{STATUSES[entry.status] || entry.status}</span>
        <span>{entry.created_at ? new Date(entry.created_at).toLocaleString("fr-FR") : ""}</span>
      </div>
      {["decision", "architect_decision"].includes(entry.kind) && <><p>Pourquoi : {content.rationale}</p>
        <p>Qui : {decisionActor(entry)}</p>
        <p>Prochaine étape : {content.next_step || "À préciser"}</p></>}
      {entry.kind === "architect_decision" && <>
        <p>Alternatives : {evidenceText(content.alternatives)}</p><p>Contraintes : {evidenceText(content.constraints)}</p>
        <p>Plan, devis et jalon déclarés (versions non vérifiées) : {evidenceText(content.document_links)}</p>
        <p>Impacts déclarés par vous, non déduits : {evidenceText(content.declared_impacts)}</p>
        <p>Informations manquantes : {evidenceText(content.missing_info)}</p>
      </>}
      {entry.kind === "client_event" && <p className="work-dossiers-preserve">{entrySummary(entry)} · Saisie volontaire, aucune sollicitation automatique.</p>}
      {(entry.kind === "writing_revision" || content.type === "customer_followup") && <>
        <h4>Faits sourcés</h4><p className="work-dossiers-preserve">{evidenceText(content.sourced_facts)}</p>
        <h4>Suggestion · faits non vérifiés par la rédaction</h4><p className="work-dossiers-preserve">{content.suggested_prose}</p>
        <h4>Faits manquants</h4><p>{evidenceText(content.missing_facts)}</p>
        {entry.kind === "writing_revision" && <p>Révision {content.revision} · précédent : {content.revision_of || "Aucun"}</p>}
        {content.type === "customer_followup" && <p>Destinataire : {content.to || "À vérifier"}</p>}
        <p>Vérifications : {evidenceText(content.checks)}. Aucun envoi automatique.</p>
      </>}
      {entry.kind === "commitment" && <p>Responsable : {content.owner} · Échéance : {content.due_date ? formatDocumentDate(content.due_date) : "À préciser"}</p>}
      {entry.kind === "meeting" && <><p className="work-dossiers-preserve">{content.notes}</p>
        <h4>Tâches proposées · aucune création automatique dans un autre module</h4>
        {!content.tasks?.length && <p>Aucune tâche proposée.</p>}
        {content.tasks?.map((task) => <p key={task.id || `${task.text}:${task.owner}`}>{task.text} · {task.owner} · {STATUSES[task.status] || "À valider"}</p>)}</>}
      {entry.kind === "handoff" && <><p>{content.objective}</p><p>Destination : {content.target} · transmission manuelle uniquement</p></>}
      {entry.kind === "draft" && <>
        {content.type === "invoice_followup" && <><p>Destinataire : {content.to || "À renseigner dans THÉMIS"}</p>
          <p className="work-dossiers-preserve">{content.message}</p></>}
        {content.lines?.map((line, index) => <p key={index}>{line.label} · quantité {line.qty} · prix : {displayValue(line.unit_price)}</p>)}
        {content.notes && <p>{content.notes}</p>}
        {content.type === "haccp_control" && <><p>Contrôle : {content.control_type} · résultat : {displayValue(content.resultat)}</p>
          <p>Anomalie : {displayValue(content.anomalie)} · action corrective : {displayValue(content.action_corrective)}</p></>}
        {content.checks?.map((check) => <p key={check} className="work-dossiers-confirmation">{check}</p>)}
        <p>Cette validation dans ΣIRIUS n'envoie rien et ne constitue ni une commande ni un contrôle effectué.</p>
      </>}
      {entry.manual_outcome && <p>Suite déclarée hors de ΣIRIUS : {entry.manual_outcome.rationale} · {entry.manual_outcome.reported_at}. Déclaration utilisateur non vérifiée.</p>}
      {sourceControls(entry.sources || [])}
      {entry.source_changed && <p role="status" className="work-dossiers-confirmation">Source modifiée : préparer une nouvelle proposition avant validation.</p>}
      <div className="work-dossiers-actions">
        {entry.status === "proposed" && <button type="button" disabled={disabled || entry.source_changed} onClick={() =>
          queueWrite(`/entries/${encodeURIComponent(entry.id)}/confirm`, { confirmed: true }, "Valider cette proposition dans le dossier ?",
            `${KINDS[entry.kind]}\n${entrySummary(entry)}\n${entry.sources?.length ? `Sources : ${entry.sources.map((ref) => sourceLabel(sources.find((item) => sourceKey(item.source) === sourceKey(ref)) || { source: ref })).join(", ")}\n` : ""}Cette validation n'exécute aucune action métier.`)
        }>Relire puis valider</button>}
        {entry.kind === "commitment" && entry.status === "confirmed" && <>
          <button type="button" disabled={disabled} onClick={() => queueWrite(`/entries/${encodeURIComponent(entry.id)}`,
            { status: "completed" }, "Marquer cet engagement terminé ?", content.text, "PATCH")}>Marquer terminé</button>
          <button type="button" disabled={disabled} onClick={() => queueWrite(`/entries/${encodeURIComponent(entry.id)}`,
            { status: "cancelled" }, "Annuler cet engagement ?", content.text, "PATCH")}>Annuler l'engagement</button>
        </>}
      </div>
      {["draft", "handoff"].includes(entry.kind) && entry.status === "confirmed" && !entry.manual_outcome &&
        <form className="work-dossiers-form" onSubmit={(event) => {
          event.preventDefault();
          const rationale = manualReasons[entry.id]?.trim();
          if (!rationale) { onError("Précisez la suite effectuée hors de ΣIRIUS."); return; }
          queueWrite(`/entries/${encodeURIComponent(entry.id)}/manual-outcome`, { rationale },
            "Déclarer cette suite hors de ΣIRIUS ?",
            `${entrySummary(entry)}\nDéclaration personnelle, non vérifiée : ${rationale}\nAucun courrier ni commande ne sera envoyé.`,
            "POST", () => setManualReasons((current) => ({ ...current, [entry.id]: "" })));
        }}>
          <label>Suite réalisée hors de ΣIRIUS (déclaration non vérifiée)
            <textarea maxLength={2000} required disabled={disabled} value={manualReasons[entry.id] || ""}
              onChange={(event) => setManualReasons((current) => ({ ...current, [entry.id]: event.target.value }))} />
          </label>
          <button type="submit" disabled={disabled || !manualReasons[entry.id]?.trim()}>Relire la déclaration externe</button>
        </form>}
    </article>;
  };
  return <section className="work-dossiers-thread" aria-label={`Fil de travail : ${dossier.title}`}>
    <h2>{dossier.title} · fil de travail</h2>
    <button type="button" disabled={disabled || simulating} onClick={() => setReload((current) => current + 1)}>Actualiser le fil</button>
    {thread.truncated && <p role="status">Seuls les 500 éléments les plus récents sont affichés.</p>}
    {thread.unavailable_sources > 0 && <p role="status" className="work-dossiers-confirmation">
      {thread.unavailable_sources} source(s) indisponible(s) ou non autorisée(s). Les éléments liés ne sont pas affichés ; ne les considérez pas comme supprimés ou terminés.
    </p>}
    {thread.limits?.haccp && <p role="status">{thread.limits.haccp}</p>}
    <section className="work-dossiers-entry" aria-label="Prochaine étape manquante">
      <h3>Prochaine étape</h3>
      {decision?.content.next_step && <p>{decision.content.next_step}</p>}
      {!thread.suggestions?.length && <p>Aucune étape manquante détectée. Vérifiez les engagements et les sources.</p>}
      <ul>{thread.suggestions?.slice(0, 8).map((item, index) => <li key={`${item.kind}:${item.entry_id || index}`}>
        {SUGGESTIONS[item.kind] || item.reason || item.kind}
        {item.entry_id && <> · <a href={`#work-entry-${item.entry_id}`} onClick={() => setVisibleCount(entries.length)}>{KINDS[entryById(item.entry_id)?.kind] || "Élément"}</a></>}
        {item.why_suggested && <ProposalEvidence proposal={{ source: item.why_suggested.source, why_suggested: item.why_suggested }} />}
      </li>)}</ul>
      {thread.suggestions?.length > 8 && <p>{thread.suggestions.length - 8} autres points à examiner dans le fil.</p>}
    </section>
    <details open><summary>Changements depuis le dernier point validé</summary>
      {!thread.what_changed?.baseline_id && <p>Pas encore de point de comparaison. Les sources actuelles sont présentées comme nouvelles.</p>}
      {!thread.what_changed?.changes?.length && <p>Aucun changement de source détecté.</p>}
      {thread.what_changed?.changes?.map((change) => <div key={sourceKey(change.source)} className="work-dossiers-entry">
        {sourceControls([change.source])}
        <ul>{Object.entries(change.fields).map(([key, value]) => <li key={key}>{key} : {displayValue(value.before)} → {displayValue(value.after)}</li>)}</ul>
      </div>)}
      <button type="button" disabled={disabled} onClick={() => queueWrite("/snapshots", undefined,
        "Mémoriser ce point de comparaison ?", "Les valeurs actuelles des sources deviendront la référence pour votre prochaine visite.")}>
        J'ai relu les changements</button>
    </details>
    <details open><summary>Décisions, engagements et productions ({entries.length})</summary>
      {!entries.length && <p>Aucune décision enregistrée. Commencez par l'objectif et son pourquoi.</p>}
      {entries.slice(0, visibleCount).map(renderEntry)}
      {entries.length > visibleCount && <button type="button" onClick={() => setVisibleCount((current) => current + 12)}>Afficher les éléments précédents ({entries.length - visibleCount})</button>}
    </details>
    <details><summary>Préparer une réunion</summary>
      <p>Trame locale, à compléter avant la réunion : aucune invitation envoyée.</p>
      <ul><li>Objectif : {dossier.title}</li><li>Dernière décision : {decision?.content.rationale || "À définir"}</li>
        <li>Suite à clarifier : {decision?.content.next_step || "Responsable et prochaine étape à définir"}</li></ul>
      <h4>Engagements à examiner</h4>
      {entries.filter((entry) => entry.kind === "commitment" && !["completed", "cancelled"].includes(entry.status)).map((entry) =>
        <p key={entry.id}>{entry.content.text} · {entry.content.owner} · {entry.content.due_date ? formatDocumentDate(entry.content.due_date) : "Sans échéance"} · {STATUSES[entry.status]}</p>)}
      <h4>Sources à vérifier</h4>{sourceControls(sources.map((item) => item.source))}
      <button type="button" disabled={disabled} onClick={() => { setMode("meeting"); setForm({}); setScenario(null); }}>Saisir le compte rendu et proposer des tâches</button>
    </details>
    <details open><summary>Ajouter au fil · proposition à relire</summary>
      <form onSubmit={submit} className="work-dossiers-form">
        <label>Type<select disabled={disabled} value={mode} onChange={(event) => { setMode(event.target.value); setForm({}); setScenario(null); }}>
          {["decision", "commitment", "meeting", "draft", "handoff"].map((kind) => <option key={kind} value={kind}>{KINDS[kind]}</option>)}
        </select></label>
        {mode === "decision" && <><label>Décision<select disabled={disabled} value={form.outcome || "deferred"} onChange={(event) => update("outcome", event.target.value)}>
          {Object.entries(OUTCOMES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label><label>Prochaine étape<textarea disabled={disabled} maxLength={2000} value={form.next_step || ""} onChange={(event) => update("next_step", event.target.value)} /></label></>}
        {mode === "meeting" && <label>Titre de la réunion<input disabled={disabled} required maxLength={2000} value={form.title || ""} onChange={(event) => update("title", event.target.value)} /></label>}
        {mode !== "draft" && <label>{mode === "decision" ? "Pourquoi cette décision" : mode === "meeting" ? "Compte rendu de réunion" : mode === "handoff" ? "Objectif du passage inter-métiers" : "Engagement"}
          <textarea disabled={disabled} required maxLength={2000} value={form.text || ""} onChange={(event) => update("text", event.target.value)} /></label>}
        {mode === "commitment" && <><label>Responsable<input disabled={disabled} required maxLength={2000} value={form.owner || ""} onChange={(event) => update("owner", event.target.value)} /></label>
          <label>Échéance<input disabled={disabled} type="date" value={form.due_date || ""} onChange={(event) => update("due_date", event.target.value)} /></label></>}
        {mode === "handoff" && <label>Métier destinataire<select disabled={disabled} value={form.target || "general"} onChange={(event) => update("target", event.target.value)}>
          <option value="general">Général</option><option value="themis">THÉMIS</option><option value="haccp">HACCP</option>
        </select></label>}
        {mode !== "meeting" && <label>Source suivie<select disabled={disabled} required={["draft", "handoff"].includes(mode)} value={form.source || ""} onChange={(event) => update("source", event.target.value)}>
          <option value="">Choisir une source{!["draft", "handoff"].includes(mode) ? " (facultatif)" : ""}</option>
          {sources.map((item) => <option key={sourceKey(item.source)} value={sourceKey(item.source)}>{sourceLabel(item)} · {item.source.kind}</option>)}
        </select></label>}
        {mode === "draft" && <><p>Courrier professionnel depuis une facture, réapprovisionnement depuis le stock ou préparation de contrôle HACCP. Le contenu sera enregistré comme proposition à valider.</p>
          {source?.source.kind === "stock" && <label>Quantité proposée<input disabled={disabled} type="number" min="1" max="1000000" step="1" value={form.quantity || ""} onChange={(event) => update("quantity", event.target.value)} placeholder="Selon le seuil, à vérifier" /></label>}</>}
        {mode === "meeting" && <fieldset disabled={disabled}>
          <legend>Note → tâches proposées</legend><p>Recopiez une action du compte rendu et nommez son responsable. Aucune promesse n'est déduite automatiquement.</p>
          <button type="button" disabled={!form.text?.trim()} onClick={() => {
            const actions = form.text.split("\n").map((line) => line.match(/^\s*(?:[-*]\s*)?(?:action|tâche|à faire)\s*:\s*(.+)/i)?.[1]?.trim()).filter(Boolean);
            setMeetingActions([...new Set(actions)]);
          }}>Repérer les actions explicites</button>
          {meetingActions && <div role="status">
            {!meetingActions.length ? <p>Aucune ligne « Action : », « Tâche : » ou « À faire : » trouvée. Proposez une tâche manuellement.</p>
              : <><p>Actions repérées localement, à vérifier et attribuer avant ajout :</p>
                {meetingActions.map((text) => <button type="button" key={text} onClick={() => { setTaskText(text); setTaskOwner(""); }}>Proposer : {text}</button>)}</>}
          </div>}
          <label>Tâche proposée<input maxLength={2000} value={taskText} onChange={(event) => setTaskText(event.target.value)} /></label>
          <label>Responsable de la tâche<input maxLength={2000} value={taskOwner} onChange={(event) => setTaskOwner(event.target.value)} /></label>
          <button type="button" disabled={!taskText.trim() || !taskOwner.trim() || tasks.length >= 30} onClick={() => {
            setTasks((current) => [...current, { text: taskText.trim(), owner: taskOwner.trim() }]); setTaskText(""); setTaskOwner("");
          }}>Proposer cette tâche</button>
          {tasks.map((task, index) => <p key={index}>{task.text} · {task.owner} <button type="button" aria-label={`Retirer la tâche ${index + 1}`} onClick={() => setTasks((current) => current.filter((_, i) => i !== index))}>Retirer</button></p>)}
        </fieldset>}
        <button type="submit" disabled={disabled || (["draft", "handoff"].includes(mode) && !source) || (mode !== "draft" && !form.text?.trim())}>Relire avant enregistrement</button>
      </form>
      {!sources.length && <p>Suivez un signal ci-dessous pour rendre les brouillons et propositions inter-métiers disponibles.</p>}
    </details>
    <details><summary>Scénario · simulation sans enregistrement</summary>
      <form className="work-dossiers-form" onSubmit={simulate}>
        <label>Source à simuler<select disabled={disabled || simulating} required value={scenarioSource} onChange={(event) => { setScenarioSource(event.target.value); setAmount(""); setScenario(null); }}>
          <option value="">Choisir un stock ou une facture</option>
          {sources.filter((item) => ["stock", "facture"].includes(item.source.kind)).map((item) => <option key={sourceKey(item.source)} value={sourceKey(item.source)}>{sourceLabel(item)}</option>)}
        </select></label>
        <label>{simulationSource?.source.kind === "facture" ? "Paiement envisagé (€)" : "Variation de stock (+/−)"}
          <input disabled={disabled || simulating} required type="number" min={simulationSource?.source.kind === "facture" ? "0" : "-1000000"} max={simulationSource?.source.kind === "facture" ? "1000000000" : "1000000"}
            step={simulationSource?.source.kind === "facture" ? "0.01" : "1"} value={amount} onChange={(event) => { setAmount(event.target.value); setScenario(null); }} /></label>
        <button type="submit" disabled={disabled || simulating || !simulationSource || !["stock", "facture"].includes(simulationSource.source.kind)}>Comparer sans appliquer</button>
      </form>
      <p>Hypothèse : aucun autre mouvement de stock ou paiement. Simulation indicative, jamais une commande ni un règlement.</p>
      {scenario && <div role="status" className="work-dossiers-entry"><h4>{scenario.label}</h4>
        {scenario.result.stock_after !== undefined ? <p>Stock : {scenario.result.stock_before} → {scenario.result.stock_after} · {scenario.result.below_alert ? "Sous le seuil d'alerte" : "Au-dessus du seuil"}</p>
          : <p>Solde : {scenario.result.remaining_before} € → {scenario.result.remaining_after} €</p>}
        <p>Aucune donnée enregistrée ou appliquée.</p>
      </div>}
    </details>
  </section>;
}

export default function WorkDossiersPanel({ onClose, onOpenThemis, onOpenHaccp }) {
  const [dossiers, setDossiers] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [integrations, setIntegrations] = useState([]);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("general");
  const [selectedId, setSelectedId] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(null);
  const [dailyThread, setDailyThread] = useState(null);
  const [proposalDecision, setProposalDecision] = useState(null);
  const [rationale, setRationale] = useState("");
  const [resumeOn, setResumeOn] = useState("");
  const [day, setDay] = useState(null);
  const [dayError, setDayError] = useState("");
  const [dayLoading, setDayLoading] = useState(false);
  const [reviewItems, setReviewItems] = useState([]);
  const [reviewQueueError, setReviewQueueError] = useState("");
  const [reviewQueueTruncated, setReviewQueueTruncated] = useState(false);
  const [reviewQueueLoading, setReviewQueueLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const operationLock = useRef(false);
  const reviewRef = useRef(null);
  useEffect(() => { if (review) reviewRef.current?.focus(); }, [review]);
  useEffect(() => {
    let active = true;
    setDayLoading(true);
    setDayError("");
    request("/day").then((data) => { if (active) setDay(data); })
      .catch((cause) => { if (active) { setDay(null); setDayError(cause.message); } })
      .finally(() => { if (active) setDayLoading(false); });
    return () => { active = false; };
  }, [revision]);
  useEffect(() => {
    let active = true;
    setReviewQueueLoading(true);
    setReviewQueueError("");
    request("/review-queue").then((data) => {
      if (active) {
        setReviewItems(data.items);
        setReviewQueueTruncated(data.truncated);
      }
    }).catch((cause) => {
      if (active) {
        setReviewItems([]);
        setReviewQueueTruncated(false);
        setReviewQueueError(cause.message);
      }
    }).finally(() => { if (active) setReviewQueueLoading(false); });
    return () => { active = false; };
  }, [revision]);

  const refresh = useCallback(async () => {
    const [dossierData, proposalData] = await Promise.all([request(), request("/proposals")]);
    setDossiers(dossierData.dossiers);
    setProposals(proposalData.proposals);
    setIntegrations(proposalData.integrations || []);
    setSelectedId((current) => dossierData.dossiers.some((d) => d.id === current)
      ? current : (dossierData.dossiers[0]?.id || ""));
    setRevision((current) => current + 1);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([request(), request("/proposals")]).then(([dossierData, proposalData]) => {
      if (!active) return;
      setDossiers(dossierData.dossiers);
      setProposals(proposalData.proposals);
      setIntegrations(proposalData.integrations || []);
      setSelectedId(dossierData.dossiers[0]?.id || "");
    }).catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, []);

  const perform = async (operation) => {
    if (operationLock.current) return;
    operationLock.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
      setReview(null);
      await refresh();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
      operationLock.current = false;
    }
  };

  const create = (event) => {
    event.preventDefault();
    if (!title.trim()) { setError("Le titre du dossier est obligatoire."); return; }
    setReview({ title: "Créer ce dossier ?", text: `${title.trim()} · ${category}`, operation: async () => {
      const data = await request("", {
        method: "POST", body: JSON.stringify({ title, category }),
      });
      setTitle("");
      setSelectedId(data.dossier.id);
    } });
  };
  const addNote = (event) => {
    event.preventDefault();
    if (!selectedId || !note.trim() || note.length > 2000) { setError("Choisissez un dossier et saisissez une note de 1 à 2 000 caractères."); return; }
    setReview({ title: "Enregistrer cette note ?", text: note, operation: async () => {
      await request(`/${selectedId}/notes`, { method: "POST", body: JSON.stringify({ text: note }) });
      setNote("");
    } });
  };
  const selected = dossiers.find((d) => d.id === selectedId);
  const queueProposalDecision = (event) => {
    event.preventDefault();
    if (!proposalDecision || !rationale.trim()) {
      setError("Précisez pourquoi reporter ou écarter cette proposition."); return;
    }
    const { proposal, outcome } = proposalDecision;
    const body = { outcome, rationale: rationale.trim(), ...(outcome === "deferred" && resumeOn ? { resume_on: resumeOn } : {}) };
    setReview({
      title: `${OUTCOMES[outcome]} : enregistrer la décision ?`,
      text: `${proposal.title}\nPourquoi : ${body.rationale}\nSource : ${proposal.source.label || proposal.source.id}\n${resumeOn ? `Reprise : ${resumeOn}` : "Sans date de reprise : masqué jusqu'au changement de la source."}\nCe choix masque localement le signal ; il ne modifie pas sa source.`,
      operation: async () => {
        await request(`/proposals/${encodeURIComponent(proposal.id)}/review`, { method: "POST", body: JSON.stringify(body) });
        setProposalDecision(null); setRationale(""); setResumeOn("");
      },
    });
  };
  const dailyCommitments = day?.commitments || selectedDossierCommitments(dailyThread?.entries || []);

  return (
    <section className="prime-screen work-dossiers" role="dialog" aria-label="Dossiers intelligents" data-testid="work-dossiers-panel">
      <header className="zeus-head work-dossiers-head">
        <h1><FolderOpen size={22} /> DOSSIERS · ΣIRIUS ANTICIPE</h1>
        <button type="button" className="setup-close zeus-close" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
      </header>
      <div className="work-dossiers-body">
        <p>Relie ton travail à des signaux réels. ΣIRIUS propose, tu décides : aucune commande ni relance n'est envoyée automatiquement.</p>
        {error && <p role="alert" className="work-dossiers-error">{error}</p>}
        {review && <section ref={reviewRef} tabIndex={-1} className="work-dossiers-review" aria-label="Validation avant enregistrement">
          <h2>{review.title}</h2>
          <p className="work-dossiers-preserve">{review.text}</p>
          <p>Seule la requête relue sera effectuée. Une préparation temporaire n'est pas enregistrée. Aucun envoi, commande ou changement métier.</p>
          <div className="work-dossiers-actions">
            <button type="button" disabled={busy} onClick={() => perform(review.operation)}>{review.actionLabel || "Valider l'enregistrement"}</button>
            <button type="button" disabled={busy} onClick={() => setReview(null)}>Annuler</button>
          </div>
        </section>}
        {integrations.length > 0 && <div className="work-dossiers-integrations" aria-label="État des intégrations">
          {integrations.map((integration) => <p key={integration.module}>
            <strong>{integration.label} · {integration.available ? "accessible" : "non intégré"}</strong>
            <span>{integration.detail}</span>
          </p>)}
        </div>}
        <section className="work-dossiers-day" aria-label="Vue journée">
          <h2>Ma journée · propositions et engagements</h2>
          {dayLoading && <p role="status">Chargement de la journée…</p>}
          {dayError && <p role="alert">Vue journée indisponible : {dayError}. Le fil du dossier reste accessible ; engagements du dossier sélectionné uniquement.</p>}
          <p>{proposals.length} proposition(s) sourcée(s) · {dailyCommitments.length} engagement(s) actif(s) {day ? "dans les dossiers autorisés" : `dans ${selected?.title || "le dossier à sélectionner"}`}.</p>
          <p>Signaux accessibles au compte connecté. Une absence de données ne signifie pas que tout est terminé.</p>
          {day && <><p>Journée : {day.on} · vérifiée : {day.verified_at}. Propositions évaluées aujourd'hui, engagements confirmés sans date ou échus à cette journée.</p>
            {day.truncated && <p role="status">Synthèse limitée : tous les dossiers ou éléments ne sont pas inclus.</p>}
            {!!day.missing_info?.length && <p>Informations manquantes : {evidenceText(day.missing_info)}</p>}</>}
          <div className="work-dossiers-card-grid">
            <div><h3>À examiner</h3>
              {!(day?.proposals || proposals).length && <p>Aucune proposition reçue.</p>}
              {(day?.proposals || proposals).map((proposal) => <p key={proposal.id}><a href={`#work-proposal-${proposal.id}`}>{proposal.title}</a> · {proposal.source?.label || "Source à vérifier"}</p>)}
            </div>
            <div><h3>Engagements à tenir</h3>
              {selected && !day && !dailyThread && <p>Fil non chargé : engagements non vérifiés.</p>}
              {(day || dailyThread) && !dailyCommitments.length && <p>Aucun engagement actif dans le fil disponible.</p>}
              {dailyCommitments.map((entry) => {
                const content = entry.content || entry;
                return <div key={`${entry.dossier_id || selectedId}:${entry.entry_id || entry.id}:${entry.task_id || ""}`}>
                  <p>{content.text} · {content.owner || "Responsable manquant"} · {content.due_date ? formatDocumentDate(content.due_date) : "Échéance manquante"} · {STATUSES[entry.status] || entry.status}</p>
                  {entry.dossier_id && <button type="button" disabled={busy || !!review} onClick={() => { setSelectedId(entry.dossier_id); setDailyThread(null); setProposalDecision(null); setRationale(""); setNote(""); }}>
                    Ouvrir le dossier : {dossiers.find((item) => item.id === entry.dossier_id)?.title || entry.dossier_id}
                  </button>}
                  {entry.why_suggested && <ProposalEvidence proposal={{ why_suggested: entry.why_suggested, source: entry.why_suggested.source }} />}
                </div>;
              })}
              {!!dailyThread?.unavailable_sources && <p>{dailyThread.unavailable_sources} source(s) non accessible(s) : synthèse partielle.</p>}
            </div>
          </div>
        </section>
        <section className="work-dossiers-day" aria-label="File de relecture">
          <h2>File de relecture · dossiers privés</h2>
          <p>Confirmer une proposition ne réalise pas l'action ; une suite extérieure ne peut être déclarée qu'après confirmation.</p>
          {reviewQueueLoading && <p role="status">Chargement de la file de relecture…</p>}
          {reviewQueueError && <p role="alert">File indisponible : {reviewQueueError}. Consultez le fil de chaque dossier.</p>}
          {reviewQueueTruncated && <p role="status">File limitée aux 500 éléments les plus récents : vérifiez les dossiers plus anciens.</p>}
          {!reviewQueueLoading && !reviewQueueError && !reviewItems.length && <p>Aucune proposition ni suite manuelle en attente dans la partie consultée.</p>}
          {reviewItems.map(({ entry, dossier_id, stage, source_changed }) => <article key={entry.id} className="work-dossiers-entry">
            <h3>{stage === "to_confirm" ? "À relire avant confirmation" : "Suite manuelle à déclarer"} · {KINDS[entry.kind] || entry.kind}</h3>
            <p className="work-dossiers-preserve">{entrySummary(entry)}</p>
            {source_changed && <p role="status">Source modifiée : {stage === "to_confirm" ? "préparer une nouvelle proposition avant confirmation." : "vérifier les données actuelles avant toute suite manuelle."}</p>}
            <button type="button" disabled={busy || !!review} onClick={() => {
              setSelectedId(dossier_id); setDailyThread(null); setProposalDecision(null); setRationale(""); setNote("");
            }}>Ouvrir le dossier : {dossiers.find((item) => item.id === dossier_id)?.title || dossier_id}</button>
          </article>)}
        </section>
        {proposalDecision && <form className="work-dossiers-decision work-dossiers-form" aria-label="Décider sur une proposition" onSubmit={queueProposalDecision}>
          <h3>{OUTCOMES[proposalDecision.outcome]} : {proposalDecision.proposal.title}</h3>
          <p>Choix privé sur ce signal ; aucune action métier.</p>
          <label>Motif de la décision<textarea required maxLength={2000} disabled={busy || !!review} value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>
          {proposalDecision.outcome === "deferred" && <label>Date de reprise (facultative)<input type="date" disabled={busy || !!review} value={resumeOn} onChange={(event) => setResumeOn(event.target.value)} /></label>}
          <button type="submit" disabled={busy || !!review || !rationale.trim()}>Relire cette décision</button>
          <button type="button" disabled={busy || !!review} onClick={() => { setProposalDecision(null); setRationale(""); }}>Fermer la décision</button>
        </form>}
        <form onSubmit={create} className="work-dossiers-form">
          <label>Nouveau dossier<input disabled={busy || !!review} required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Client, chantier ou projet…" /></label>
          <label>Domaine<select disabled={busy || !!review} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <button type="submit" disabled={busy || !!review || !title.trim()}>Créer</button>
        </form>
        <div className="work-dossiers-grid">
          <div>
            <h2>Mes dossiers</h2>
            {dossiers.length === 0 && <p>Aucun dossier pour le moment.</p>}
            {dossiers.map((d) => <button type="button" className={selectedId === d.id ? "selected" : ""}
              key={d.id} disabled={busy || !!review} aria-pressed={selectedId === d.id} onClick={() => { setSelectedId(d.id); setNote(""); setDailyThread(null); setProposalDecision(null); setRationale(""); }}>{d.title} · {CATEGORIES.find(([key]) => key === d.category)?.[1]}</button>)}
            {selected && <>
              <h3>{selected.title}</h3>
              <form onSubmit={addNote} className="work-dossiers-form">
                <label>Note<textarea disabled={busy || !!review} required maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
                <button type="submit" disabled={busy || !!review || !note.trim()}>Ajouter une note</button>
              </form>
              <FieldCapture key={selectedId} disabled={busy || !!review} onError={setError}
                onText={(text) => setNote((current) => `${current}${current ? "\n" : ""}${text}`)} />
              {note.length > 2000 && <p role="alert">La dictée dépasse 2 000 caractères : raccourcissez la note avant enregistrement.</p>}
              {(selected.notes || []).map((entry) => <p key={entry.id} className="work-dossiers-entry">{entry.text}</p>)}
              {(selected.sources || []).map((source) => <p key={`${source.kind}:${source.id}`} className="work-dossiers-entry">
                Source suivie : {source.label} · {source.module === "haccp" ? "HACCP" : "THÉMIS"} ({source.kind})
              </p>)}
            </>}
          </div>
          <div>
            {selected && <WorkThread key={selectedId} dossier={selected} revision={revision}
              disabled={busy || !!review} queue={setReview} onError={setError} onOpenThemis={onOpenThemis} onOpenHaccp={onOpenHaccp} onThread={setDailyThread} />}
            <MetierCards sources={dailyThread?.sources || []} entries={dailyThread?.entries || []} />
            {selected && <MetierPreparation key={`preparation-${selectedId}`} dossier={selected} sources={dailyThread?.sources || []} entries={dailyThread?.entries || []}
              disabled={busy || !!review} queue={setReview} onError={setError} />}
            <h2>Propositions vérifiables</h2>
            {!proposals.length && <p>Aucun signal métier à vérifier pour le moment.</p>}
            {proposals.map((proposal) => <article id={`work-proposal-${proposal.id}`} key={proposal.id} className="work-dossiers-proposal">
              <h3>{proposal.title}</h3><p>{proposal.reason}</p>
              <small>Source : {proposal.source.module === "haccp" ? "HACCP" : "THÉMIS"} · {proposal.source.label}</small>
              <ProposalEvidence proposal={proposal} />
              {proposal.confirmation_required && <p className="work-dossiers-confirmation">
                Aucune action sensible n'est exécutée ici : vérifie les informations puis confirme séparément dans le module.
              </p>}
              <div className="work-dossiers-actions">
                <button type="button"
                  disabled={proposal.proposed_action.module === "haccp" ? !onOpenHaccp : !onOpenThemis}
                  onClick={() => (proposal.proposed_action.module === "haccp" ? onOpenHaccp : onOpenThemis)?.(proposal.source)}>
                  {proposal.proposed_action.label}
                </button>
                <button type="button" disabled={!selectedId || busy || !!review} onClick={() => setReview({
                  title: "Suivre ce signal ?", text: `${selected.title} : ${proposal.title}\n${proposal.reason}`,
                  operation: () => request(`/${selectedId}/proposals/${proposal.id}`, { method: "POST" }),
                })}>Suivre dans le dossier</button>
                {["deferred", "rejected"].map((outcome) => <button key={outcome} type="button" disabled={busy || !!review} onClick={() => {
                  setProposalDecision({ proposal, outcome }); setRationale(""); setResumeOn("");
                }}>{outcome === "deferred" ? "Reporter avec un motif" : "Écarter avec un motif"}</button>)}
              </div>
            </article>)}
          </div>
        </div>
      </div>
    </section>
  );
}
