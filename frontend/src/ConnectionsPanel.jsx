import { useCallback, useEffect, useRef, useState } from "react";
import { Browser } from "@capacitor/browser";
import { Check, Loader2, RefreshCw, Unplug, X } from "lucide-react";
import { API_BASE_URL } from "@/lib/api";
import ProviderLogo from "@/components/ProviderLogo";
import MailCachePanel from "@/components/MailCachePanel";
import { withBackendResponse } from "@/lib/backendRequest";
import "./ConnectionsPanel.css";

const PROVIDERS = {
  google: {
    label: "Google",
    detail: "Gmail · Agenda · Contacts",
    logo: "google",
    statusPath: "/calendar/status",
    authorizePath: "/oauth/calendar/login?external=true",
    disconnectPath: "/calendar/disconnect",
  },
  microsoft: {
    label: "Microsoft",
    detail: "Outlook · Agenda · Contacts",
    logo: "microsoft",
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

export default function ConnectionsPanel({ onClose, mailCache, onReadCachedMail }) {
  const [status, setStatus] = useState(initialStatus);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const authorization = useRef(null);

  const refresh = useCallback(async (signal) => {
    const entries = await Promise.all(Object.entries(PROVIDERS).map(async ([key, provider]) => {
      try {
        const data = await withBackendResponse(provider.statusPath, {}, async (response) => {
          const result = await response.json();
          if (!response.ok) throw new Error(result.detail || `Vérification ${provider.label} indisponible.`);
          return result;
        }, { signal, timeoutMs: 20000 });
        return [key, { connected: !!data.connected, email: data.email || "", loading: false }];
      } catch (cause) {
        if (!signal?.aborted) {
          setError(cause.name === "AbortError"
            ? `La vérification ${provider.label} a dépassé le délai prévu.`
            : cause.message || `Vérification ${provider.label} indisponible.`);
        }
        return [key, { connected: false, email: "", loading: false }];
      }
    }));
    const next = Object.fromEntries(entries);
    if (!signal?.aborted) setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      controller.abort();
      authorization.current?.abort();
    };
  }, [refresh]);

  const stopWaiting = () => {
    authorization.current?.abort();
    authorization.current = null;
    setPending("");
  };

  const checkConnection = useCallback(async (key, controller) => {
    const next = await refresh(controller.signal);
    if (!controller.signal.aborted && authorization.current === controller && next[key]?.connected) {
      controller.abort();
      authorization.current = null;
      setPending("");
      if (window.Capacitor?.isNativePlatform?.()) {
        Browser.close().catch((cause) => {
          console.error("Fermeture de la fenêtre de connexion impossible :", cause);
        });
      }
    }
  }, [refresh]);

  useEffect(() => {
    if (!pending) return undefined;
    const controller = authorization.current;
    if (!controller) return undefined;
    let checking = false;
    const timer = window.setInterval(async () => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try { await checkConnection(pending, controller); }
      finally { checking = false; }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pending, checkConnection]);

  const connect = async (key) => {
    authorization.current?.abort();
    const controller = new AbortController();
    authorization.current = controller;
    setError("");
    setPending(key);
    try {
      if (mailCache?.account && mailCache.clear(key) === false) throw new Error("Effacez le cache mail avant de changer de compte connecté.");
      const provider = PROVIDERS[key];
      const data = await withBackendResponse(provider.authorizePath, {}, async (response) => {
        const result = await response.json();
        if (!response.ok || !result.authorization_url) throw new Error(result.detail || "Connexion indisponible.");
        return result;
      }, { signal: controller.signal, timeoutMs: 20000 });
      if (controller.signal.aborted || authorization.current !== controller) return;
      await openAuthorization(data.authorization_url);
    } catch (connectionError) {
      if (controller.signal.aborted || authorization.current !== controller) return;
      controller.abort();
      authorization.current = null;
      setPending("");
      setError(connectionError.name === "AbortError"
        ? "La demande de connexion a dépassé le délai prévu. Réessayez."
        : connectionError.message || "Connexion indisponible.");
    }
  };

  const disconnect = async (key) => {
    setError("");
    try {
      if (mailCache?.account && mailCache.clear(key) === false) throw new Error("Effacement du cache impossible. Réessayez avant de déconnecter le compte.");
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
    } catch (cause) {
      console.error("Déconnexion du compte mail impossible :", cause);
      setError(cause.message || "Déconnexion impossible.");
    }
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
                <span className="connection-icon"><ProviderLogo provider={provider.logo} size={25} title={provider.label} /></span>
                <div className="connection-main">
                  <h2>{provider.label}</h2>
                  <p>{provider.detail}</p>
                  {providerStatus.email && <small>{providerStatus.email}</small>}
                </div>
                <span className="connection-state">
                  {providerStatus.loading ? <Loader2 size={15} className="spin" /> : providerStatus.connected ? <><Check size={14} /> Connecté</> : "Non connecté"}
                </span>
                {waiting ? (
                  <div className="connection-pending-actions">
                    <span className="connections-wait" role="status"><Loader2 size={15} className="spin" /> Autorisation en cours</span>
                    <button type="button" className="connection-action secondary" onClick={() => {
                      if (authorization.current) void checkConnection(key, authorization.current);
                    }}><RefreshCw size={15} /> Vérifier l’état</button>
                    <button type="button" className="connection-action secondary" onClick={stopWaiting}><X size={15} /> Arrêter l’attente</button>
                    <small>Arrêter l’attente ne révoque pas une autorisation déjà accordée. Vous pouvez fermer l’onglet du navigateur.</small>
                  </div>
                ) : providerStatus.connected ? (
                  <button type="button" className="connection-action secondary" onClick={() => disconnect(key)}>
                    <Unplug size={15} /> Déconnecter
                  </button>
                ) : (
                  <button type="button" className="connection-action" onClick={() => connect(key)} disabled={waiting || providerStatus.loading}>
                    {waiting ? <Loader2 size={15} className="spin" /> : <ProviderLogo provider={provider.logo} size={16} />}
                    {waiting ? "Autorisation en cours" : `Connecter ${provider.label}`}
                  </button>
                )}
              </article>
            );
          })}
        </div>

        {pending && <p className="connections-wait">Revenez dans ΣIRIUS après avoir validé l’autorisation.</p>}
        {error && <p className="connections-error" role="alert">{error}</p>}
        {mailCache && <MailCachePanel key={mailCache.account} cache={mailCache} onRead={onReadCachedMail} />}
        <div className="connections-footer-actions">
          <button type="button" className="connections-refresh" onClick={() => {
            if (pending && authorization.current) void checkConnection(pending, authorization.current);
            else void refresh();
          }}><RefreshCw size={14} /> Actualiser</button>
          <button type="button" className="connections-later" onClick={onClose}>Plus tard</button>
        </div>
      </main>
    </div>
  );
}
