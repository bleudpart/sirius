import { loadApiKeys } from "@/apiKeyStorage";
// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import {
  X, Eye, Sun, Cloud, CloudRain, CloudSnow, CloudFog, CloudLightning, CloudDrizzle,
  TrendingUp, TrendingDown, AlertTriangle, Newspaper, UserRound, Moon, Sunrise, Boxes,
  Trophy, Lightbulb, Mail, MessageCircle, Radio, ListTodo,
} from "lucide-react";
import MythosBackdrop from "@/MythosBackdrop";
import useDraggableCards from "@/useDraggableCards";
import Analysis3D from "@/Analysis3D";
import "./Oracle.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const EXTERNAL_BRIEFING_RESOURCES = [
  { key: "news", path: "/news/top", fallback: "/news/headlines?limit=4", normalize: normalizeItems },
  { key: "worldNews", path: "/news/world", fallback: "/news/headlines?q=monde&limit=4", normalize: normalizeItems },
  { key: "franceNews", path: "/news/france", fallback: "/news/headlines?q=France&limit=4", normalize: normalizeItems },
  { key: "sport", path: "/sport/results", fallback: "/news/headlines?q=sport&limit=4", normalize: normalizeItems },
  { key: "weather", path: "/weather/today", fallback: "/weather/current", normalize: normalizeWeather },
  { key: "fact", path: "/system/fact_of_day", normalize: normalizeFact },
  { key: "mails", path: "/mail/important", fallback: "/microsoft/mail?top=5", normalize: normalizeItems },
  { key: "messages", path: "/messages/important", fallback: "/outlook/emails", normalize: normalizeItems },
];

function normalizeItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["articles", "news", "results", "items", "mails", "messages"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function normalizeWeather(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload.weather && !Array.isArray(payload.weather) ? payload.weather : payload;
}

function normalizeFact(payload) {
  if (typeof payload === "string") return payload.trim();
  if (!payload || typeof payload !== "object") return "";
  for (const key of ["fact", "text", "content", "message", "description"]) {
    if (typeof payload[key] === "string" && payload[key].trim()) return payload[key].trim();
  }
  return "";
}

async function fetchBriefingResource(path, fallback, signal) {
  const request = async (endpoint) => {
    const response = await fetch(`${API}${endpoint}`, {
      credentials: "include",
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  try {
    return await request(path);
  } catch (error) {
    if (error?.name === "AbortError" || !fallback) throw error;
    return request(fallback);
  }
}

function briefingItemTitle(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return item.title || item.titre || item.subject || item.sujet || item.text || item.name || "";
}

function briefingItemDetail(item) {
  if (!item || typeof item !== "object") return "";
  return item.description || item.apercu || item.source || item.de || item.sender || "";
}

function BriefingItems({ items, error, emptyMessage }) {
  if (error) return <div className="memory-empty">Flux externe indisponible.</div>;
  if (!items.length) return <div className="memory-empty">{emptyMessage}</div>;
  return items.slice(0, 4).map((item, index) => {
    const title = briefingItemTitle(item);
    const detail = briefingItemDetail(item);
    const identifier = item && typeof item === "object" ? item.id || item.url : "";
    return (
      <div className="oracle-news-row" key={identifier || `${title}-${index}`}>
        <span className="oracle-news-theme">{index + 1}</span>
        <span className="oracle-news-text">{title || "Élément sans titre"}</span>
        {detail && <span className="prime-conf-note">{detail}</span>}
      </div>
    );
  });
}

function externalBriefingText(briefing) {
  if (briefing.loading) return "Connexion aux flux externes du briefing...";

  const headlines = [briefing.news, briefing.worldNews, briefing.franceNews]
    .flat()
    .map(briefingItemTitle)
    .filter(Boolean);
  const parts = [];
  if (headlines.length) parts.push(`À la une : ${headlines[0]}.`);
  if (briefing.weather) {
    const temperature = briefing.weather.temp ?? briefing.weather.temperature ?? briefing.weather.temperature_2m;
    const description = briefing.weather.description || briefing.weather.condition || "";
    if (temperature != null || description) {
      parts.push(`Météo : ${[temperature != null ? `${Math.round(temperature)} degrés` : "", description].filter(Boolean).join(", ")}.`);
    }
  }
  if (briefing.sport.length) parts.push(`Sport : ${briefingItemTitle(briefing.sport[0])}.`);
  if (briefing.fact) parts.push(`Fait du jour : ${briefing.fact}`);
  if (briefing.mails.length) parts.push(`${briefing.mails.length} mail${briefing.mails.length > 1 ? "s" : ""} important${briefing.mails.length > 1 ? "s" : ""}.`);
  if (briefing.messages.length) parts.push(`${briefing.messages.length} message${briefing.messages.length > 1 ? "s" : ""} important${briefing.messages.length > 1 ? "s" : ""}.`);
  return parts.length ? parts.join(" ") : "Aucune donnée externe n'est disponible pour le moment.";
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
  const [char, setChar] = useState(null);
  useEffect(() => {
    fetch((process.env.REACT_APP_BACKEND_URL || "") + "/api/mythos/characters")
      .then(r => r.json())
      .then(d => {
        const p = d.characters.find(c => c.module === "ORACLE#");
        setChar(p);
      });
  }, []);
  const [data, setData] = useState(null);
  const [mediaOracle, setMediaOracle] = useState(null);
  const [productivityOracle, setProductivityOracle] = useState(null);
  const [show3D, setShow3D] = useState(false);
  const [briefing, setBriefing] = useState({
    loading: true,
    errors: {},
    news: [],
    worldNews: [],
    franceNews: [],
    sport: [],
    weather: null,
    fact: "",
    mails: [],
    messages: [],
  });
  const starsRef = useRef(null);

  useEffect(() => {
    let avKey = "", waPhone = "", waKey = "";
    avKey = loadApiKeys().alphavantage || "";
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
    const controller = new AbortController();

    Promise.allSettled(
      EXTERNAL_BRIEFING_RESOURCES.map(async (resource) => [
        resource.key,
        resource.normalize(
          await fetchBriefingResource(resource.path, resource.fallback, controller.signal)
        ),
      ])
    ).then((results) => {
      if (controller.signal.aborted) return;

      const next = {
        loading: false,
        errors: {},
        news: [],
        worldNews: [],
        franceNews: [],
        sport: [],
        weather: null,
        fact: "",
        mails: [],
        messages: [],
      };
      results.forEach((result, index) => {
        const resource = EXTERNAL_BRIEFING_RESOURCES[index];
        if (result.status === "fulfilled") {
          next[result.value[0]] = result.value[1];
        } else {
          next.errors[resource.key] = true;
        }
      });
      setBriefing(next);
    });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    let active = true;
    const loadProductivityOracle = async () => {
      try {
        const response = await fetch(`${API}/productivity/oracle`, { credentials: "include" });
        if (!response.ok) throw new Error("Le flux Productivite est indisponible.");
        const payload = await response.json();
        if (active) setProductivityOracle(payload);
      } catch (error) {
        if (active) {
          setProductivityOracle({
            status: "unavailable",
            headline: error.message || "Le flux Productivite est indisponible.",
            tasks: {},
          });
        }
      }
    };
    void loadProductivityOracle();
    const timer = window.setInterval(loadProductivityOracle, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let timer;
    const loadMediaOracle = async () => {
      try {
        const response = await fetch(`${API}/media/oracle`, { credentials: "include" });
        if (!response.ok) throw new Error("Le flux multimedia est indisponible.");
        const payload = await response.json();
        if (active) setMediaOracle(payload);
      } catch (error) {
        if (active) {
          setMediaOracle({
            status: "unavailable",
            headline: error.message || "Le flux multimedia est indisponible.",
          });
        }
      }
    };
    void loadMediaOracle();
    timer = window.setInterval(loadMediaOracle, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
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
  const briefingText = externalBriefingText(briefing);

  return (
    <div className="prime-screen" data-testid="oracle-divin-panel" ref={dragRef}>
      <MythosBackdrop module="ORACLE#" state={data ? "idle" : "busy"} />
      <canvas ref={starsRef} className="prime-stars" />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><Eye size={20} /> ORACLE DIVIN</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="oracle-close-btn"><X size={18} /></button>
      </header>
      {char && (
        <img
          src={char.image}
          alt={char.character}
          className="mythos-avatar"
        />
      )}
      <div className="prime-sub">CENTRE DE PRÉDICTIONS — {data ? data.date : "CONSULTATION DES ASTRES..."}</div>

      <div className="prime-grid oracle-grid">
        {/* Infos du jour */}
        <section className="prime-card oracle-wide" data-testid="oracle-briefing">
          <div className="zc-section-title">
            <Sunrise size={12} style={{ marginRight: 6 }} />INFOS DU JOUR
            {!briefing.loading && (
              <button className="oracle-3d-btn" onClick={() => setShow3D(true)} data-testid="oracle-3d-btn">
                <Boxes size={11} /> VUE 3D
              </button>
            )}
          </div>
          <p className="oracle-briefing-text">{briefingText}</p>
        </section>

        {/* Météo */}
        <section className="prime-card oracle-wide" data-testid="oracle-weather">
          <div className="zc-section-title"><Sun size={12} style={{ marginRight: 6 }} />MÉTÉO</div>
          {briefing.loading && <div className="memory-empty">Chargement de la météo...</div>}
          {!briefing.loading && briefing.errors.weather && <div className="memory-empty">Flux externe indisponible.</div>}
          {!briefing.loading && !briefing.errors.weather && briefing.weather && (
            <div className="oracle-news-row">
              <span className="oracle-news-theme">{briefing.weather.ville || briefing.weather.city || "LOCAL"}</span>
              <span className="oracle-news-text">
                {briefing.weather.temp ?? briefing.weather.temperature ?? briefing.weather.temperature_2m ?? "—"}°
              </span>
              <span className="prime-conf-note">
                {briefing.weather.description || briefing.weather.condition || "Conditions indisponibles"}
              </span>
            </div>
          )}
          {!briefing.loading && !briefing.errors.weather && !briefing.weather && (
            <div className="memory-empty">Aucune météo disponible.</div>
          )}
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

        <section className="prime-card oracle-media-oracle" data-testid="oracle-media">
          <div className="zc-section-title"><Radio size={12} style={{ marginRight: 6 }} />FLUX MULTIMEDIA</div>
          <div className={`oracle-media-state state-${mediaOracle?.status || "loading"}`}>
            <i />
            <span>{mediaOracle?.status === "playing" ? "LECTURE ACTIVE" : mediaOracle?.status === "unavailable" ? "FLUX INDISPONIBLE" : "ETAT DU LECTEUR"}</span>
          </div>
          <p>{mediaOracle?.headline || "Consultation du controle multimedia..."}</p>
          {mediaOracle?.provider && (
            <div className="prime-conf-note">
              FOURNISSEUR {mediaOracle.provider.toUpperCase()} · {mediaOracle.recent_actions || 0} ACTION(S) RECENTE(S)
            </div>
          )}
        </section>

        <section className="prime-card oracle-productivity-oracle" data-testid="oracle-productivity">
          <div className="zc-section-title"><ListTodo size={12} style={{ marginRight: 6 }} />PRODUCTIVITE &amp; TRAVAIL</div>
          <div className={`oracle-productivity-state state-${productivityOracle?.status || "loading"}`}>
            <i />
            <span>{productivityOracle?.status === "focus" ? "FOCUS REQUIS" : productivityOracle?.status === "clear" ? "ESPACE A JOUR" : productivityOracle?.status === "unavailable" ? "FLUX INDISPONIBLE" : "LECTURE DES TACHES"}</span>
          </div>
          <p>{productivityOracle?.headline || "Consultation des priorites de travail..."}</p>
          <div className="oracle-productivity-counts">
            <span>A FAIRE <b>{productivityOracle?.tasks?.todo || 0}</b></span>
            <span>EN COURS <b>{productivityOracle?.tasks?.in_progress || 0}</b></span>
            <span>TERMINEES <b>{productivityOracle?.tasks?.done || 0}</b></span>
          </div>
        </section>

        {/* Actualités */}
        <section className="prime-card" data-testid="oracle-news">
          <div className="zc-section-title"><Newspaper size={12} style={{ marginRight: 6 }} />ACTUALITÉS</div>
          {briefing.loading ? <div className="memory-empty">Chargement des actualités...</div> : (
            <>
              <div className="prime-hab-label">À LA UNE</div>
              <BriefingItems items={briefing.news} error={briefing.errors.news} emptyMessage="Aucune actualité à la une." />
              <div className="prime-hab-label">MONDE</div>
              <BriefingItems items={briefing.worldNews} error={briefing.errors.worldNews} emptyMessage="Aucune actualité mondiale." />
              <div className="prime-hab-label">FRANCE</div>
              <BriefingItems items={briefing.franceNews} error={briefing.errors.franceNews} emptyMessage="Aucune actualité française." />
            </>
          )}
        </section>

        {/* Sport */}
        <section className="prime-card" data-testid="oracle-sport">
          <div className="zc-section-title"><Trophy size={12} style={{ marginRight: 6 }} />SPORT</div>
          {briefing.loading ? <div className="memory-empty">Chargement du sport...</div> : (
            <BriefingItems items={briefing.sport} error={briefing.errors.sport} emptyMessage="Aucun résultat sportif disponible." />
          )}
        </section>

        {/* Fait du jour */}
        <section className="prime-card" data-testid="oracle-fact-of-day">
          <div className="zc-section-title"><Lightbulb size={12} style={{ marginRight: 6 }} />FAIT DU JOUR</div>
          {briefing.loading && <div className="memory-empty">Chargement du fait du jour...</div>}
          {!briefing.loading && briefing.errors.fact && <div className="memory-empty">Flux externe indisponible.</div>}
          {!briefing.loading && !briefing.errors.fact && (
            <p className="oracle-briefing-text">{briefing.fact || "Aucun fait du jour disponible."}</p>
          )}
        </section>

        {/* Mails importants */}
        <section className="prime-card" data-testid="oracle-important-mail">
          <div className="zc-section-title"><Mail size={12} style={{ marginRight: 6 }} />MAILS IMPORTANTS</div>
          {briefing.loading ? <div className="memory-empty">Chargement des mails importants...</div> : (
            <BriefingItems items={briefing.mails} error={briefing.errors.mails} emptyMessage="Aucun mail important." />
          )}
        </section>

        {/* Messages importants */}
        <section className="prime-card" data-testid="oracle-important-messages">
          <div className="zc-section-title"><MessageCircle size={12} style={{ marginRight: 6 }} />MESSAGES IMPORTANTS</div>
          {briefing.loading ? <div className="memory-empty">Chargement des messages importants...</div> : (
            <BriefingItems items={briefing.messages} error={briefing.errors.messages} emptyMessage="Aucun message important." />
          )}
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
      {show3D && !briefing.loading && (
        <Analysis3D
          title={`BRIEFING · ${(data && data.date) || ""}`}
          text={briefingText}
          onClose={() => setShow3D(false)}
        />
      )}
    </div>
  );
}
