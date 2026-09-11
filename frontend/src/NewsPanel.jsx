// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
import { useEffect, useState, useCallback, useRef } from "react";
import { X, Newspaper, RefreshCw, Search, Volume2, ExternalLink } from "lucide-react";
import { speakFr, cancelSpeech } from "@/voice";
import "./NewsPanel.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

export default function NewsPanel({ onClose }) {
  const [articles, setArticles] = useState([]);
  const [topic, setTopic] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const timerRef = useRef(null);

  const load = useCallback(async (q) => {
    setLoading(true); setErr("");
    try {
      const r = await fetch(`${API}/news/headlines?limit=10${q ? `&q=${encodeURIComponent(q)}` : ""}`);
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.articles) {
        setArticles(d.articles);
        setUpdatedAt(new Date());
      } else {
        setErr(r.status === 429 ? "Quota d'actualités du jour atteint (100 requêtes)." : (typeof d.detail === "string" ? d.detail : "Actualités indisponibles."));
      }
    } catch (e) { setErr("Actualités indisponibles — backend injoignable."); }
    setLoading(false);
  }, []);

  useEffect(() => {
    load(query);
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => load(query), 5 * 60 * 1000);
    return () => clearInterval(timerRef.current);
  }, [query, load]);
  useEffect(() => () => cancelSpeech(), []);

  const readAloud = () => {
    const top = articles.slice(0, 5).map((a) => a.titre).filter(Boolean);
    if (!top.length) return;
    cancelSpeech();
    speakFr(`Voici les titres${query ? ` sur ${query}` : ""} : ${top.join(". ")}.`);
  };

  const fmtDate = (iso) => {
    try { return new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return ""; }
  };

  return (
    <div className="prime-screen news-screen" data-testid="news-panel">
      <header className="zeus-head">
        <div className="oracle-title font-divine"><Newspaper size={20} /> ACTUALITÉS — FLUX EN DIRECT</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="news-close-btn"><X size={18} /></button>
      </header>

      <div className="np-bar">
        <div className="np-search">
          <Search size={14} />
          <input
            placeholder="Filtrer par sujet (ex : intelligence artificielle, bourse, sport…)"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setQuery(topic.trim()); }}
            data-testid="news-topic-input"
          />
          <button onClick={() => setQuery(topic.trim())} data-testid="news-search-btn">RECHERCHER</button>
          {query && <button className="np-clear" onClick={() => { setTopic(""); setQuery(""); }} data-testid="news-clear-btn">TOUT</button>}
        </div>
        <div className="np-actions">
          <button onClick={() => load(query)} disabled={loading} data-testid="news-refresh-btn"><RefreshCw size={13} className={loading ? "spin" : ""} /> ACTUALISER</button>
          <button onClick={readAloud} disabled={!articles.length} data-testid="news-speak-btn"><Volume2 size={13} /> ENTENDRE</button>
          {updatedAt && <span className="np-updated" data-testid="news-updated-at">Mis à jour à {updatedAt.toLocaleTimeString("fr-FR")}</span>}
        </div>
      </div>

      {err && <div className="np-err" data-testid="news-error">{err}</div>}
      {loading && !articles.length && <div className="np-loading" data-testid="news-loading">Chargement du flux…</div>}

      <div className="np-feed" data-testid="news-feed">
        {articles.map((a, i) => (
          <article className="np-card" key={`${a.url}-${i}`} style={{ animationDelay: `${i * 0.06}s` }} data-testid={`news-article-${i}`}>
            <div className="np-card-meta">
              <span className="np-source">{a.source || "—"}</span>
              <span className="np-date">{fmtDate(a.date)}</span>
            </div>
            <h3 className="np-title">{a.titre}</h3>
            {a.description && <p className="np-desc">{a.description}</p>}
            {a.url && (
              <a className="np-link" href={a.url} target="_blank" rel="noreferrer" data-testid={`news-link-${i}`}>
                {"LIRE L'ARTICLE"} <ExternalLink size={11} />
              </a>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
