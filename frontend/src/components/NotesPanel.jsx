import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Pencil, Pin, Plus, Search, StickyNote, Trash2, X } from "lucide-react";

import { productivityRequest } from "./productivityApi";

const EMPTY_DRAFT = { title: "", content: "", tags: "" };

export default function NotesPanel() {
  const [notes, setNotes] = useState([]);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (search = "") => {
    try {
      const payload = await productivityRequest(`/notes?query=${encodeURIComponent(search)}`);
      setNotes(payload.notes || []);
    } catch (requestError) {
      setError(requestError.message);
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setEditingId("");
  };

  const save = async (event) => {
    event.preventDefault();
    if (!draft.title.trim() || !draft.content.trim() || busy) return;
    setBusy(true);
    setError("");
    const payload = {
      title: draft.title,
      content: draft.content,
      tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    };
    try {
      if (editingId) {
        await productivityRequest(`/notes/${editingId}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await productivityRequest("/notes", { method: "POST", body: JSON.stringify(payload) });
      }
      reset();
      await load(query);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const edit = (note) => {
    setEditingId(note.id);
    setDraft({ title: note.title, content: note.content, tags: (note.tags || []).join(", ") });
    setError("");
  };

  const togglePin = async (note) => {
    try {
      await productivityRequest(`/notes/${note.id}`, { method: "PUT", body: JSON.stringify({ pinned: !note.pinned }) });
      await load(query);
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const remove = async (note) => {
    try {
      await productivityRequest(`/notes/${note.id}`, { method: "DELETE" });
      if (editingId === note.id) reset();
      await load(query);
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  return (
    <section className="productivity-tool" data-testid="productivity-notes-panel">
      <div className="productivity-tool-head">
        <div><StickyNote size={17} /><div><h3>SmartNotes</h3><p>Notes privees, tags et epinglage local.</p></div></div>
      </div>
      <form className="productivity-form productivity-compact-form" onSubmit={save}>
        <label>TITRE<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={180} placeholder="Nouvelle note" /></label>
        <label>CONTENU<textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} maxLength={50000} placeholder="Capturez une idee, une decision ou un compte rendu..." /></label>
        <label>TAGS<input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} placeholder="client, projet, idee" /></label>
        <div className="productivity-form-footer">
          {editingId ? <button type="button" className="productivity-secondary-btn" onClick={reset}><X size={13} /> ANNULER</button> : <span />}
          <button type="submit" className="productivity-primary-btn" disabled={busy}>
            {busy ? <Loader2 size={14} className="productivity-spin" /> : editingId ? <Check size={14} /> : <Plus size={14} />} {editingId ? "METTRE A JOUR" : "AJOUTER"}
          </button>
        </div>
      </form>

      <div className="productivity-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void load(query); } }} placeholder="Rechercher dans les notes..." /><button type="button" onClick={() => void load(query)} aria-label="Rechercher">OK</button></div>
      {error && <div className="productivity-error" role="alert">{error}</div>}
      <div className="productivity-list">
        {!notes.length && <p className="productivity-empty">Aucune note pour le moment.</p>}
        {notes.map((note) => (
          <article className={`productivity-note ${note.pinned ? "is-pinned" : ""}`} key={note.id}>
            <div><h4>{note.title}</h4><p>{note.content}</p><div className="productivity-tags">{(note.tags || []).map((tag) => <span key={tag}>{tag}</span>)}</div></div>
            <aside><button type="button" onClick={() => togglePin(note)} title="Epingler"><Pin size={13} fill={note.pinned ? "currentColor" : "none"} /></button><button type="button" onClick={() => edit(note)} title="Modifier"><Pencil size={13} /></button><button type="button" onClick={() => remove(note)} title="Supprimer"><Trash2 size={13} /></button></aside>
          </article>
        ))}
      </div>
    </section>
  );
}
