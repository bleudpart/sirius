// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import {
  X, Eye, Sun, Cloud, CloudRain, CloudSnow, CloudFog, CloudLightning, CloudDrizzle,
  TrendingUp, TrendingDown, AlertTriangle, Newspaper, UserRound, Moon, Sunrise, Boxes,
} from "lucide-react";
import MythosBackdrop from "@/MythosBackdrop";
import useDraggableCards from "@/useDraggableCards";
import Analysis3D from "@/Analysis3D";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const DAYS = ["DIM", "LUN", "MAR", "MER", "JEU", "VEN", "SAM"];
function WIcon({ code, size = 22 }) {
  if (code === 0 || code === 1) return <Sun size={size} color="#ffd77a" />;
  if (code === 2 || code === 3) return <Cloud size={size} color="#9fc5d6" />;
  if (code >= 45 && code <= 48) return <CloudFog size={size} color="#9fc5d6" />;
  if (code >= 51 && code <= 57) return <CloudDrizzle size={size} color="#38bdf8" />;
  if (code >= 61 && code <= 82) return <CloudRain size={size} color="#38bdf8" />;
  if (code >= 71 && code <= 86) return <CloudSnow size={size} color="#e0f2fe" />;
  if (code >= 95) return <CloudLightning size={size} color="#ffe600" />;
  return <Cloud size={size} color="#9fc5d6" />;
}

function MarketRow({ m, unit }) {
  return (
    <div className="oracle-market-row">
      <span className="oracle-market-name">{m.name}</span>
      {m.price != null && <span className="oracle-market-price">{m.price.toLocaleString("fr-FR")} {m.currency || "€"}</span>}
      <span className={`oracle-signal ${m.signal === "HAUSSIER" ? "up" : "down"}`}>
        {m.signal === "HAUSSIER" ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
        {m.change > 0 ? "+" : ""}{m.change}{unit}
      </span>
      {m.volatile && <span className="oracle-volatile"><AlertTriangle size={11} /> VOLATIL</span>}
    </div>
  );
}

export default function OracleDivin({ onClose }) {
  const [data, setData] = useState(null);
  const [show3D, setShow3D] = useState(false);
  const starsRef = useRef(null);

  useEffect(() => {
    let avKey = "", waPhone = "", waKey = "";
    try { avKey = (JSON.parse(localStorage.getItem("sirius_keys")) || {}).alphavantage || ""; } catch { avKey = ""; }
    try {
      const n = JSON.parse(localStorage.getItem("sirius_notif")) || {};
      if (n.whatsapp && n.waNum && n.waKey) { waPhone = n.waNum; waKey = n.waKey; }
    } catch { waPhone = ""; }
    const extra = `${avKey ? `&av_key=${encodeURIComponent(avKey)}` : ""}${waPhone ? `&wa_phone=${encodeURIComponent(waPhone)}&wa_key=${encodeURIComponent(waKey)}` : ""}`;
    const go = (lat, lon) =>
      fetch(`${API}/oracle/overview?lat=${lat}&lon=${lon}${extra}`).then((r) => r.json()).then(setData).catch(() => {});
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => go(p.coords.latitude, p.coords.longitude),
        () => go(48.85, 2.35),
        { timeout: 3500 }
      );
    } else go(48.85, 2.35);
  }, []);

  useEffect(() => {
    const c = starsRef.current;
    const x = c.getContext("2d");
    let raf, running = true, t = 0;
    const resize = () => { c.width = window.innerWidth; c.height = window.innerHeight; };
    resize();
    window.addEventListener("resize", resize);
    const COLORS = ["255,150,40", "255,205,90", "0,220,255", "170,80,255", "255,255,255"];
    const stars = Array.from({ length: 130 }, () => ({
      x: Math.random(), y: Math.random(),
      r: Math.random() < 0.12 ? 1.6 + Math.random() * 1.6 : 0.4 + Math.random() * 1,
      c: COLORS[Math.floor(Math.random() * COLORS.length)],
      a: 0.15 + Math.random() * 0.45,
      tw: 0.6 + Math.random() * 2,
      ph: Math.random() * Math.PI * 2,
    }));
    const loop = () => {
      if (!running) return;
      t += 0.016;
      x.clearRect(0, 0, c.width, c.height);
      stars.forEach((s) => {
        const tw = 0.55 + 0.45 * Math.sin(t * s.tw + s.ph);
        x.fillStyle = `rgba(${s.c},${(s.a * tw).toFixed(3)})`;
        x.beginPath();
        x.arc(s.x * c.width, s.y * c.height, s.r, 0, Math.PI * 2);
        x.fill();
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);

  const dragRef = useDraggableCards([data]);

  return (
    <div className="prime-screen" data-testid="oracle-divin-panel" ref={dragRef}>
      <MythosBackdrop module="ORACLE#" state={data ? "idle" : "busy"} />
      <canvas ref={starsRef} className="prime-stars" />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><Eye size={20} /> ORACLE DIVIN</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="oracle-close-btn"><X size={18} /></button>
      </header>
      <div className="prime-sub">CENTRE DE PRÉDICTIONS — {data ? data.date : "CONSULTATION DES ASTRES..."}</div>

      <div className="prime-grid oracle-grid">
        {/* Briefing du matin */}
        <section className="prime-card oracle-wide" data-testid="oracle-briefing">
          <div className="zc-section-title">
            <Sunrise size={12} style={{ marginRight: 6 }} />BRIEFING DU MATIN
            {data && data.briefing && (
              <button className="oracle-3d-btn" onClick={() => setShow3D(true)} data-testid="oracle-3d-btn">
                <Boxes size={11} /> VUE 3D
              </button>
            )}
          </div>
          <p className="oracle-briefing-text">{data ? data.briefing : "Génération du briefing quotidien..."}</p>
        </section>

        {/* Météo 7 jours */}
        <section className="prime-card oracle-wide" data-testid="oracle-weather">
          <div className="zc-section-title"><Sun size={12} style={{ marginRight: 6 }} />PRÉVISIONS MÉTÉO — 7 JOURS</div>
          <div className="oracle-week">
            {data && data.weather.map((d) => (
              <div className="oracle-day" key={d.date}>
                <span className="oracle-day-name">{DAYS[new Date(d.date + "T12:00:00").getDay()]}</span>
                <WIcon code={d.code} />
                <b>{d.tmax}°</b>
                <span className="oracle-tmin">{d.tmin}°</span>
              </div>
            ))}
            {data && data.weather.length === 0 && <div className="memory-empty">Météo indisponible.</div>}
          </div>
        </section>

        {/* Marchés */}
        <section className="prime-card" data-testid="oracle-markets">
          <div className="zc-section-title"><TrendingUp size={12} style={{ marginRight: 6 }} />TENDANCES MARCHÉS</div>
          <div className="prime-hab-label">CRYPTO — TEMPS RÉEL (24H)</div>
          {data && data.crypto.map((m) => <MarketRow m={m} unit="%" key={m.name} />)}
          {data && data.crypto.length === 0 && <div className="memory-empty">Flux crypto indisponible.</div>}
          <div className="prime-hab-label">{data && data.stocks_live ? "ACTIONS — TEMPS RÉEL (ALPHA VANTAGE)" : "INDICES & ACTIONS — ESTIMATION DU JOUR"}</div>
          {data && data.stocks.map((m) => <MarketRow m={m} unit="%" key={m.name} />)}
        </section>

        {/* Actualités */}
        <section className="prime-card" data-testid="oracle-news">
          <div className="zc-section-title"><Newspaper size={12} style={{ marginRight: 6 }} />ACTUALITÉS &amp; ÉVÉNEMENTS</div>
          {data && data.news.map((n, i) => (
            <div className="oracle-news-row" key={i}>
              <span className="oracle-news-theme">{n.theme}</span>
              <span className="oracle-news-text">{n.text}</span>
              <div className="oracle-impact">
                <div className="zc-bar-track"><div className="zc-bar-fill" style={{ width: `${n.impact}%`, background: n.impact > 70 ? "#ff9500" : "#22d3ee", boxShadow: `0 0 8px ${n.impact > 70 ? "#ff9500" : "#22d3ee"}` }} /></div>
                <b>{n.impact}%</b>
              </div>
            </div>
          ))}
        </section>

        {/* Prédictions personnelles */}
        <section className="prime-card" data-testid="oracle-personal">
          <div className="zc-section-title"><UserRound size={12} style={{ marginRight: 6 }} />PRÉDICTIONS PERSONNELLES</div>
          {data && (
            <>
              <div className="zc-kv-row">
                <div className="zc-kv"><span>PIC D'ACTIVITÉ</span><b>{data.personal.peak_hour != null ? `${data.personal.peak_hour} H` : "—"}</b></div>
                <div className="zc-kv"><span>JOUR LE PLUS ACTIF</span><b>{data.personal.peak_day ? data.personal.peak_day.toUpperCase() : "—"}</b></div>
              </div>
              <div className="zc-kv-row">
                <div className="zc-kv"><span>CHARGE PRÉVUE</span><b>{data.personal.charge}</b></div>
                <div className="zc-kv"><span>CONFIANCE</span><b>{data.personal.confidence}%</b></div>
              </div>
              {data.personal.suggestion && <div className="prime-sugg" style={{ marginTop: 10 }}><span className="prime-sugg-num">★</span><span>{data.personal.suggestion}</span></div>}
            </>
          )}
        </section>

        {/* Astronomie */}
        <section className="prime-card" data-testid="oracle-astro">
          <div className="zc-section-title"><Moon size={12} style={{ marginRight: 6 }} />ÉVÉNEMENTS ASTRONOMIQUES</div>
          {data && (
            <div className="oracle-moon">
              <Moon size={34} color="#e0f2fe" style={{ filter: "drop-shadow(0 0 10px rgba(180,220,255,0.8))" }} />
              <div>
                <b className="oracle-moon-name">{data.moon.name}</b>
                <div className="prime-conf-note">ILLUMINATION {data.moon.illumination}%</div>
              </div>
            </div>
          )}
          {data && data.astro.map((e) => (
            <div className="oracle-astro-row" key={e.date}>
              <span className="prime-time">{e.date}</span>
              <span>{e.name}</span>
            </div>
          ))}
        </section>
      </div>
      {show3D && data && data.briefing && (
        <Analysis3D
          title={`BRIEFING · ${data.date || ""}`}
          text={data.briefing}
          onClose={() => setShow3D(false)}
        />
      )}
    </div>
  );
}
