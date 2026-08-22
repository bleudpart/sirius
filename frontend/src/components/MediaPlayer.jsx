import { ExternalLink, Pause, Play, Square } from "lucide-react";

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

export default function MediaPlayer({ state, onControl, compact = false }) {
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
  const control = (action) => {
    if (onControl) void onControl({ action });
  };
  const openExternal = () => {
    if (canOpen) window.open(state.external_url, "_blank", "noopener,noreferrer");
  };

  return (
    <section className={`media-player media-player-${state.provider} ${playable ? "is-playing" : ""} ${compact ? "is-compact" : ""}`} data-testid="media-player">
      <div className="media-player-meta">
        <span className="media-player-provider">{state.provider}</span>
        <strong>{state.title || "Media SIRIUS"}</strong>
        <span className={`media-player-status status-${state.status || "idle"}`}>{state.status || "idle"}</span>
      </div>

      {canEmbed ? (
        <div className="media-player-frame">
          <iframe
            key={state.embed_url}
            src={state.embed_url}
            title={`${state.provider} - ${state.title || "media"}`}
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
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

      <div className="media-player-controls" aria-label="Controles multimedia">
        <button type="button" className="media-control-btn" onClick={() => control(playable ? "pause" : "play")} data-testid="media-toggle-play">
          {playable ? <Pause size={15} /> : <Play size={15} />} {playable ? "PAUSE" : "LECTURE"}
        </button>
        <button type="button" className="media-control-btn media-stop-btn" onClick={() => control("stop")} data-testid="media-stop">
          <Square size={13} /> STOP
        </button>
        {canOpen && canEmbed && (
          <button type="button" className="media-control-btn media-external-btn" onClick={openExternal} data-testid="media-player-external">
            <ExternalLink size={13} /> EXTERNE
          </button>
        )}
      </div>
    </section>
  );
}

