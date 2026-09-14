import { useCallback, useEffect, useState } from "react";
import { CalendarClock, CheckCircle2, ListTodo, Loader2, Plus, Trash2 } from "lucide-react";

import { productivityRequest } from "./productivityApi";

const EMPTY_TASK = { title: "", description: "", priority: "medium", due_at: "" };

export default function TaskPanel() {
  const [tasks, setTasks] = useState([]);
  const [draft, setDraft] = useState(EMPTY_TASK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const payload = await productivityRequest("/tasks");
      setTasks(payload.tasks || []);
    } catch (requestError) {
      setError(requestError.message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    window.addEventListener("productivity-sync-complete", load);
    return () => window.removeEventListener("productivity-sync-complete", load);
  }, [load]);

  const create = async (event) => {
    event.preventDefault();
    if (!draft.title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await productivityRequest("/tasks", { method: "POST", body: JSON.stringify(draft) });
      setDraft(EMPTY_TASK);
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const update = async (task, changes) => {
    try {
      await productivityRequest(`/tasks/${task.id}`, { method: "PUT", body: JSON.stringify(changes) });
      await load();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const remove = async (task) => {
    try {
      await productivityRequest(`/tasks/${task.id}`, { method: "DELETE" });
      await load();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  return (
    <section className="productivity-tool" data-testid="productivity-task-panel">
      <div className="productivity-tool-head">
        <div><ListTodo size={17} /><div><h3>TaskMaster</h3><p>Priorites, echeances et avancement du travail.</p></div></div>
      </div>
      <form className="productivity-task-form" onSubmit={create}>
        <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={180} placeholder="Nouvelle tache" />
        <select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })}><option value="low">Basse</option><option value="medium">Moyenne</option><option value="high">Haute</option></select>
        <input type="datetime-local" value={draft.due_at} onChange={(event) => setDraft({ ...draft, due_at: event.target.value })} aria-label="Echeance" />
        <button type="submit" className="productivity-primary-btn" disabled={busy}>{busy ? <Loader2 size={14} className="productivity-spin" /> : <Plus size={14} />} AJOUTER</button>
      </form>
      <textarea className="productivity-task-description" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} maxLength={4000} placeholder="Contexte optionnel de la tache..." />
      {error && <div className="productivity-error" role="alert">{error}</div>}
      <div className="productivity-list productivity-task-list">
        {!tasks.length && <p className="productivity-empty">Aucune tache active.</p>}
        {tasks.map((task) => (
          <article className={`productivity-task status-${task.status}`} key={task.id}>
            <button type="button" className="productivity-task-check" onClick={() => update(task, { status: task.status === "done" ? "todo" : "done" })} title="Basculer termine"><CheckCircle2 size={17} /></button>
            <div><h4>{task.title}</h4>{task.description && <p>{task.description}</p>}<span>{task.due_at ? <><CalendarClock size={11} /> {task.due_at.replace("T", " ")}</> : "Sans echeance"}</span></div>
            <aside><select value={task.status} onChange={(event) => update(task, { status: event.target.value })}><option value="todo">A faire</option><option value="in_progress">En cours</option><option value="done">Termine</option></select><select value={task.priority} onChange={(event) => update(task, { priority: event.target.value })}><option value="low">Basse</option><option value="medium">Moyenne</option><option value="high">Haute</option></select><button type="button" onClick={() => remove(task)} title="Supprimer"><Trash2 size={13} /></button></aside>
          </article>
        ))}
      </div>
    </section>
  );
}

