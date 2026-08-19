// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
// Lecteur Spotify intégré au HUD : recherche + lecteur embarqué + morceau en cours.
import { useState } from "react";
import { X, Music, Search, Radio, MonitorSpeaker, Loader2 } from "lucide-react";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

export default function SpotifyPanel({ onClose, tokens, onConnect, onRefreshToken, onRemotePlay, onNowPlaying, onShowTrack }) {
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [embed, setEmbed] = useState(null); // { id, title, artist }

  const search = async (e) => {
    if (e) e.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`${API}/spotify/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...tokens, query: q }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) { setError("Session Spotify expirée — reconnecte-toi."); setTracks(null); return; }
      if (!r.ok) { setError("Recherche Spotify impossible pour le moment."); return; }
      if (d.access_token && onRefreshToken) onRefreshToken(d.access_token);
      setTracks(d.tracks || []);
    } catch (err) {
      setError("Spotify injoignable.");
    } finally {
      setBusy(false);
    }
  };

  const pick = (t) => {
    setEmbed(t);
    if (onShowTrack) onShowTrack(t);
  };

  return (
    <div className="prime-screen spotify-screen" data-testid="spotify-panel">
      <header className="zeus-head">
        <div className="zeus-title font-divine"><Music size={20} /> SPOTIFY — LECTEUR</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="spotify-close-btn"><X size={18} /></button>
      </header>
      <div className="spotify-body">
        {!tokens || !tokens.access_token ? (
          <div className="spotify-connect" data-testid="spotify-connect-block">
            <p>Connecte ton compte Spotify pour chercher et lancer des titres depuis le HUD.</p>
            <button className="cmd-send" onClick={onConnect} data-testid="spotify-connect-btn"><Music size={14} /> CONNECTER SPOTIFY</button>
          </div>
        ) : (
          <>
            <form className="spotify-search" onSubmit={search}>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Titre, artiste, album…"
                data-testid="spotify-search-input"
              />
              <button type="submit" className="cmd-send" disabled={busy} data-testid="spotify-search-btn">
                {busy ? <Loader2 size={14} className="sp-spin" /> : <Search size={14} />} CHERCHER
              </button>
              <button type="button" className="file-btn spotify-now-btn" onClick={onNowPlaying} title="Qu'est-ce qui joue ?" data-testid="spotify-nowplaying-btn">
                <Radio size={13} /> EN ÉCOUTE
              </button>
            </form>
            {error && <div className="gcal-error" data-testid="spotify-error">{error}</div>}
            {embed && (
              <div className="spotify-embed" data-testid="spotify-embed">
                <iframe
                  key={embed.id}
                  title={`Spotify — ${embed.title}`}
                  src={`https://open.spotify.com/embed/track/${embed.id}?utm_source=generator&theme=0`}
                  width="100%"
                  height="152"
                  frameBorder="0"
                  allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                  loading="lazy"
                />
              </div>
            )}
            {tracks && !tracks.length && <div className="gcal-empty">Aucun titre trouvé.</div>}
            {tracks && tracks.length > 0 && (
              <div className="spotify-results" data-testid="spotify-results">
                {tracks.map((t) => (
                  <div key={t.id} className={`spotify-track ${embed && embed.id === t.id ? "active" : ""}`} data-testid="spotify-track">
                    <button className="spotify-track-main" onClick={() => pick(t)} title="Écouter dans le HUD">
                      {t.image ? <img src={t.image} alt="" /> : <Music size={18} />}
                      <span className="spotify-track-txt">
                        <b>{t.title}</b>
                        <i>{t.artist}</i>
                      </span>
                    </button>
                    <button
                      className="file-btn spotify-device-btn"
                      onClick={() => onRemotePlay(`${t.title} ${t.artist}`)}
                      title="Lire sur mon appareil Spotify (Premium)"
                      data-testid="spotify-remote-btn"
                    >
                      <MonitorSpeaker size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!tracks && !embed && (
              <p className="spotify-hint">Cherche un titre puis clique dessus : il se lance dans le lecteur intégré ci-dessus (lecture complète si tu es connecté à Spotify dans ce navigateur, sinon extrait). L'icône écran lance la lecture sur ton appareil Spotify actif (Premium).</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
