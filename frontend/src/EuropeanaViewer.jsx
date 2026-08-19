// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useState } from "react";
import { X, Search, Landmark } from "lucide-react";
import StarField from "@/StarField";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

// Visionneuse Europeana : recherche d'archives culturelles européennes
export default function EuropeanaViewer({ onClose, onImage }) {
  const [query, setQuery] = useState("");
  const [images, setImages] = useState([]);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const search = async (e) => {
    if (e) e.preventDefault();
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`${API}/europeana/search?q=${encodeURIComponent(q)}&rows=12`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setImages(d.images || []);
        setTotal(d.total ?? 0);
        if (!(d.images || []).length) setError("Aucune archive trouvée pour cette recherche.");
      } else {
        setError(d.detail || "Recherche indisponible.");
      }
    } catch (err) {
      setError("Recherche indisponible.");
    }
    setLoading(false);
  };

  return (
    <div className="eu-screen" data-testid="europeana-viewer">
      <StarField density={0.5} />
      <div className="eu-head">
        <h2 className="eu-title"><Landmark size={18} /> ARCHIVES EUROPEANA</h2>
        <button className="av-close" onClick={onClose} data-testid="europeana-close" title="Fermer">
          <X size={18} />
        </button>
      </div>
      <form className="eu-search" onSubmit={search}>
        <input
          className="eu-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher dans 50 millions d'archives... (ex : Napoléon, cathédrale, Renaissance)"
          data-testid="europeana-search-input"
          autoFocus
        />
        <button type="submit" className="eu-btn" disabled={loading} data-testid="europeana-search-btn">
          <Search size={14} /> {loading ? "RECHERCHE..." : "EXPLORER"}
        </button>
      </form>
      {total != null && !error && (
        <div className="eu-total" data-testid="europeana-total">
          {Number(total).toLocaleString("fr-FR")} documents — {images.length} affichés
        </div>
      )}
      {error && <div className="eu-error" data-testid="europeana-error">{error}</div>}
      <div className="eu-grid" data-testid="europeana-grid">
        {images.map((im, i) => (
          <figure key={i} className="hp-img eu-card" onClick={() => onImage(im)} title="Agrandir l'archive">
            <img src={im.url} alt={im.legende || "archive"} loading="lazy" data-testid={`europeana-img-${i}`} />
            <figcaption>{im.legende}{im.annee ? ` (${im.annee})` : ""}{im.source ? ` — ${im.source}` : ""}</figcaption>
          </figure>
        ))}
      </div>
      {!images.length && !error && !loading && (
        <div className="eu-hint">Tapez un sujet historique ou artistique, puis EXPLORER.<br />Un clic sur une archive l'ouvre en plein écran holographique.</div>
      )}
    </div>
  );
}
