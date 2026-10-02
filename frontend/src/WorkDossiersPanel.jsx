import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { API_BASE_URL } from "./lib/api";
import "./WorkDossiersPanel.css";

const BASE = `${API_BASE_URL}/work-dossiers`;
const CATEGORIES = [
  ["general", "Général"], ["commerce", "Commerce"], ["chantier", "Chantier"],
  ["gestion", "Gestion"], ["haccp", "HACCP"], ["redaction", "Rédaction"],
];
const OUTCOMES = { accepted: "Retenue", rejected: "Écartée", deferred: "Reportée" };
const STATUSES = { proposed: "À valider", confirmed: "Validé dans le dossier", completed: "Terminé", cancelled: "Annulé" };
const KINDS = { decision: "Décision", commitment: "Engagement", meeting: "Réunion", draft: "Brouillon", handoff: "Proposition inter-métiers" };
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
function entrySummary(entry) {
  const content = entry.content;
  if (entry.kind === "decision") return `${OUTCOMES[content.outcome]}\nPourquoi : ${content.rationale}\nQui : ${decisionActor(entry)}\nSuite : ${content.next_step || "À préciser"}`;
  if (entry.kind === "commitment") return `${content.text}\nResponsable : ${content.owner}\nÉchéance : ${content.due_date || "À préciser"}`;
  if (entry.kind === "meeting") return `${content.title}\n${content.notes}\nTâches proposées :\n${content.tasks.map((task) => `${task.text} — ${task.owner}`).join("\n")}`;
  if (entry.kind === "handoff") return `${content.objective}\nDestination : ${content.target} · transmission manuelle`;
  if (content.type === "invoice_followup") return `Destinataire : ${content.to || "À renseigner"}\nObjet : ${content.subject}\n${content.message}`;
  if (content.type === "stock_reorder") return `${content.lines.map((line) => `${line.label} · quantité ${line.qty} · prix ${displayValue(line.unit_price)}`).join("\n")}\n${content.notes}`;
  return `${content.objet}\nContrôle : ${content.control_type}\nRésultat : ${displayValue(content.resultat)}\nAnomalie : ${displayValue(content.anomalie)}\nAction corrective : ${displayValue(content.action_corrective)}`;
}

async function request(path = "", options) {
  const response = await fetch(`${BASE}${path}`, options && {
    ...options, headers: { "Content-Type": "application/json" },
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

function WorkThread({ dossier, revision, disabled, queue, onError, onOpenThemis, onOpenHaccp }) {
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
  const [simulating, setSimulating] = useState(false);
  const [visibleCount, setVisibleCount] = useState(12);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    request(`/${encodeURIComponent(dossier.id)}/thread`).then((data) => {
      if (active) setThread(data);
    }).catch((cause) => { if (active) { setThread(null); setLoadError(cause.message); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [dossier.id, revision, reload]);
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
      : `${form.title || KINDS[mode]}\n${form.text}\n${form.owner ? `Responsable : ${form.owner}\n` : ""}${form.due_date ? `Échéance : ${form.due_date}\n` : ""}${mode === "decision" ? `Décision : ${OUTCOMES[body.outcome]}\nSuite : ${body.next_step || "À préciser"}\n` : ""}${source ? `Source : ${sourceLabel(source)}\n` : ""}${mode === "handoff" ? `Destination : ${body.target}\n` : ""}${tasks.length && mode === "meeting" ? `Tâches proposées :\n${tasks.map((task) => `${task.text} — ${task.owner}`).join("\n")}` : ""}`;
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
      <h3>{KINDS[entry.kind] || entry.kind} · {content.title || content.subject || content.text || content.objet || OUTCOMES[content.outcome] || content.type || content.target}</h3>
      <div className="work-dossiers-meta"><span>{STATUSES[entry.status] || entry.status}</span>
        <span>{entry.created_at ? new Date(entry.created_at).toLocaleString("fr-FR") : ""}</span>
      </div>
      {entry.kind === "decision" && <><p>Pourquoi : {content.rationale}</p>
        <p>Qui : {decisionActor(entry)}</p>
        <p>Prochaine étape : {content.next_step || "À préciser"}</p></>}
      {entry.kind === "commitment" && <p>Responsable : {content.owner} · Échéance : {content.due_date || "À préciser"}</p>}
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
        <p>Ce brouillon n'a pas été envoyé et ne constitue ni une commande ni un contrôle effectué.</p>
      </>}
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
        <p key={entry.id}>{entry.content.text} · {entry.content.owner} · {entry.content.due_date || "Sans échéance"} · {STATUSES[entry.status]}</p>)}
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
  const [revision, setRevision] = useState(0);
  const operationLock = useRef(false);
  const reviewRef = useRef(null);
  useEffect(() => { if (review) reviewRef.current?.focus(); }, [review]);

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
          <p>Seul cet enregistrement sera effectué. Aucun envoi, commande ou changement métier.</p>
          <div className="work-dossiers-actions">
            <button type="button" disabled={busy} onClick={() => perform(review.operation)}>Valider l'enregistrement</button>
            <button type="button" disabled={busy} onClick={() => setReview(null)}>Annuler</button>
          </div>
        </section>}
        {integrations.length > 0 && <div className="work-dossiers-integrations" aria-label="État des intégrations">
          {integrations.map((integration) => <p key={integration.module}>
            <strong>{integration.label} · {integration.available ? "accessible" : "non intégré"}</strong>
            <span>{integration.detail}</span>
          </p>)}
        </div>}
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
              key={d.id} disabled={busy || !!review} aria-pressed={selectedId === d.id} onClick={() => { setSelectedId(d.id); setNote(""); }}>{d.title} · {CATEGORIES.find(([key]) => key === d.category)?.[1]}</button>)}
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
              disabled={busy || !!review} queue={setReview} onError={setError} onOpenThemis={onOpenThemis} onOpenHaccp={onOpenHaccp} />}
            <h2>Propositions vérifiables</h2>
            {!proposals.length && <p>Aucun signal métier à vérifier pour le moment.</p>}
            {proposals.map((proposal) => <article key={proposal.id} className="work-dossiers-proposal">
              <h3>{proposal.title}</h3><p>{proposal.reason}</p>
              <small>Source : {proposal.source.module === "haccp" ? "HACCP" : "THÉMIS"} · {proposal.source.label}</small>
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
                <button type="button" disabled={busy || !!review} onClick={() => setReview({
                  title: "Ignorer ce signal ?", text: proposal.title,
                  operation: () => request(`/proposals/${proposal.id}/dismiss`, { method: "POST" }),
                })}>Ignorer ce signal</button>
              </div>
            </article>)}
          </div>
        </div>
      </div>
    </section>
  );
}
