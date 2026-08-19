// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Megaphone, Download, Maximize2, Copy, Check, Clapperboard, Volume2, Play, Film, Loader2 } from "lucide-react";
import { speakCinematic, cancelSpeech } from "./voice";
import "./Promo.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const BACKEND = process.env.REACT_APP_BACKEND_URL || "";

const CAPTION = `✨ SIRIUS — La plateforme d'intelligence opérationnelle.
Un assistant qui ne répond pas… un assistant qui AGIT. 🏛️ Une seule interface. Un seul cerveau. Un seul flux d'action.
⚡ Analyse. Automatise. Anticipe. Exécute. Moins de coûts, plus de vitesse, zéro friction — pour les entreprises comme pour les particuliers.
#SIRIUS #IA #Productivité #Automatisation #AssistantIntelligent #Innovation #Startup #FuturIsNow`;

function shotText(s) {
  return `PLAN ${s.id} — ${s.title} (${s.timecode})
Scène : ${s.scene}
Ambiance : ${s.ambiance}
Visuels : ${s.visuels}
Message : ${s.message}
Voix off : « ${s.voix} »`;
}

function fullScript(shots) {
  return `🎬 SIRIUS — STORYBOARD PUBLICITAIRE (${shots.length} plans · ~2 min)
Style : hologramme antique, or et cyan, rythme publicitaire premium.

${shots.map(shotText).join("\n\n")}

—
LÉGENDE RÉSEAUX SOCIAUX :
${CAPTION}`;
}

export default function PromoPanel({ onClose }) {
  const [data, setData] = useState(null);
  const [zoom, setZoom] = useState(null);
  const [copied, setCopied] = useState(null);
  const [playIdx, setPlayIdx] = useState(null);

  // Diaporama : lecture du plan courant par la voix cinématique de Sirius, puis plan suivant
  useEffect(() => {
    if (playIdx === null || !data) return;
    if (playIdx >= data.shots.length) { setPlayIdx(null); return; }
    const s = data.shots[playIdx];
    let done = false;
    const next = () => { if (!done) { done = true; setPlayIdx((i) => (i === null ? null : i + 1)); } };
    speakCinematic(s.voix, { onend: () => setTimeout(next, 700) });
    const safety = setTimeout(next, 15000);
    return () => clearTimeout(safety);
  }, [playIdx, data]);

  const stopShow = () => { cancelSpeech(); setPlayIdx(null); };

  // Nappe orchestrale sous la voix pendant le diaporama
  const musicRef = useRef(null);
  useEffect(() => {
    if (playIdx !== null && !musicRef.current) {
      const a = new Audio("/audio/ambiance.mp3");
      a.volume = 0.22; a.loop = true;
      a.play().catch(() => {});
      musicRef.current = a;
    }
    if (playIdx === null && musicRef.current) {
      const a = musicRef.current; musicRef.current = null;
      a.pause();
    }
  }, [playIdx]);
  useEffect(() => () => { if (musicRef.current) musicRef.current.pause(); }, []);

  // Export vidéo MP4 (rendu backend ffmpeg + voix edge-tts + musique)
  const [exportState, setExportState] = useState(null);
  const [exportPct, setExportPct] = useState(0);
  const [exportStep, setExportStep] = useState("");

  useEffect(() => {
    fetch(`${API}/promo/export/status`).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d && d.ready) setExportState("done");
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (exportState !== "running") return;
    const iv = setInterval(async () => {
      try {
        const d = await (await fetch(`${API}/promo/export/status`)).json();
        setExportPct(d.progress || 0);
        setExportStep(d.step || "");
        if (d.state === "done") setExportState("done");
        else if (d.state === "error") { setExportState("error"); setExportStep(d.error || "Erreur de rendu"); }
      } catch (e) { /* statut momentanément indisponible */ }
    }, 2500);
    return () => clearInterval(iv);
  }, [exportState]);

  const startExport = async (force = false) => {
    setExportState("running"); setExportPct(2); setExportStep("Préparation du studio");
    try {
      const d = await (await fetch(`${API}/promo/export${force ? "?force=true" : ""}`, { method: "POST" })).json();
      if (d.state === "done") setExportState("done");
    } catch { setExportState("error"); setExportStep("Backend injoignable"); }
  };

  useEffect(() => {
    if (playIdx === null) return;
    const onKey = (e) => { if (e.key === "Escape") { cancelSpeech(); setPlayIdx(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playIdx]);

  useEffect(() => {
    fetch(`${API}/promo/shots`).then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, []);

  const copy = (key, text) => {
    const done = () => { setCopied(key); setTimeout(() => setCopied(null), 1600); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  };

  const fallbackCopy = (text, done) => {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { /* copie refusée par le navigateur */ }
    document.body.removeChild(ta);
  };

  return (
    <div className="prime-screen promo-screen" data-testid="promo-panel">
      <header className="zeus-head">
        <div className="oracle-title font-divine"><Megaphone size={20} /> PROMO# — STORYBOARD VIDÉO</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="promo-close-btn"><X size={18} /></button>
      </header>
      <div className="prime-sub">{data ? data.shots.length : "…"} PLANS · ~2 MIN · 9:16 RÉSEAUX SOCIAUX · SCÈNE / AMBIANCE / VISUELS / MESSAGE / VOIX OFF</div>

      <div className="argus-body">
        {data && (
          <>
            <div className="promo-toolbar">
              <a className="promo-btn" href={`${BACKEND}${data.downloadUrl}`} download data-testid="promo-download-btn">
                <Download size={14} /> TÉLÉCHARGER LES {data.shots.length} CLICHÉS (ZIP)
              </a>
              <button className="promo-btn gold" onClick={() => copy("script", fullScript(data.shots))} data-testid="promo-copy-script-btn">
                {copied === "script" ? <Check size={14} /> : <Clapperboard size={14} />} {copied === "script" ? "SCRIPT COPIÉ !" : "COPIER LE SCRIPT COMPLET"}
              </button>
              <button className="promo-btn" onClick={() => copy("caption", CAPTION)} data-testid="promo-copy-caption-btn">
                {copied === "caption" ? <Check size={14} /> : <Copy size={14} />} {copied === "caption" ? "LÉGENDE COPIÉE !" : "COPIER LA LÉGENDE RÉSEAUX"}
              </button>
              <button className="promo-btn gold" onClick={() => setPlayIdx(0)} data-testid="promo-play-btn">
                <Play size={14} /> LECTURE DU FILM — VOIX SIRIUS
              </button>
              {exportState === "done" ? (
                <>
                  <a className="promo-btn gold" href={`${BACKEND}/api/promo/export/video`} download data-testid="promo-video-download-btn">
                    <Film size={14} /> TÉLÉCHARGER LA VIDÉO (MP4)
                  </a>
                  <button className="promo-btn" onClick={() => startExport(true)} title="Régénérer la vidéo" data-testid="promo-video-rebuild-btn">
                    <Loader2 size={14} /> RÉGÉNÉRER
                  </button>
                </>
              ) : exportState === "running" ? (
                <button className="promo-btn" disabled data-testid="promo-export-progress">
                  <Loader2 size={14} className="promo-spin" /> RENDU {exportPct}% — {exportStep}
                </button>
              ) : (
                <button className="promo-btn" onClick={() => startExport(false)} data-testid="promo-export-btn">
                  <Film size={14} /> EXPORTER LA VIDÉO MP4
                </button>
              )}
              {exportState === "error" && <span className="promo-export-err" data-testid="promo-export-error">{exportStep}</span>}
            </div>

            <div className="promo-grid" data-testid="promo-grid">
              {data.shots.map((s) => (
                <article key={s.id} className="promo-card" data-testid={`promo-shot-${s.id}`}>
                  <div className="promo-imgwrap" onClick={() => setZoom(s)}>
                    <img src={`${BACKEND}${s.image}`} alt={s.title} draggable={false} loading="lazy" />
                    <span className="promo-num">{s.id}</span>
                    <span className="promo-time">{s.timecode}</span>
                    <span className="promo-zoom"><Maximize2 size={14} /></span>
                  </div>
                  <div className="promo-body">
                    <div className="promo-title font-divine">{s.title}</div>
                    <div className="promo-field"><b>Scène</b>{s.scene}</div>
                    <div className="promo-field"><b>Ambiance</b>{s.ambiance}</div>
                    <div className="promo-field"><b>Visuels</b>{s.visuels}</div>
                    <div className="promo-field msg"><b>Message</b>{s.message}</div>
                    <div className="promo-voice"><Volume2 size={12} /> « {s.voix} »</div>
                    <button className="promo-copy-shot" onClick={() => copy(`shot${s.id}`, shotText(s))} data-testid={`promo-copy-shot-${s.id}`}>
                      {copied === `shot${s.id}` ? <Check size={12} /> : <Copy size={12} />} {copied === `shot${s.id}` ? "COPIÉ !" : "COPIER CE PLAN"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </div>

      {zoom && createPortal(
        <div className="promo-lightbox" onClick={() => setZoom(null)} data-testid="promo-lightbox">
          <img src={`${BACKEND}${zoom.image}`} alt={zoom.title} />
          <div className="promo-lb-caption">{zoom.id}. {zoom.title} — {zoom.timecode}</div>
        </div>,
        document.body
      )}

      {playIdx !== null && data && data.shots[playIdx] && createPortal(
        <div className="promo-show" data-testid="promo-slideshow" onClick={stopShow}>
          <img key={playIdx} src={`${BACKEND}${data.shots[playIdx].image}`} alt="" className="promo-show-img" />
          <div className="promo-show-veil" />
          <div className="promo-show-caption" key={`c${playIdx}`}>
            <div className="promo-show-plan font-divine">PLAN {data.shots[playIdx].id} — {data.shots[playIdx].title}</div>
            <div className="promo-show-voice">« {data.shots[playIdx].voix} »</div>
            <div className="promo-show-dots">
              {data.shots.map((_, i) => <span key={i} className={i === playIdx ? "on" : ""} />)}
            </div>
          </div>
          <button className="promo-show-exit" onClick={stopShow} data-testid="promo-slideshow-exit"><X size={18} /></button>
        </div>,
        document.body
      )}
    </div>
  );
}
