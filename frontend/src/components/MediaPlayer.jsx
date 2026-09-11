import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Pause, Play, Square } from "lucide-react";

const PLAYER_SCRIPTS = new Map();

function loadPlayerScript(id, src, isReady) {
  if (isReady()) return Promise.resolve();
  if (PLAYER_SCRIPTS.has(id)) return PLAYER_SCRIPTS.get(id);

  const promise = new Promise((resolve, reject) => {
    const existing = document.getElementById(id);
    const script = existing || document.createElement("script");
    // L'evenement "load" du <script> signale seulement que le fichier a ete
    // telecharge/execute : certaines API (ex: Spotify Iframe API) ne remplissent
    // leur objet global qu'ensuite, de facon asynchrone (callback separe type
    // onSpotifyIframeApiReady). Rejeter immediatement ici provoquait un faux
    // "API lecteur indisponible." alors que l'API devenait prete l'instant d'apres.
    // On patiente donc un court instant (jusqu'a ~3s) avant d'abandonner.
    const waitForReady = (attemptsLeft) => {
      if (isReady()) { resolve(); return; }
      if (attemptsLeft <= 0) { reject(new Error("API lecteur indisponible.")); return; }
      setTimeout(() => waitForReady(attemptsLeft - 1), 100);
    };
    const onLoad = () => waitForReady(30);
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", () => reject(new Error("Impossible de charger l'API du lecteur.")), { once: true });
    if (!existing) {
      script.id = id;
      script.src = src;
      script.async = true;
      document.head.appendChild(script);
    }
  }).catch((error) => {
    PLAYER_SCRIPTS.delete(id);
    throw error;
  });
  PLAYER_SCRIPTS.set(id, promise);
  return promise;
}

function isTrustedUrl(url, provider, embed = false) {
  if (!url || !provider) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    const allowed = {
      deezer: ["deezer.com"],
      netflix: ["netflix.com"],
      spotify: ["spotify.com"],
      tiktok: ["tiktok.com"],
      twitch: ["twitch.tv"],
      youtube: embed ? ["youtube-nocookie.com"] : ["youtube.com", "youtu.be"],
    }[provider] || [];
    return allowed.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function spotifyUri(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.length >= 2 ? `spotify:${parts[0]}:${parts[1]}` : "";
  } catch {
    return "";
  }
}

function twitchChannel(url) {
  try {
    return new URL(url).searchParams.get("channel") || "";
  } catch {
    return "";
  }
}

function ControlledEmbed({ state, onReady, onPlayback, onError }) {
  const containerRef = useRef(null);
  const iframeRef = useRef(null);

  useEffect(() => {
    onReady(null);
    if (!state.controllable) return undefined;

    if (state.provider === "youtube") {
      const frame = iframeRef.current;
      if (!frame) return undefined;
      const send = (func) => {
        frame.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args: [] }), "https://www.youtube-nocookie.com");
      };
      onReady((action) => {
        if (action === "play") send("playVideo");
        if (action === "pause") send("pauseVideo");
        if (action === "stop") {
          send("stopVideo");
          send("seekTo");
        }
      });
      const onMessage = (event) => {
        if (event.origin !== "https://www.youtube-nocookie.com" || event.source !== frame.contentWindow) return;
        let payload = event.data;
        try { if (typeof payload === "string") payload = JSON.parse(payload); } catch { return; }
        if (payload?.event !== "onStateChange") return;
        if (payload.info === 1) onPlayback("play");
        if (payload.info === 2) onPlayback("pause");
        if (payload.info === 0) onPlayback("stop");
      };
      window.addEventListener("message", onMessage);
      frame.addEventListener("load", () => {
        frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: "sirius-media-player" }), "https://www.youtube-nocookie.com");
      }, { once: true });
      return () => {
        window.removeEventListener("message", onMessage);
        onReady(null);
      };
    }

    if (state.provider === "spotify") {
      let disposed = false;
      let controller;
      const previousReady = window.onSpotifyIframeApiReady;
      const apiReady = new Promise((resolve) => {
        if (window.SpotifyIframeApi) {
          resolve(window.SpotifyIframeApi);
          return;
        }
        window.onSpotifyIframeApiReady = (api) => {
          window.SpotifyIframeApi = api;
          if (typeof previousReady === "function") previousReady(api);
          resolve(api);
        };
      });
      const uri = spotifyUri(state.external_url);
      Promise.all([
        apiReady,
        loadPlayerScript("spotify-iframe-api", "https://open.spotify.com/embed/iframe-api/v1", () => !!window.SpotifyIframeApi),
      ]).then(([api]) => {
        if (disposed || !containerRef.current || !uri) return;
        api.createController(containerRef.current, { uri, height: 220 }, (createdController) => {
          if (disposed) {
            createdController.destroy?.();
            return;
          }
          controller = createdController;
          createdController.addListener?.("playback_update", (event) => {
            const data = event?.data || {};
            if (data.isPaused === false) onPlayback("play");
            else if (data.position === 0) onPlayback("stop");
            else onPlayback("pause");
          });
          onReady((action) => {
            if (action === "play") controller.resume();
            if (action === "pause") controller.pause();
            if (action === "stop") {
              controller.pause();
              controller.seek(0);
            }
          });
        });
      }).catch(onError);
      return () => {
        disposed = true;
        controller?.destroy?.();
        onReady(null);
      };
    }

    if (state.provider === "twitch") {
      let disposed = false;
      let player;
      loadPlayerScript("twitch-player-api", "https://player.twitch.tv/js/embed/v1.js", () => !!window.Twitch?.Player)
        .then(() => {
          if (disposed || !containerRef.current) return;
          const channel = twitchChannel(state.embed_url);
          if (!channel) throw new Error("Chaîne Twitch invalide.");
          player = new window.Twitch.Player(containerRef.current, {
            channel,
            width: "100%",
            height: 220,
            parent: [window.location.hostname || "localhost"],
          });
          player.addEventListener(window.Twitch.Player.PLAY, () => onPlayback("play"));
          player.addEventListener(window.Twitch.Player.PAUSE, () => onPlayback("pause"));
          player.addEventListener(window.Twitch.Player.ENDED, () => onPlayback("stop"));
          onReady((action) => {
            if (action === "play") player.play();
            if (action === "pause") player.pause();
            if (action === "stop") {
              player.pause();
              player.seek(0);
            }
          });
        })
        .catch(onError);
      return () => {
        disposed = true;
        player?.pause?.();
        onReady(null);
      };
    }

    return undefined;
  }, [onError, onPlayback, onReady, state.controllable, state.embed_url, state.external_url, state.provider]);

  if (state.provider === "youtube" || !state.controllable) {
    return (
      <iframe
        ref={iframeRef}
        key={state.embed_url}
        src={state.embed_url}
        title={`${state.provider} - ${state.title || "media"}`}
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
    );
  }
  return <div ref={containerRef} className="media-player-api-host" data-testid={`media-${state.provider}-player`} />;
}

export default function MediaPlayer({ state, onControl, compact = false }) {
  const commandRef = useRef(null);
  const lastSyncRef = useRef({ action: "", at: 0 });
  const [playerError, setPlayerError] = useState("");
  const [playerReady, setPlayerReady] = useState(false);

  const registerController = useCallback((controller) => {
    commandRef.current = controller;
    setPlayerReady(!!controller);
  }, []);
  const syncPlayback = useCallback((action) => {
    const now = Date.now();
    if (lastSyncRef.current.action === action && now - lastSyncRef.current.at < 750) return;
    lastSyncRef.current = { action, at: now };
    if (onControl) void onControl({ action });
  }, [onControl]);
  const reportPlayerError = useCallback((error) => {
    setPlayerError(error?.message || "Le lecteur ne peut pas être contrôlé.");
    setPlayerReady(false);
  }, []);

  useEffect(() => {
    setPlayerError("");
    setPlayerReady(false);
    commandRef.current = null;
  }, [state?.embed_url]);

  if (!state || !state.provider) {
    return (
      <div className="media-player media-player-empty" data-testid="media-player-empty">
        <span className="media-player-orbit" />
        <p>Selectionnez une plateforme et un contenu pour activer le lecteur.</p>
      </div>
    );
  }

  const playable = state.status === "playing";
  const canEmbed = state.embeddable && isTrustedUrl(state.embed_url, state.provider, true);
  const canOpen = isTrustedUrl(state.external_url, state.provider);
  const canControl = canEmbed && state.controllable && playerReady && !playerError;
  const control = async (action) => {
    if (!canControl || !commandRef.current) return;
    try {
      await commandRef.current(action);
      syncPlayback(action);
    } catch (error) {
      reportPlayerError(error);
    }
  };
  const openExternal = () => {
    if (canOpen) window.open(state.external_url, "_blank", "noopener,noreferrer");
  };

  return (
    <section className={`media-player media-player-${state.provider} ${playable ? "is-playing" : ""} ${compact ? "is-compact" : ""}`} data-testid="media-player">
      <div className="media-player-meta">
        <span className="media-player-provider">{state.provider}</span>
        <strong>{state.title || "Media ΣIRIUS"}</strong>
        <span className={`media-player-status status-${state.status || "idle"}`}>{state.status || "idle"}</span>
      </div>

      {canEmbed ? (
        <div className="media-player-frame">
          <ControlledEmbed
            state={state}
            onReady={registerController}
            onPlayback={syncPlayback}
            onError={reportPlayerError}
          />
        </div>
      ) : (
        <div className="media-player-external">
          <span className="media-player-orbit" />
          <p>{state.message || "Ce fournisseur utilise ses controles officiels dans le navigateur."}</p>
          {canOpen && (
            <button type="button" className="media-control-btn media-open-btn" onClick={openExternal} data-testid="media-open-external">
              <ExternalLink size={14} /> OUVRIR {state.provider}
            </button>
          )}
        </div>
      )}

      {playerError && <p className="media-player-error" role="alert">{playerError}</p>}
      <div className="media-player-controls" aria-label="Controles multimedia">
        <button
          type="button"
          className="media-control-btn"
          onClick={() => void control(playable ? "pause" : "play")}
          disabled={!canControl}
          title={!state.controllable ? "Ce contenu utilise les contrôles officiels de la plateforme" : !playerReady ? "Initialisation du lecteur…" : ""}
          data-testid="media-toggle-play"
        >
          {playable ? <Pause size={15} /> : <Play size={15} />} {playable ? "PAUSE" : "LECTURE"}
        </button>
        <button
          type="button"
          className="media-control-btn media-stop-btn"
          onClick={() => void control("stop")}
          disabled={!canControl}
          title={!state.controllable ? "Ce contenu utilise les contrôles officiels de la plateforme" : !playerReady ? "Initialisation du lecteur…" : ""}
          data-testid="media-stop"
        >
          <Square size={13} /> STOP
        </button>
        {!state.controllable && (
          <span className="media-control-notice">CONTRÔLES DANS LA PLATEFORME</span>
        )}
        {canOpen && canEmbed && (
          <button type="button" className="media-control-btn media-external-btn" onClick={openExternal} data-testid="media-player-external">
            <ExternalLink size={13} /> EXTERNE
          </button>
        )}
      </div>
    </section>
  );
}
