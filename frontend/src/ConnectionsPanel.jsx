import { useCallback, useEffect, useState } from "react";
import { Browser } from "@capacitor/browser";
import { CalendarDays, Check, Loader2, Mail, RefreshCw, Unplug, X } from "lucide-react";
import { API_BASE_URL } from "@/lib/api";
import "./ConnectionsPanel.css";

const PROVIDERS = {
  google: {
    label: "Google",
    detail: "Gmail · Agenda · Contacts",
    Icon: Mail,
    statusPath: "/calendar/status",
    authorizePath: "/oauth/calendar/login?external=true",
    disconnectPath: "/calendar/disconnect",
  },
  microsoft: {
    label: "Microsoft",
    detail: "Outlook · Agenda · Contacts",
    Icon: CalendarDays,
    statusPath: "/microsoft/status",
    authorizePath: "/auth/microsoft/authorize",
    disconnectPath: "/microsoft/disconnect",
  },
};

const initialStatus = {
  google: { connected: false, loading: true },
  microsoft: { connected: false, loading: true },
};

async function openAuthorization(url) {
  if (window.Capacitor?.isNativePlatform?.()) {
    await Browser.open({ url, presentationStyle: "popover" });
    return;
  }
  window.open(url, "sirius-account-connection", "width=560,height=760");
}

export default function ConnectionsPanel({ onClose }) {
  const [status, setStatus] = useState(initialStatus);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const entries = await Promise.all(Object.entries(PROVIDERS).map(async ([key, provider]) => {
      try {
        const response = await fetch(`${API_BASE_URL}${provider.statusPath}`, { credentials: "include" });
        const data = await response.json().catch(() => ({}));
        return [key, { connected: response.ok && !!data.connected, email: data.email || "", loading: false }];
      } catch {
        return [key, { connected: false, email: "", loading: false }];
      }
    }));
    const next = Object.fromEntries(entries);
    setStatus(next);
    return next;
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!pending) return undefined;
    const timer = window.setInterval(async () => {
      const next = await refresh();
      if (next[pending]?.connected) {
        window.clearInterval(timer);
        setPending("");
        if (window.Capacitor?.isNativePlatform?.()) Browser.close().catch(() => {});
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);

  const connect = async (key) => {
    setError("");
    setPending(key);
    try {
      const provider = PROVIDERS[key];
      const response = await fetch(`${API_BASE_URL}${provider.authorizePath}`, { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.authorization_url) throw new Error(data.detail || "Connexion indisponible.");
      await openAuthorization(data.authorization_url);
    } catch (connectionError) {
      setPending("");
      setError(connectionError.message || "Connexion indisponible.");
    }
  };

  const disconnect = async (key) => {
    setError("");
    const provider = PROVIDERS[key];
    const response = await fetch(`${API_BASE_URL}${provider.disconnectPath}`, {
      method: "POST",
      credentials: "include",
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.detail || "Déconnexion impossible.");
      return;
    }
    await refresh();
  };

  return (
    <div className="connections-screen" data-testid="connections-panel">
      <header className="connections-header">
        <div>
          <span>COMPTES &amp; SERVICES</span>
          <h1>Centre des connexions</h1>
        </div>
        <button type="button" onClick={onClose} aria-label="Fermer" data-testid="connections-close"><X size={20} /></button>
      </header>

      <main className="connections-content">
        <div className="connections-list">
          {Object.entries(PROVIDERS).map(([key, provider]) => {
            const providerStatus = status[key];
            const waiting = pending === key;
            return (
              <article className={`connection-item ${providerStatus.connected ? "connected" : ""}`} key={key}>
                <span className="connection-icon"><provider.Icon size={22} /></span>
                <div className="connection-main">
                  <h2>{provider.label}</h2>
                  <p>{provider.detail}</p>
                  {providerStatus.email && <small>{providerStatus.email}</small>}
                </div>
                <span className="connection-state">
                  {providerStatus.loading ? <Loader2 size={15} className="spin" /> : providerStatus.connected ? <><Check size={14} /> Connecté</> : "Non connecté"}
                </span>
                {providerStatus.connected ? (
                  <button type="button" className="connection-action secondary" onClick={() => disconnect(key)}>
                    <Unplug size={15} /> Déconnecter
                  </button>
                ) : (
                  <button type="button" className="connection-action" onClick={() => connect(key)} disabled={waiting || providerStatus.loading}>
                    {waiting ? <Loader2 size={15} className="spin" /> : <provider.Icon size={15} />}
                    {waiting ? "Autorisation en cours" : `Connecter ${provider.label}`}
                  </button>
                )}
              </article>
            );
          })}
        </div>

        {pending && <p className="connections-wait">Revenez dans ΣIRIUS après avoir validé l’autorisation.</p>}
        {error && <p className="connections-error" role="alert">{error}</p>}
        <div className="connections-footer-actions">
          <button type="button" className="connections-refresh" onClick={refresh}><RefreshCw size={14} /> Actualiser</button>
          <button type="button" className="connections-later" onClick={onClose}>Plus tard</button>
        </div>
      </main>
    </div>
  );
}
