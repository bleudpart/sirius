import { useCallback, useEffect, useRef, useState } from "react";
import { agendaPayload, chronosRequest, localDateTime, localTimeCandidates, newChronosRequestId } from "./chronos";
import "./ChronosAgenda.css";

const emptyForm = () => ({ title: "", start: "", end: "", startOccurrence: "", endOccurrence: "", notes: "", allow_conflicts: false });

export default function ChronosAgenda() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris";
  const [day, setDay] = useState(() => localDateTime().slice(0, 10));
  const [events, setEvents] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mutation = useRef(false);
  const createAttempt = useRef(null);

  const load = useCallback(async (signal) => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const data = await chronosRequest(`/events?on=${encodeURIComponent(day)}&timezone=${encodeURIComponent(timezone)}`, { signal });
      if (signal?.aborted || current !== generation.current) return;
      setEvents(data.events);
      setTruncated(data.truncated);
      setError("");
    } catch (cause) {
      if (!signal?.aborted && current === generation.current) {
        setEvents([]);
        setError(cause.message || "Lecture de l'agenda impossible.");
      }
    } finally {
      if (!signal?.aborted && current === generation.current) setLoading(false);
    }
  }, [day, timezone]);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { void load(controller.signal); };
    refresh();
    window.addEventListener("sirius:chronos-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      generation.current += 1;
      window.removeEventListener("sirius:chronos-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  const save = async (event) => {
    event.preventDefault();
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = agendaPayload(form, timezone, editing);
      const fingerprint = JSON.stringify(payload);
      if (!editing && createAttempt.current?.fingerprint !== fingerprint) {
        createAttempt.current = { fingerprint, key: newChronosRequestId() };
      }
      await chronosRequest(editing ? `/events/${encodeURIComponent(editing.id)}` : "/events", {
        method: editing ? "PUT" : "POST",
        headers: editing ? {} : { "Idempotency-Key": createAttempt.current.key },
        body: JSON.stringify({ ...payload, ...(editing ? { revision: editing.revision } : {}) }),
      });
      setForm(emptyForm());
      createAttempt.current = null;
      setEditing(null);
      setNotice("Rendez-vous enregistré dans CHRONOS.");
      await load();
    } catch (cause) {
      setError(`${cause.message}${cause.conflicts?.length ? ` Conflits : ${cause.conflicts.map((item) => item.title).join(", ")}. Cochez l'acceptation uniquement si vous souhaitez conserver ce chevauchement.` : ""}`);
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!pendingDelete || mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await chronosRequest(`/events/${encodeURIComponent(pendingDelete.id)}?revision=${pendingDelete.revision}`, { method: "DELETE" });
      setPendingDelete(null);
      if (editing?.id === pendingDelete.id) { setEditing(null); setForm(emptyForm()); }
      setNotice("Rendez-vous supprimé.");
      await load();
    } catch (cause) { setError(cause.message); }
    finally { mutation.current = false; setBusy(false); }
  };

  return <section className="chronos-agenda" aria-label="Agenda quotidien CHRONOS">
    <h2>Agenda quotidien</h2>
    <p className="work-hint">Agenda privé conservé par le backend utilisé : SQLite sur Windows, serveur configuré sur Android. Deux backends différents ne se synchronisent pas automatiquement. Les anciennes échéances restent ci-dessous et dans leur sauvegarde locale.</p>
    <p className="work-hint">Chat et voix : « Ajoute un rendez-vous client demain de 14 h à 15 h ». Les changements proposés demandent une confirmation. Aucun rappel automatique ni synchronisation Outlook/Google.</p>
    <label className="chronos-day">Journée affichée ({timezone})<input aria-label="Journée affichée" type="date" required value={day} disabled={busy} onChange={(event) => {
      if (event.target.value) { setDay(event.target.value); setPendingDelete(null); setNotice(""); }
    }} /></label>
    {error && <p className="work-error" role="alert">{error}</p>}
    {notice && <p className="work-notice" role="status">{notice}</p>}
    <form className="work-form" onSubmit={save} aria-label={editing ? "Modifier un rendez-vous" : "Créer un rendez-vous"}>
      <fieldset disabled={busy}>
        <label>Titre du rendez-vous<input required maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        {["start", "end"].map((field) => <div key={field}>
          <label>{field === "start" ? "Début" : "Fin"}<input required type="datetime-local" value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value, [`${field}Occurrence`]: "" })} /></label>
          {localTimeCandidates(form[field]).length > 1 && <label>Occurrence {field === "start" ? "du début" : "de la fin"}
            <select required value={form[`${field}Occurrence`]} onChange={(e) => setForm({ ...form, [`${field}Occurrence`]: e.target.value })}>
              <option value="">Choisir l’horaire exact</option>
              {localTimeCandidates(form[field]).map((candidate, index) => <option key={index} value={String(index)}>
                {index === 0 ? "Première" : "Seconde"} occurrence — {candidate.toLocaleTimeString("fr-FR", { timeZoneName: "shortOffset" })}
              </option>)}
            </select>
          </label>}
        </div>)}
        <label>Notes<textarea maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        <label className="chronos-accept"><input type="checkbox" checked={form.allow_conflicts} onChange={(e) => setForm({ ...form, allow_conflicts: e.target.checked })} /> Accepter les chevauchements pour ce rendez-vous</label>
        <div className="chronos-actions"><button type="submit">{editing ? "Enregistrer les modifications" : "Créer le rendez-vous"}</button>
          {editing && <button type="button" onClick={() => { setEditing(null); setForm(emptyForm()); }}>Annuler la modification</button>}</div>
      </fieldset>
    </form>
    <div className="work-section-head"><h3>Rendez-vous de la journée</h3><button type="button" disabled={loading || busy} onClick={() => void load()}>Actualiser l’agenda</button></div>
    {loading ? <p role="status">Chargement de l’agenda…</p> : !error && events.length === 0 && <p>Aucun rendez-vous pour cette journée.</p>}
    {truncated && <p role="alert">Affichage limité à 500 rendez-vous. Cette journée est incomplète.</p>}
    <ol className="chronos-events">{events.map((item) => <li className="work-item" key={item.id}>
      <strong>{item.title}</strong>
      <p><time dateTime={item.start}>{new Date(item.start).toLocaleString("fr-FR", { timeZone: timezone })}</time> → <time dateTime={item.end}>{new Date(item.end).toLocaleString("fr-FR", { timeZone: timezone })}</time></p>
      {item.notes && <p>{item.notes}</p>}
      <div className="chronos-actions"><button type="button" disabled={busy} onClick={() => {
        setEditing(item); setPendingDelete(null); setNotice(""); setError("");
        setForm({ title: item.title, start: localDateTime(item.start), end: localDateTime(item.end),
          startOccurrence: String(localTimeCandidates(localDateTime(item.start)).findIndex((candidate) => candidate.getTime() === new Date(item.start).getTime())),
          endOccurrence: String(localTimeCandidates(localDateTime(item.end)).findIndex((candidate) => candidate.getTime() === new Date(item.end).getTime())),
          notes: item.notes || "", allow_conflicts: false });
      }} aria-label={`Modifier ${item.title}`}>Modifier</button>
        <button type="button" disabled={busy} onClick={() => setPendingDelete(item)} aria-label={`Supprimer le rendez-vous ${item.title}`}>Supprimer</button></div>
    </li>)}</ol>
    {pendingDelete && <div className="work-confirm" role="group" aria-label="Confirmer la suppression du rendez-vous">
      <p>Supprimer définitivement « {pendingDelete.title} » du {new Date(pendingDelete.start).toLocaleString("fr-FR")} ?</p>
      <button type="button" disabled={busy} onClick={remove}>Confirmer la suppression du rendez-vous</button>
      <button type="button" disabled={busy} onClick={() => setPendingDelete(null)}>Conserver le rendez-vous</button>
    </div>}
  </section>;
}
