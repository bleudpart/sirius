import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gsap } from "gsap";
import { animateWindowOpen, animateWindowClose, animateResizeSettle } from "../gsapAnimations";
import { Clapperboard, Loader2, Music2, Radio, X } from "lucide-react";

import MediaPlayer from "./MediaPlayer";
import { MEDIA_PROVIDERS, useMediaControl } from "@/ws/media_control";
import "./media.css";

const MEDIA_WINDOW_GEOMETRY = "sirius_media_window_geometry_v1";
const SPOTIFY_TOKENS_KEY = "sirius_spotify";
const MIN_WINDOW_WIDTH = 420;
const MIN_WINDOW_HEIGHT = 360;
let mediaWindowZ = 96;

const API = `${process.env.REACT_APP_BACKEND_URL || "http://127.0.0.1:8001"}/api`;

function readSpotifyTokens() {
  try { return JSON.parse(localStorage.getItem(SPOTIFY_TOKENS_KEY)) || null; } catch { return null; }
}

function isSpotifyLink(text) {
  return /^spotify:|open\.spotify\.com/i.test(text || "");
}

function intentKey(intent) {
  return JSON.stringify(intent || {});
}

function readGeometry() {
  try {
    return JSON.parse(localStorage.getItem(MEDIA_WINDOW_GEOMETRY)) || {};
  } catch {
    return {};
  }
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
  const windowRef = useRef(null);
  const appliedIntent = useRef("");
  const initialKey = useMemo(() => intentKey(initialIntent), [initialIntent]);

  const bringToFront = useCallback(() => {
    if (!standalone && windowRef.current) {
      mediaWindowZ += 1;
      windowRef.current.style.zIndex = String(mediaWindowZ);
    }
  }, [standalone]);

  const saveGeometry = useCallback((patch) => {
    if (standalone) return;
    try {
      localStorage.setItem(MEDIA_WINDOW_GEOMETRY, JSON.stringify({ ...readGeometry(), ...patch }));
    } catch {
      // The window remains usable when browser storage is unavailable.
    }
  }, [standalone]);

  useEffect(() => {
    const element = windowRef.current;
    if (!element || standalone) return undefined;

    const applyGeometry = () => {
      const saved = readGeometry();
      const maximumWidth = Math.max(320, window.innerWidth - 24);
      const maximumHeight = Math.max(280, window.innerHeight - 24);
      const width = Math.min(Math.max(MIN_WINDOW_WIDTH, Number(saved.width) || 860), maximumWidth);
      const height = Math.min(Math.max(MIN_WINDOW_HEIGHT, Number(saved.height) || 560), maximumHeight);
      const defaultLeft = Math.max(12, Math.round((window.innerWidth - width) / 2));
      const defaultTop = Math.max(12, Math.round((window.innerHeight - height) / 2));
      const left = Math.min(Math.max(0, Number.isFinite(Number(saved.left)) ? Number(saved.left) : defaultLeft), Math.max(0, window.innerWidth - 140));
      const top = Math.min(Math.max(0, Number.isFinite(Number(saved.top)) ? Number(saved.top) : defaultTop), Math.max(0, window.innerHeight - 60));

      Object.assign(element.style, {
        width: `${width}px`,
        height: `${height}px`,
        left: `${left}px`,
        top: `${top}px`,
        zIndex: String(++mediaWindowZ),
      });
    };

    applyGeometry();
    animateWindowOpen(element);
    window.addEventListener("resize", applyGeometry);
    return () => window.removeEventListener("resize", applyGeometry);
  }, [standalone]);

  const resolveSmart = useCallback(async ({ provider: targetProvider, query: rawQuery }) => {
    // Spotify n'a pas de page de recherche embarquable (Spotify ne fournit pas
    // d'iframe pour /search/...) : une recherche texte brute reste bloquée sur
    // "Ouvrez le résultat Spotify..." avec un bouton manuel. Si un compte Spotify
    // est déjà connecté, on utilise la recherche authentifiée (même route que le
    // lecteur Spotify dédié) pour récupérer un titre précis et le charger
    // directement dans le lecteur intégré, sans étape manuelle.
    if (targetProvider === "spotify" && rawQuery && !isSpotifyLink(rawQuery)) {
      const tokens = readSpotifyTokens();
      if (tokens && (tokens.access_token || tokens.refresh_token)) {
        try {
          const r = await fetch(`${API}/spotify/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...tokens, query: rawQuery }),
          });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d.access_token) {
            try { localStorage.setItem(SPOTIFY_TOKENS_KEY, JSON.stringify({ ...tokens, access_token: d.access_token })); } catch { /* stockage indisponible, sans impact */ }
          }
          const top = r.ok && Array.isArray(d.tracks) ? d.tracks[0] : null;
          if (top?.id) {
            return await resolveMedia({ provider: targetProvider, url: `spotify:track:${top.id}` });
          }
        } catch {
          // Repli silencieux : recherche brute ci-dessous (affiche "Ouvrir Spotify").
        }
      }
    }
    return resolveMedia({ provider: targetProvider, query: rawQuery });
  }, [resolveMedia]);

  const resolve = useCallback(async (event) => {
    if (event) event.preventDefault();
    const cleanedQuery = query.trim();
    if (!cleanedQuery) return;
    await resolveSmart({ provider, query: cleanedQuery });
  }, [provider, query, resolveSmart]);

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
      const resolved = await resolveSmart({ provider: selectedProvider, query: selectedQuery });
      if (resolved && command === "play") {
        await controlMedia({ action: "play" });
      }
    };
    void applyIntent();
  }, [controlMedia, initialIntent, initialKey, refresh, resolveSmart]);


  const showOnDisplay = () => {
    if (!state || !onShowOnDisplay) return;
    onShowOnDisplay(state, controlMedia);
  };

  const startDrag = (event) => {
    if (standalone || event.button !== 0 || event.target.closest("button, input, select, a")) return;
    const element = windowRef.current;
    gsap.killTweensOf(element);
    const bounds = element.getBoundingClientRect();
    const offsetX = event.clientX - bounds.left;
    const offsetY = event.clientY - bounds.top;
    element.classList.add("is-moving");
    bringToFront();

    const move = (moveEvent) => {
      const left = Math.min(Math.max(0, moveEvent.clientX - offsetX), Math.max(0, window.innerWidth - 140));
      const top = Math.min(Math.max(0, moveEvent.clientY - offsetY), Math.max(0, window.innerHeight - 60));
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
    };
    const stop = () => {
      element.classList.remove("is-moving");
      saveGeometry({ left: parseFloat(element.style.left) || 0, top: parseFloat(element.style.top) || 0 });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    event.preventDefault();
  };

  const startResize = (event) => {
    if (standalone || event.button !== 0) return;
    const element = windowRef.current;
    gsap.killTweensOf(element);
    const bounds = element.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    element.classList.add("is-moving");
    bringToFront();

    const move = (moveEvent) => {
      const maxWidth = Math.max(320, window.innerWidth - bounds.left);
      const maxHeight = Math.max(280, window.innerHeight - bounds.top);
      element.style.width = `${Math.min(Math.max(MIN_WINDOW_WIDTH, bounds.width + moveEvent.clientX - startX), maxWidth)}px`;
      element.style.height = `${Math.min(Math.max(MIN_WINDOW_HEIGHT, bounds.height + moveEvent.clientY - startY), maxHeight)}px`;
    };
    const stop = () => {
      element.classList.remove("is-moving");
      saveGeometry({
        width: parseFloat(element.style.width) || bounds.width,
        height: parseFloat(element.style.height) || bounds.height,
      });
      animateResizeSettle(element);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <section
      ref={windowRef}
      className={`media-hud ${standalone ? "media-hud-standalone" : "media-hud-window"}`}
      data-testid="media-hud"
      onPointerDown={bringToFront}
    >
      <header className="media-hud-header" onPointerDown={startDrag} data-testid="media-window-header">
        <div>
          <span className="media-hud-kicker"><Radio size={13} /> MEDIA PROXY</span>
          <h2><Music2 size={19} /> CONTROLE MULTIMEDIA</h2>
        </div>
        <div className="media-hud-header-actions">
          <span className={`media-hud-link ${connected ? "is-connected" : ""}`}>
            <i /> {connected ? "SYNCHRONISE" : "HORS LIGNE"}
          </span>
          {onClose && (
            <button type="button" className="media-close-btn"
              onClick={() => {
                if (windowRef.current) animateWindowClose(windowRef.current, onClose);
                else onClose();
              }}
              aria-label="Fermer le module multimedia">
              <X size={17} />
            </button>
          )}
        </div>
      </header>

      <div className="media-hud-body">
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
      </div>
      {!standalone && (
        <div
          className="media-window-resize"
          onPointerDown={startResize}
          role="separator"
          aria-label="Redimensionner la fenêtre multimédia"
          data-testid="media-window-resize"
        />
      )}
    </section>
  );
}
