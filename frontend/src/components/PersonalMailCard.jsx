import { useEffect, useState } from "react";
import { Check, Loader2, Mail, Unplug } from "lucide-react";
import { withBackendResponse } from "@/lib/backendRequest";

const readJson = async (response) => {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Service indisponible (${response.status}).`);
  return data;
};
const post = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export default function PersonalMailCard() {
  const [status, setStatus] = useState({ loading: true, connected: false });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", imap_host: "", smtp_host: "", smtp_port: "465" });
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    withBackendResponse("/personal-mail/status", {}, readJson, { signal: controller.signal, timeoutMs: 20000 })
      .then((data) => setStatus({ loading: false, ...data }))
      .catch(() => { if (!controller.signal.aborted) setStatus({ loading: false, connected: false }); });
    return () => controller.abort();
  }, []);

  const change = (field, value) => {
    setError("");
    if (field === "email") setFound(null);
    setForm((current) => ({ ...current, [field]: value }));
  };

  const recognize = async () => {
    const email = form.email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
    try {
      setFound(await withBackendResponse(`/personal-mail/detect?email=${encodeURIComponent(email)}`, {}, readJson, { timeoutMs: 15000 }));
    } catch (cause) {
      setError(cause.message);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const manual = form.imap_host.trim() && form.smtp_host.trim()
      ? { imap_host: form.imap_host.trim(), smtp_host: form.smtp_host.trim(), smtp_port: Number(form.smtp_port) || 465 }
      : {};
    try {
      const data = await withBackendResponse("/personal-mail/connect", post({ email: form.email.trim(), password: form.password, ...manual }), readJson, { timeoutMs: 60000 });
      setStatus({ loading: false, ...data });
      try { window.localStorage.setItem("sirius_mail_provider", "personal"); } catch { /* stockage indisponible */ }
      setForm((current) => ({ ...current, password: "" }));
      setOpen(false);
    } catch (cause) {
      setError(cause.name === "AbortError" ? "Le fournisseur met trop de temps à répondre. Réessayez." : cause.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setError("");
    try {
      await withBackendResponse("/personal-mail/disconnect", post({}), readJson, { timeoutMs: 20000 });
      setStatus({ loading: false, connected: false });
    } catch (cause) {
      setError(cause.message);
    }
  };

  const oauth = found?.oauth === "google" ? "Google" : found?.oauth === "microsoft" ? "Microsoft" : "";
  return (
    <article className={`connection-item personal-mail ${status.connected ? "connected" : ""}`} data-testid="personal-mail-card">
      <span className="connection-icon"><Mail size={24} /></span>
      <div className="connection-main">
        <h2>Autre boîte mail</h2>
        <p>Orange · Free · SFR · La Poste · Yahoo · iCloud · et autres</p>
        {status.email && <small>{status.email}{status.label ? ` · ${status.label}` : ""}</small>}
      </div>
      <span className="connection-state">
        {status.loading ? <Loader2 size={15} className="spin" /> : status.connected ? <><Check size={14} /> Connecté</> : "Non connecté"}
      </span>
      {status.connected ? (
        <button type="button" className="connection-action secondary" onClick={disconnect}><Unplug size={15} /> Déconnecter</button>
      ) : !open ? (
        <button type="button" className="connection-action" disabled={status.loading} onClick={() => setOpen(true)}><Mail size={15} /> Connecter ma boîte</button>
      ) : (
        <form className="personal-mail-form" onSubmit={submit}>
          <label htmlFor="personal-mail-email">Votre adresse e-mail</label>
          <input id="personal-mail-email" type="email" autoComplete="email" required value={form.email} placeholder="prenom.nom@orange.fr"
            onChange={(event) => change("email", event.target.value)} onBlur={recognize} />
          {found?.known && !oauth && <p className="personal-mail-found"><Check size={14} /> {found.label} reconnu : réglages automatiques.</p>}
          {oauth && <p className="personal-mail-help">Cette adresse se connecte en un clic : utilisez le bouton « Connecter {oauth} » ci-dessus.</p>}
          {found?.help && <p className="personal-mail-help">{found.help}</p>}
          <label htmlFor="personal-mail-password">{found?.app_password ? "Mot de passe d’application" : "Mot de passe de votre messagerie"}</label>
          <input id="personal-mail-password" type="password" autoComplete="current-password" required value={form.password}
            onChange={(event) => change("password", event.target.value)} />
          {found && !found.known && <details className="personal-mail-advanced" open>
            <summary>Réglages avancés</summary>
            <p>Fournisseur non reconnu : recopiez les serveurs indiqués dans l’aide de votre messagerie.</p>
            <label htmlFor="personal-mail-imap">Serveur de réception (IMAP)</label>
            <input id="personal-mail-imap" value={form.imap_host} placeholder="imap.exemple.fr" onChange={(event) => change("imap_host", event.target.value)} />
            <label htmlFor="personal-mail-smtp">Serveur d’envoi (SMTP)</label>
            <input id="personal-mail-smtp" value={form.smtp_host} placeholder="smtp.exemple.fr" onChange={(event) => change("smtp_host", event.target.value)} />
            <label htmlFor="personal-mail-smtp-port">Port d’envoi</label>
            <select id="personal-mail-smtp-port" value={form.smtp_port} onChange={(event) => change("smtp_port", event.target.value)}>
              <option value="465">465 (SSL)</option>
              <option value="587">587 (STARTTLS)</option>
            </select>
          </details>}
          <small>Le mot de passe est vérifié auprès de votre fournisseur puis enregistré chiffré. Il n’est jamais affiché.</small>
          <div className="personal-mail-actions">
            <button type="button" className="connection-action secondary" disabled={busy} onClick={() => { setOpen(false); setError(""); }}>Annuler</button>
            <button type="submit" className="connection-action" disabled={busy || !!oauth}>
              {busy ? <><Loader2 size={15} className="spin" /> Vérification…</> : "Connecter"}
            </button>
          </div>
        </form>
      )}
      {error && <p className="connections-error personal-mail-error" role="alert">{error}</p>}
    </article>
  );
}
