import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, Loader2, Music2, Radio, X } from "lucide-react";

import MediaPlayer from "./MediaPlayer";
import { MEDIA_PROVIDERS, useMediaControl } from "@/ws/media_control";
import "./media.css";

function intentKey(intent) {
  return JSON.stringify(intent || {});
}

export default function MediaHUD({ onClose, onShowOnDisplay, initialIntent, standalone = false }) {
  const {
    state,
    connected,
    busy,
    error,
    clearError,
    refresh,
    resolveMedia,
    controlMedia,
  } = useMediaControl();
  const [provider, setProvider] = useState(initialIntent?.provider || "youtube");
  const [query, setQuery] = useState(initialIntent?.query || "");
  const appliedIntent = useRef("");
  const initialKey = useMemo(() => intentKey(initialIntent), [initialIntent]);

  const resolve = useCallback(async (event) => {
    if (event) event.preventDefault();
    const cleanedQuery = query.trim();
    if (!cleanedQuery) return;
    await resolveMedia({ provider, query: cleanedQuery });
  }, [provider, query, resolveMedia]);

  useEffect(() => {
    if (!initialKey || initialKey === "{}" || appliedIntent.current === initialKey) return;
    appliedIntent.current = initialKey;
    const intent = initialIntent || {};
    const selectedProvider = intent.provider || "youtube";
    const command = intent.command || "resolve";
    const selectedQuery = (intent.query || "").trim();
    setProvider(selectedProvider);
    setQuery(selectedQuery);

    const applyIntent = async () => {
      if (command === "pause" || command === "stop") {
        await refresh();
        await controlMedia({ action: command });
        return;
      }
      if (!selectedQuery) return;
      const resolved = await resolveMedia({ provider: selectedProvider, query: selectedQuery });
      if (resolved && command === "play") {
        await controlMedia({ action: "play" });
      }
    };
    void applyIntent();
  }, [controlMedia, initialIntent, initialKey, refresh, resolveMedia]);

  const showOnDisplay = () => {
    if (!state || !onShowOnDisplay) return;
    onShowOnDisplay(state, controlMedia);
  };

  return (
    <section className={`media-hud ${standalone ? "media-hud-standalone" : ""}`} data-testid="media-hud">
      <header className="media-hud-header">
        <div>
          <span className="media-hud-kicker"><Radio size={13} /> MEDIA PROXY</span>
          <h2><Music2 size={19} /> CONTROLE MULTIMEDIA</h2>
        </div>
        <div className="media-hud-header-actions">
          <span className={`media-hud-link ${connected ? "is-connected" : ""}`}>
            <i /> {connected ? "SYNCHRONISE" : "HORS LIGNE"}
          </span>
          {onClose && (
            <button type="button" className="media-close-btn" onClick={onClose} aria-label="Fermer le module multimedia">
              <X size={17} />
            </button>
          )}
        </div>
      </header>

      <form className="media-hud-search" onSubmit={resolve}>
        <label>
          FOURNISSEUR
          <select value={provider} onChange={(event) => setProvider(event.target.value)} data-testid="media-provider">
            {MEDIA_PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label className="media-hud-query">
          RECHERCHE
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={240}
            placeholder="Titre, artiste, video, chaine ou lien officiel..."
            data-testid="media-query"
          />
        </label>
        <button type="submit" className="media-resolve-btn" disabled={busy || !query.trim()} data-testid="media-resolve">
          {busy ? <Loader2 size={15} className="media-spin" /> : <Clapperboard size={15} />} CHARGER
        </button>
      </form>

      {error && (
        <div className="media-hud-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={clearError}>FERMER</button>
        </div>
      )}

      <MediaPlayer state={state} onControl={controlMedia} compact={standalone} />

      {!standalone && state?.provider && (
        <div className="media-hud-footer">
          <button type="button" className="media-display-btn" onClick={showOnDisplay} data-testid="media-show-display">
            AFFICHER DANS SIRIUS DISPLAY
          </button>
        </div>
      )}
    </section>
  );
}

