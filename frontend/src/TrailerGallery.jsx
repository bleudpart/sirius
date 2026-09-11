// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useState } from "react";
import { X, Clapperboard, Download, Maximize2 } from "lucide-react";
import "./Trailer.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const BACKEND = process.env.REACT_APP_BACKEND_URL || "";

export default function TrailerGallery({ onClose }) {
  const [data, setData] = useState(null);
  const [zoom, setZoom] = useState(null);

  useEffect(() => {
    fetch(`${API}/trailer/shots`).then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, []);

  return (
    <div className="prime-screen trailer-screen" data-testid="trailer-gallery">
      <header className="zeus-head">
        <div className="oracle-title font-divine"><Clapperboard size={20} /> TRAILER# — CLICHÉS CINÉMATIQUES</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="trailer-close-btn"><X size={18} /></button>
      </header>
      <div className="prime-sub">STYLE BLOCKBUSTER · 9:16 RÉSEAUX SOCIAUX · TIKTOK / INSTAGRAM / YOUTUBE SHORTS</div>

      <div className="argus-body">
        {data && (
          <>
            <div className="tr-toolbar">
              <a className="tr-download" href={`${BACKEND}${data.downloadUrl}`} download data-testid="trailer-download-btn">
                <Download size={14} /> TÉLÉCHARGER LES 7 CLICHÉS (ZIP)
              </a>
            </div>
            <div className="tr-grid" data-testid="trailer-grid">
              {data.shots.map((s) => (
                <figure key={s.id} className="tr-card" data-testid={`trailer-shot-${s.id}`}>
                  <div className="tr-imgwrap" onClick={() => setZoom(s)}>
                    <img src={`${BACKEND}${s.image}`} alt={s.title} draggable={false} />
                    <span className="tr-num">{s.id}</span>
                    <span className="tr-zoom"><Maximize2 size={14} /></span>
                  </div>
                  <figcaption>
                    <div className="tr-title">{s.title}</div>
                    <div className="tr-desc">{s.desc}</div>
                  </figcaption>
                </figure>
              ))}
            </div>
          </>
        )}
      </div>

      {zoom && (
        <div className="tr-lightbox" onClick={() => setZoom(null)} data-testid="trailer-lightbox">
          <img src={`${BACKEND}${zoom.image}`} alt={zoom.title} />
          <div className="tr-lb-caption">{zoom.id}. {zoom.title}</div>
        </div>
      )}
    </div>
  );
}
