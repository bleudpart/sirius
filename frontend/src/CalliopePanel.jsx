// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// CALLIOPE# — Bibliothèque audio : recherche, écoute directe, téléchargement et classement de livres audio libres.
import { useCallback, useEffect, useRef, useState } from "react";
import { X, BookOpen, Search, Loader2, Play, Download, FolderOpen, Trash2, RefreshCw, SkipBack, SkipForward } from "lucide-react";
import MythosBackdrop from "@/MythosBackdrop";
import { ConfirmButton } from "@/ConfirmButton";
import "./Calliope.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const GENRES = ["Roman", "Policier", "Science-fiction", "Jeunesse", "Histoire", "Philosophie", "Poésie", "Théâtre", "Divers"];
const POS_KEY = "calliope_positions";

const loadPos = () => { try { return JSON.parse(localStorage.getItem(POS_KEY)) || {}; } catch (e) { return {}; } };
const savePos = (identifier, file, time) => {
  const all = loadPos();
  all[identifier] = { file, time: Math.floor(time), date: new Date().toISOString() };
  localStorage.setItem(POS_KEY, JSON.stringify(all));
};
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function Player({ src, label }) {
  return (
    <div className="cal-player">
      <span className="cal-track-name">{label}</span>
      <audio controls preload="none" src={src} data-testid="calliope-audio" />
    </div>
  );
}

// Lecture continue : les pistes s'enchaînent, la position est mémorisée et reprise
function BookPlayer({ book }) {
  const files = book.files || [];
  const saved = loadPos()[book.identifier];
  const savedIdx = saved ? Math.max(0, files.indexOf(saved.file)) : 0;
  const [idx, setIdx] = useState(savedIdx);
  const [resumeAt, setResumeAt] = useState(saved && files.indexOf(saved.file) >= 0 ? saved.time : 0);
  const audioRef = useRef(null);
  const lastSave = useRef(0);
  const src = files[idx] ? `${API}/calliope/stream/${book.genre_slug}/${book.identifier}/${encodeURIComponent(files[idx])}` : "";

  const go = (n, autoplay = true) => {
    if (n < 0 || n >= files.length) return;
    setResumeAt(0);
    setIdx(n);
    savePos(book.identifier, files[n], 0);
    if (autoplay) setTimeout(() => { try { audioRef.current && audioRef.current.play(); } catch (e) {} }, 120);
  };

  const onLoaded = () => {
    if (resumeAt > 2 && audioRef.current) {
      audioRef.current.currentTime = resumeAt;
      setResumeAt(0);
    }
  };

  const onTime = () => {
    const a = audioRef.current;
    if (!a) return;
    const now = Date.now();
    if (now - lastSave.current > 5000 && !a.paused) {
      lastSave.current = now;
      savePos(book.identifier, files[idx], a.currentTime);
    }
  };

  if (files.length === 0) return <span className="cal-empty">Aucune piste disponible pour l'instant.</span>;
  return (
    <div className="cal-bookplayer" data-testid="calliope-bookplayer">
      {saved && files.indexOf(saved.file) >= 0 && (
        <div className="cal-resume" data-testid="calliope-resume-info">
          Reprise : piste {files.indexOf(saved.file) + 1}/{files.length} à {fmtTime(saved.time)}
        </div>
      )}
      <div className="cal-nowplaying">
        <button className="cal-act" onClick={() => go(idx - 1)} disabled={idx === 0} title="Piste précédente" data-testid="calliope-prev-btn"><SkipBack size={13} /></button>
        <span className="cal-track-name cal-np-name" data-testid="calliope-current-track">{idx + 1}/{files.length} — {files[idx]}</span>
        <button className="cal-act" onClick={() => go(idx + 1)} disabled={idx >= files.length - 1} title="Piste suivante" data-testid="calliope-next-btn"><SkipForward size={13} /></button>
      </div>
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={src}
        className="cal-np-audio"
        onLoadedMetadata={onLoaded}
        onTimeUpdate={onTime}
        onPause={() => audioRef.current && savePos(book.identifier, files[idx], audioRef.current.currentTime)}
        onEnded={() => go(idx + 1)}
        data-testid="calliope-book-audio"
      />
      <div className="cal-tracklist">
        {files.map((f, i) => (
          <button key={f} className={`cal-trackrow ${i === idx ? "on" : ""}`} onClick={() => go(i)} data-testid="calliope-track-row">
            <Play size={10} /> {i + 1}. {f}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function CalliopePanel({ onClose }) {
  const [char, setChar] = useState(null);
  useEffect(() => {
    fetch((process.env.REACT_APP_BACKEND_URL || "") + "/api/mythos/characters")
      .then(r => r.json())
      .then(d => {
        const p = d.characters.find(c => c.module === "CALLIOPE#");
        setChar(p);
      });
  }, []);
  const [tab, setTab] = useState("search");
  const [q, setQ] = useState("");
  const [lang, setLang] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [genre, setGenre] = useState("Roman");
  const [customGenre, setCustomGenre] = useState("");
  const [tracks, setTracks] = useState({});
  const [openId, setOpenId] = useState(null);
  const [library, setLibrary] = useState([]);
  const [openBook, setOpenBook] = useState(null);
  const [notice, setNotice] = useState("");

  const search = async () => {
    if (!q.trim() || busy) return;
    setBusy(true); setResults(null); setNotice("");
    try {
      const r = await fetch(`${API}/calliope/search?q=${encodeURIComponent(q)}&lang=${lang}`);
      const d = await r.json();
      setResults(d.results || []);
    } catch (e) { setNotice("Recherche impossible — Archive.org injoignable."); }
    setBusy(false);
  };

  const loadTracks = async (identifier) => {
    if (openId === identifier) { setOpenId(null); return; }
    setOpenId(identifier);
    if (tracks[identifier]) return;
    try {
      const r = await fetch(`${API}/calliope/tracks/${identifier}`);
      const d = await r.json();
      setTracks((t) => ({ ...t, [identifier]: d.tracks || [] }));
    } catch (e) { setTracks((t) => ({ ...t, [identifier]: [] })); }
  };

  const refreshLibrary = useCallback(async () => {
    try {
      const r = await fetch(`${API}/calliope/library`);
      const d = await r.json();
      setLibrary(d.books || []);
    } catch (e) { /* silencieux */ }
  }, []);

  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);
  useEffect(() => {
    if (tab !== "library") return;
    const iv = setInterval(refreshLibrary, 5000);
    return () => clearInterval(iv);
  }, [tab, refreshLibrary]);

  const download = async (b) => {
    const g = (customGenre.trim() || genre);
    setNotice("");
    try {
      const r = await fetch(`${API}/calliope/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: b.identifier, title: b.title, author: b.author, genre: g }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setNotice(d.detail || "Téléchargement impossible."); return; }
      setNotice(`« ${b.title} » rejoint le dossier ${g} — téléchargement en cours.`);
      refreshLibrary();
    } catch (e) { setNotice("Téléchargement impossible — backend injoignable."); }
  };

  const removeBook = async (identifier) => {
    await fetch(`${API}/calliope/book/${identifier}`, { method: "DELETE" }).catch(() => {});
    setOpenBook(null);
    refreshLibrary();
  };

  const folders = library.reduce((acc, b) => {
    (acc[b.genre] = acc[b.genre] || []).push(b);
    return acc;
  }, {});

  return (
    <div className="prime-screen" data-testid="calliope-panel">
      <MythosBackdrop module="CALLIOPE#" state={busy ? "busy" : "idle"} />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><BookOpen size={20} /> CALLIOPE# — BIBLIOTHÈQUE AUDIO</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="calliope-close-btn"><X size={18} /></button>
      </header>
      {char && (
        <img
          src={char.image}
          alt={char.character}
          className="mythos-avatar"
        />
      )}
      <div className="prime-sub">LIVRES AUDIO LIBRES · LIBRIVOX & ARCHIVE.ORG · AUCUNE CLÉ REQUISE</div>

      <div className="cal-tabs">
        <button className={`cal-tab ${tab === "search" ? "on" : ""}`} onClick={() => setTab("search")} data-testid="calliope-tab-search"><Search size={12} /> RECHERCHER</button>
        <button className={`cal-tab ${tab === "library" ? "on" : ""}`} onClick={() => { setTab("library"); refreshLibrary(); }} data-testid="calliope-tab-library"><FolderOpen size={12} /> BIBLIOTHÈQUE</button>
      </div>

      {notice && <div className="cal-notice" data-testid="calliope-notice">{notice}</div>}

      {tab === "search" && (
        <div className="cal-body">
          <div className="cal-search-row">
            <input
              className="mg-consult-input cal-input"
              placeholder="Titre, auteur ou thème (ex : Jules Verne, Sherlock Holmes, philosophie…)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              data-testid="calliope-search-input"
            />
            <select className="cal-select" value={lang} onChange={(e) => setLang(e.target.value)} data-testid="calliope-lang-select">
              <option value="">Toutes langues</option>
              <option value="french OR fre">Français</option>
              <option value="english OR eng">Anglais</option>
            </select>
            <button className="mg-open" onClick={search} disabled={busy || !q.trim()} data-testid="calliope-search-btn">
              {busy ? <Loader2 size={13} className="spin" /> : <Search size={13} />} RECHERCHER
            </button>
          </div>
          <div className="cal-genre-row">
            <span className="cal-genre-label">Dossier de rangement :</span>
            <select className="cal-select" value={genre} onChange={(e) => setGenre(e.target.value)} data-testid="calliope-genre-select">
              {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <input
              className="cal-select cal-genre-free"
              placeholder="ou nouveau dossier…"
              value={customGenre}
              onChange={(e) => setCustomGenre(e.target.value)}
              data-testid="calliope-genre-custom"
            />
          </div>

          {results && results.length === 0 && <div className="cal-empty">Aucun livre trouvé — essayez un autre titre ou une autre langue.</div>}
          {results && results.map((b) => (
            <div key={b.identifier} className="cal-book" data-testid="calliope-result-row">
              <img className="cal-cover" src={`https://archive.org/services/img/${b.identifier}`} alt="" loading="lazy" onError={(e) => { e.target.style.display = "none"; }} />
              <div className="cal-book-main">
                <div className="cal-book-title">{b.title}</div>
                <div className="cal-book-meta">{b.author || "Auteur inconnu"} · {b.language} · {b.runtime || "durée n/c"}</div>
              </div>
              <button className="cal-act" onClick={() => loadTracks(b.identifier)} data-testid="calliope-listen-btn"><Play size={12} /> ÉCOUTER</button>
              <button className="cal-act gold" onClick={() => download(b)} data-testid="calliope-download-btn"><Download size={12} /> TÉLÉCHARGER</button>
              {openId === b.identifier && (
                <div className="cal-tracks">
                  {!tracks[b.identifier] && <Loader2 size={14} className="spin" />}
                  {(tracks[b.identifier] || []).slice(0, 30).map((t) => <Player key={t.name} src={t.url} label={t.name} />)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "library" && (
        <div className="cal-body">
          <div className="cal-lib-head">
            <span>{library.length} livre{library.length > 1 ? "s" : ""} · {Object.keys(folders).length} dossier{Object.keys(folders).length > 1 ? "s" : ""}</span>
            <button className="cal-act" onClick={refreshLibrary} data-testid="calliope-refresh-btn"><RefreshCw size={12} /> ACTUALISER</button>
          </div>
          {library.length === 0 && <div className="cal-empty">La bibliothèque est vide — Calliope attend vos premiers livres.</div>}
          {Object.entries(folders).map(([g, books]) => (
            <div key={g} className="cal-folder" data-testid="calliope-folder">
              <div className="cal-folder-head"><FolderOpen size={14} /> {g} <span className="cal-folder-count">{books.length}</span></div>
              {books.map((b) => (
                <div key={b.identifier} className="cal-book" data-testid="calliope-library-row">
                  <img className="cal-cover" src={`https://archive.org/services/img/${b.identifier}`} alt="" loading="lazy" onError={(e) => { e.target.style.display = "none"; }} data-testid="calliope-cover" />
                  <div
                    className="cal-book-main"
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenBook(openBook === b.identifier ? null : b.identifier)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpenBook(openBook === b.identifier ? null : b.identifier)}
                    style={{ cursor: "pointer" }}
                    data-testid="calliope-book-toggle"
                  >
                    <div className="cal-book-title">{b.title}</div>
                    <div className="cal-book-meta">
                      {b.author || "Auteur inconnu"} · {b.status === "prêt" ? `${(b.files || []).length} pistes` : b.status === "erreur" ? "échec du téléchargement" : `téléchargement ${b.progress || ""}`}
                    </div>
                  </div>
                  <span className={`cal-status ${b.status === "prêt" ? "ok" : b.status === "erreur" ? "ko" : ""}`}>{b.status.toUpperCase()}</span>
                  <ConfirmButton className="cal-act danger" title="Supprimer ce livre" testId="calliope-delete-btn" onConfirm={() => removeBook(b.identifier)}>
                    <Trash2 size={12} />
                  </ConfirmButton>
                  {openBook === b.identifier && (
                    <div className="cal-tracks">
                      <BookPlayer book={b} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
