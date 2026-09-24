// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
import { useEffect, useState, useCallback } from "react";
import { X, Calendar, Plus, RefreshCw, LogOut, ExternalLink, Trash2 } from "lucide-react";
import ProviderLogo from "@/components/ProviderLogo";

const API = process.env.REACT_APP_BACKEND_URL;

function fmtDate(iso, allDay) {
  if (!iso) return "";
  const d = new Date(iso);
  if (allDay) return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" }) +
    " · " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export default function CalendarPanel({ onClose }) {
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ title: "", start: "", end: "" });
  const [showForm, setShowForm] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const s = await fetch(`${API}/api/calendar/status`, { credentials: "include" }).then((r) => r.json());
      setStatus(s);
      if (s.connected) {
        const r = await fetch(`${API}/api/calendar/events?max_results=12`, { credentials: "include" });
        if (!r.ok) throw new Error((await r.json()).detail || "Erreur agenda");
        setEvents((await r.json()).events);
      }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const connect = async () => {
    try {
      const r = await fetch(`${API}/api/oauth/calendar/login`, { credentials: "include" }).then((r) => r.json());
      window.location.href = r.authorization_url;
    } catch (e) { setErr("Connexion Google impossible : " + e.message); }
  };

  const disconnect = async () => {
    await fetch(`${API}/api/calendar/disconnect`, { method: "DELETE", credentials: "include" });
    setStatus({ connected: false }); setEvents([]);
  };

  const createEvent = async (e) => {
    e.preventDefault();
    if (!form.title.trim() || !form.start) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch(`${API}/api/calendar/events`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error((await r.json()).detail || "Création refusée");
      setForm({ title: "", start: "", end: "" });
      setShowForm(false);
      refresh();
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };

  const removeEvent = async (id) => {
    await fetch(`${API}/api/calendar/events/${id}`, { method: "DELETE", credentials: "include" });
    setEvents((evs) => evs.filter((x) => x.id !== id));
  };

  return (
    <div className="prime-screen" data-testid="calendar-panel">
      <header className="zeus-head">
        <div className="zeus-title font-divine"><ProviderLogo provider="google" size={20} title="Google" /> AGENDA — GOOGLE CALENDAR</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="calendar-close-btn"><X size={18} /></button>
      </header>

      <div className="gcal-body">
        {status && !status.connected && (
          <div className="gcal-connect" data-testid="calendar-connect-block">
            <p>Connectez votre compte Google pour consulter et créer vos événements depuis ΣIRIUS.</p>
            <button className="cmd-send" onClick={connect} data-testid="calendar-connect-btn">
              <ProviderLogo provider="google" size={16} /> CONNECTER GOOGLE CALENDAR
            </button>
          </div>
        )}

        {status && status.connected && (
          <>
            <div className="gcal-toolbar">
              <span className="gcal-account" data-testid="calendar-account">{status.email}</span>
              <button className="file-btn" onClick={refresh} disabled={busy} data-testid="calendar-refresh-btn"><RefreshCw size={13} /> ACTUALISER</button>
              <button className={`file-btn ${showForm ? "danger" : ""}`} onClick={() => setShowForm(!showForm)} data-testid="calendar-add-btn"><Plus size={13} /> ÉVÉNEMENT</button>
              <button className="file-btn danger" onClick={disconnect} data-testid="calendar-disconnect-btn"><LogOut size={13} /> DÉCONNECTER</button>
            </div>

            {showForm && (
              <form className="gcal-form" onSubmit={createEvent} data-testid="calendar-form">
                <input type="text" placeholder="Titre de l'événement" value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })} data-testid="calendar-form-title" />
                <input type="datetime-local" value={form.start}
                  onChange={(e) => setForm({ ...form, start: e.target.value })} data-testid="calendar-form-start" />
                <input type="datetime-local" value={form.end}
                  onChange={(e) => setForm({ ...form, end: e.target.value })} data-testid="calendar-form-end" />
                <button type="submit" className="cmd-send" disabled={busy} data-testid="calendar-form-submit">CRÉER</button>
              </form>
            )}

            <div className="gcal-list" data-testid="calendar-events-list">
              {busy && !events.length && <div className="gcal-empty">Chargement de l'agenda…</div>}
              {!busy && !events.length && <div className="gcal-empty" data-testid="calendar-empty">Aucun événement à venir.</div>}
              {events.map((ev) => (
                <div className="gcal-event" key={ev.id} data-testid="calendar-event-row">
                  <div className="gcal-event-main">
                    <b>{ev.title}</b>
                    <span>{fmtDate(ev.start, ev.allDay)}{ev.location ? ` — ${ev.location}` : ""}</span>
                  </div>
                  {ev.link && <a className="file-btn" href={ev.link} target="_blank" rel="noreferrer" title="Ouvrir dans Google Agenda"><ExternalLink size={13} /></a>}
                  <button className="file-btn danger" onClick={() => removeEvent(ev.id)} title="Supprimer" data-testid="calendar-event-delete"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          </>
        )}

        {err && <div className="gcal-error" data-testid="calendar-error">{err}</div>}
      </div>
    </div>
  );
}
