// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Panneaux HUD autonomes extraits d'App.js : mémoire, pop-ups holographiques,
// analytique, choix musical, jauges, météo flottante, carte centrale et écran de boot.
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, BarChart3, Brain, Check, Database, MapPin, Music, Pencil, Plus, Thermometer, Trash2, Wind, X, Youtube, Cloud } from "lucide-react";

import { weatherInfo } from "@/appLogic";
import { ReactorCore } from "@/components/ReactorVisuals";
import { LiveClock, LiveDate, useLiveStats } from "@/liveStats";
import { getLocalDateKey } from "@/dateTime";
import { speakCinematic, cleanTextForDisplay } from "@/voice";
import { Capacitor } from "@capacitor/core";

const BACKEND_BASE = process.env.REACT_APP_BACKEND_URL || "http://127.0.0.1:8001";
const API = BACKEND_BASE + "/api";
const todayStr = () => getLocalDateKey();

export function MemoryPanel({ memory, userName, onSave, onClose }) {
  const [items, setItems] = useState(() => [...(memory || [])]);
  const [draft, setDraft] = useState("");
  const [editIndex, setEditIndex] = useState(-1);
  const [editText, setEditText] = useState("");
  const [confirmMsg, setConfirmMsg] = useState("");
  const confirmTimer = useRef(null);
  const [localFacts, setLocalFacts] = useState([]);
  const [localDraft, setLocalDraft] = useState("");
  const [localCat, setLocalCat] = useState("preference");

  const loadLocal = useCallback(async () => {
    try {
      const r = await fetch(`${API}/local-memory`, { credentials: "include" });
      const data = await r.json();
      setLocalFacts(data.facts || []);
    } catch {}
  }, []);
  useEffect(() => { loadLocal(); }, [loadLocal]);

  const addLocal = async () => {
    const v = localDraft.trim();
    if (!v) return;
    try {
      const r = await fetch(`${API}/local-memory`, { credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: localCat, text: v }),
      });
      if (r.ok) { setLocalDraft(""); loadLocal(); flash("Enregistré dans la base locale ✓"); }
      else flash("Ce fait existe déjà.");
    } catch { flash("Base locale indisponible."); }
  };

  const delLocal = async (id) => {
    try {
      await fetch(`${API}/local-memory/${id}`, { credentials: "include", method: "DELETE" });
      loadLocal();
      flash("Supprimé de la base locale ✓");
    } catch {}
  };

  const flash = (msg) => {
    setConfirmMsg(msg);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmMsg(""), 2200);
  };
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const commit = (next) => { setItems(next); onSave(next); };

  const addItem = () => {
    const v = draft.trim().replace(/[.!?]+$/, "");
    if (!v) return;
    if (items.some((f) => f.t.toLowerCase() === v.toLowerCase())) { setDraft(""); flash("Ce souvenir existe déjà."); return; }
    commit([...items, { t: v, d: todayStr() }].slice(-30));
    setDraft("");
    flash("Souvenir ajouté ✓");
  };

  const removeItem = (i) => { commit(items.filter((_, idx) => idx !== i)); flash("Souvenir supprimé ✓"); };

  const startEdit = (i) => { setEditIndex(i); setEditText(items[i].t); };
  const saveEdit = () => {
    const v = editText.trim().replace(/[.!?]+$/, "");
    if (!v) { removeItem(editIndex); setEditIndex(-1); return; }
    commit(items.map((f, idx) => (idx === editIndex ? { ...f, t: v } : f)));
    setEditIndex(-1); setEditText("");
    flash("Modification enregistrée ✓");
  };

  return (
    <div className="setup-screen" data-testid="sirius-memory-panel" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="setup-grid-bg" />
      <div className="setup-card memory-modal">
        <button className="setup-close" onClick={onClose} data-testid="memory-close-btn"><X size={18} /></button>
        <div className="setup-head">
          <Brain size={22} />
          <div>
            <h2 className="setup-title">Ce que Sirius sait sur {userName || "vous"}</h2>
            <p className="setup-sub">Vos souvenirs personnels. Ajoutez, modifiez ou supprimez ce que Sirius retient.</p>
          </div>
        </div>

        <div className="memory-add">
          <input
            className="cmd-input"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }}
            placeholder="Ex : J'adore le jazz / Mon chien s'appelle Rex"
            data-testid="memory-add-input"
          />
          <button className="cmd-send" onClick={addItem} data-testid="memory-add-btn"><Plus size={16} /> Ajouter</button>
        </div>

        <div className="memory-list" data-testid="memory-list">
          {items.length === 0 && (
            <div className="memory-empty" data-testid="memory-empty">
              Sirius ne retient encore rien sur vous. Ajoutez un souvenir ci-dessus,
              ou dites « souviens-toi que… » pendant une conversation.
            </div>
          )}
          {items.map((fact, i) => (
            <div className="memory-item" key={i} data-testid={`memory-item-${i}`}>
              {editIndex === i ? (
                <>
                  <input
                    className="cmd-input memory-edit-input"
                    type="text"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEdit(); } }}
                    autoFocus
                    data-testid={`memory-edit-input-${i}`}
                  />
                  <button className="memory-icon-btn" onClick={saveEdit} title="Enregistrer" data-testid={`memory-save-btn-${i}`}><Check size={16} /></button>
                </>
              ) : (
                <>
                  {fact.d && <span className="memory-date" data-testid={`memory-date-${i}`}>{fact.d}</span>}
                  <span className="memory-text">{fact.t}</span>
                  <button className="memory-icon-btn" onClick={() => startEdit(i)} title="Modifier" data-testid={`memory-edit-btn-${i}`}><Pencil size={15} /></button>
                  <button className="memory-icon-btn danger" onClick={() => removeItem(i)} title="Supprimer" data-testid={`memory-delete-btn-${i}`}><Trash2 size={15} /></button>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="memory-foot">{items.length} / 30 souvenirs · Sauvegardé automatiquement sur cet appareil</div>

        <div className="local-mem-section" data-testid="local-memory-section">
          <div className="local-mem-title"><Database size={14} /> BASE LOCALE (SQLITE) — préférences & projets persistants</div>
          <div className="memory-add">
            <select
              className="local-mem-cat"
              value={localCat}
              onChange={(e) => setLocalCat(e.target.value)}
              data-testid="local-memory-category"
            >
              <option value="preference">Préférence</option>
              <option value="projet">Projet</option>
              <option value="souvenir">Souvenir</option>
            </select>
            <input
              className="cmd-input"
              type="text"
              value={localDraft}
              onChange={(e) => setLocalDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLocal(); } }}
              placeholder="Ex : Projet domotique salon / Préfère les réponses courtes"
              data-testid="local-memory-input"
            />
            <button className="cmd-send" onClick={addLocal} data-testid="local-memory-add-btn"><Plus size={16} /> Ajouter</button>
          </div>
          <div className="memory-list" data-testid="local-memory-list">
            {localFacts.length === 0 && (
              <div className="memory-empty">Aucun fait en base locale. Sirius y enregistre aussi automatiquement les nouveaux souvenirs de conversation.</div>
            )}
            {localFacts.map((f) => (
              <div className="memory-item" key={f.id} data-testid={`local-memory-item-${f.id}`}>
                <span className={`local-mem-badge ${f.category}`}>{f.category.toUpperCase()}</span>
                <span className="memory-text">{f.text}</span>
                <button className="memory-icon-btn danger" onClick={() => delLocal(f.id)} title="Supprimer" data-testid={`local-memory-delete-${f.id}`}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        </div>

        {confirmMsg && (
          <div className="memory-confirm" data-testid="memory-confirm">
            <Check size={15} /> {confirmMsg}
          </div>
        )}
      </div>
    </div>
  );
}

// Pop-up holographique avec effet machine à écrire, fermé manuellement par l'utilisateur
export function HoloPopup({ popup, onClose, onImage }) {
  const [shown, setShown] = useState("");
  const full = cleanTextForDisplay(popup.contenu || "");
  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      i += 2;
      setShown(full.slice(0, i));
      if (i >= full.length) clearInterval(id);
    }, 16);
    return () => clearInterval(id);
  }, [full]);
  const done = shown.length >= full.length;
  return (
    <div className={`holo-popup ${popup.kind === "memory" ? "memory" : ""}`} data-testid="holo-popup">
      <div className="hp-scan" />
      <div className="hp-head">
        {popup.kind === "memory" ? <Brain size={14} /> : <Activity size={14} />}
        <span>{popup.titre}</span>
        <button className="hp-close" onClick={onClose} data-testid="holo-popup-close" title="Fermer"><X size={14} /></button>
      </div>
      <div className="hp-body" data-testid="holo-popup-body">
        {popup.images && popup.images.length > 0 && (
          <div className="hp-images" data-testid="hp-images">
            {popup.images.map((im, i) => (
              <figure key={i} className="hp-img" onClick={() => onImage && onImage(im)} title="Agrandir l'archive">
                <img src={im.url} alt={im.legende || "archive"} loading="lazy" data-testid={`hp-image-${i}`} />
                {im.legende && <figcaption>{im.legende}{im.source ? ` — ${im.source}` : ""}</figcaption>}
              </figure>
            ))}
          </div>
        )}
        {shown}
        {!done && <span className="hp-caret">▋</span>}
      </div>
    </div>
  );
}

export function HoloPopups({ popups, onClose, onImage }) {
  if (!popups.length) return null;
  return (
    <div className="holo-popups" data-testid="holo-popups">
      {popups.map((p) => (
        <HoloPopup key={p.id} popup={p} onClose={() => onClose(p.id)} onImage={onImage} />
      ))}
    </div>
  );
}

// Tableau analytique — performances en direct du pipeline vocal de Sirius
export function AnalyticsPanel({ metrics, memoryCount, onClose }) {
  const fmtMs = (v) => (v != null ? `${v} ms` : "—");
  const rows = [
    {
      name: "STT", role: "Reconnaissance vocale", obj: "Réduire le temps de réaction initial",
      ok: metrics.stt.ms == null ? null : metrics.stt.ms < 6000,
      vals: [["Durée dernière écoute", fmtMs(metrics.stt.ms)], ["Confiance", metrics.stt.conf != null ? `${metrics.stt.conf} %` : "—"], ["Écoutes", metrics.stt.count]],
    },
    {
      name: "NLU", role: "Analyse d'intention", obj: "Éviter les faux positifs dans les commandes",
      ok: metrics.nlu.count === 0 ? null : true,
      vals: [["Dernière intention", metrics.nlu.intent], ["Commandes traitées", metrics.nlu.count]],
    },
    {
      name: "CONTEXTE", role: "Mémoire et historique", obj: "Conversation fluide sans répétition",
      ok: memoryCount < 30,
      vals: [["Souvenirs", `${memoryCount} / 30`], ["Échanges cette session", metrics.ctx.exchanges]],
    },
    {
      name: "PIPELINE", role: "Sélection de la réponse", obj: "Adapter la réponse en temps réel",
      ok: metrics.pipeline.apiMs == null ? null : metrics.pipeline.apiMs < 4000,
      vals: [["Aller-retour API", fmtMs(metrics.pipeline.apiMs)], ["Cerveau Kimi K3", fmtMs(metrics.pipeline.brainMs)], ["Recherche web", metrics.pipeline.search ? "OUI" : "NON"]],
    },
    {
      name: "TTS", role: "Synthèse vocale", obj: "Voix fluide et naturelle",
      ok: metrics.tts.latMs == null ? null : metrics.tts.latMs < 800,
      vals: [["Latence de la voix", fmtMs(metrics.tts.latMs)], ["Durée dernière réponse", metrics.tts.durMs != null ? `${(metrics.tts.durMs / 1000).toFixed(1)} s` : "—"], ["Réponses vocales", metrics.tts.count]],
    },
  ];
  return (
    <div className="setup-screen" data-testid="sirius-analytics-panel" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="setup-grid-bg" />
      <div className="setup-card analytics-modal">
        <button className="setup-close" onClick={onClose} data-testid="analytics-close-btn"><X size={18} /></button>
        <div className="setup-head">
          <BarChart3 size={22} />
          <div>
            <h2 className="setup-title">Tableau analytique</h2>
            <p className="setup-sub">Performances en direct du pipeline vocal. Se met à jour à chaque commande.</p>
          </div>
        </div>
        <div className="an-grid" data-testid="analytics-grid">
          {rows.map((r) => (
            <div className="an-row" key={r.name} data-testid={`analytics-row-${r.name.toLowerCase()}`}>
              <div className="an-row-head">
                <span className={`an-led ${r.ok == null ? "" : r.ok ? "ok" : "warn"}`} />
                <b>{r.name}</b>
                <span className="an-role">{r.role}</span>
              </div>
              <div className="an-vals">
                {r.vals.map(([k, v]) => (
                  <div className="an-val" key={k}><span>{k}</span><b>{v}</b></div>
                ))}
              </div>
              <div className="an-obj">Objectif : {r.obj}</div>
            </div>
          ))}
        </div>
        <div className="memory-foot">LED verte = nominal · orange = à surveiller · grise = pas encore de mesure</div>
      </div>
    </div>
  );
}

export function MusicChoice({ query, onPick, onClose }) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="setup-screen" data-testid="sirius-music-choice" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="setup-grid-bg" />
      <div className="setup-card music-modal">
        <button className="setup-close" onClick={onClose} data-testid="music-close-btn"><X size={18} /></button>
        <div className="setup-head">
          <Music size={22} />
          <div>
            <h2 className="setup-title">Sur quoi je lance ça ?</h2>
            <p className="setup-sub">« {query} »</p>
          </div>
        </div>
        <div className="music-options">
          <button className="music-opt spotify" onClick={() => onPick("spotify", remember)} data-testid="music-pick-spotify">
            <Music size={26} /> Spotify
          </button>
          <button className="music-opt youtube" onClick={() => onPick("youtube", remember)} data-testid="music-pick-youtube">
            <Youtube size={26} /> YouTube
          </button>
        </div>
        <label className="music-remember" data-testid="music-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Toujours utiliser ce service (ne plus me demander)
        </label>
      </div>
    </div>
  );
}

export function Gauge({ label, value, accent, testid }) {
  const v = Math.round(value);
  return (
    <div className="gauge" data-testid={testid}>
      <div className="gauge-head">
        <span>{label}</span>
        <b>{v}%</b>
      </div>
      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: `${v}%`, background: accent, boxShadow: `0 0 10px ${accent}` }} />
      </div>
    </div>
  );
}

export function MiniBar({ label, v }) {
  return (
    <div className="mini-bar">
      <span>{label}</span>
      <div className="mini-bar-track">
        <div className="mini-bar-fill" style={{ width: `${v}%`, background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
      </div>
      <b>{v}%</b>
    </div>
  );
}

export function FloatingPanels({ weather }) {
  const w = weather ? weatherInfo(weather.code) : null;
  const WIcon = w ? w.Icon : Cloud;
  return (
    <div className="floating-panels" data-testid="floating-panels">
      <div className="float-card fc-tr" data-hud-panel data-testid="sirius-meteo">
        <div className="fc-head"><Thermometer size={13} /> MÉTÉO</div>
        {weather && Number.isFinite(weather.temp) ? (
          <div className="fc-weather">
            <WIcon size={26} />
            <div>
              <div className="fc-big">{weather.temp}°</div>
              <div className="fc-sub">{w.label}</div>
            </div>
          </div>
        ) : (
          <div className="fc-sub">Localisation...</div>
        )}
      </div>
    </div>
  );
}

export function Ring({ label, v }) {
  const C = 2 * Math.PI * 42;
  return (
    <div className="cc-ring">
      <svg viewBox="0 0 100 100" width="86" height="86">
        <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="7" />
        <circle
          cx="50" cy="50" r="42" fill="none" stroke="var(--accent)" strokeWidth="7" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - v / 100)}
          transform="rotate(-90 50 50)"
          style={{ filter: "drop-shadow(0 0 6px var(--accent))", transition: "stroke-dashoffset 0.9s ease" }}
        />
        <text x="50" y="56" textAnchor="middle" fill="#eafaff" fontSize="22" fontFamily="Orbitron">{v}</text>
      </svg>
      <div className="cc-ring-label">{label}</div>
    </div>
  );
}

export function CentralCard({ card, weather, onClose }) {
  const { cpu, ram } = useLiveStats();
  let title = "";
  let body = null;
  if (card.type === "time") {
    title = "HEURE LOCALE & UTC";
    body = <LiveClock variant="card" />;
  } else if (card.type === "date") {
    title = "DATE DU JOUR";
    body = <div className="cc-date"><LiveDate /></div>;
  } else if (card.type === "weather") {
    title = "MÉTÉO";
    if (weather) {
      const w = weatherInfo(weather.code);
      const WIcon = w.Icon;
      body = (
        <div className="cc-weather">
          <WIcon size={68} />
          <div className="cc-huge">{weather.temp}°C</div>
          <div className="cc-rows">
            <div><Wind size={14} /> {weather.wind} km/h</div>
            <div><MapPin size={14} /> {weather.city}</div>
            <div>{w.label}</div>
          </div>
        </div>
      );
    } else {
      body = <div className="cc-date">Localisation en cours...</div>;
    }
  } else if (card.type === "system") {
    title = "DIAGNOSTIC SYSTÈME";
    body = (
      <div className="cc-sys">
        <Ring label="CPU" v={Math.round(cpu)} />
        <Ring label="RAM" v={Math.round(ram)} />
        <Ring label="RÉSEAU" v={99} />
      </div>
    );
  } else if (card.type === "spotify") {
    title = card.playing ? "EN ÉCOUTE · SPOTIFY" : "EN PAUSE · SPOTIFY";
    body = (
      <div className="cc-spotify" data-testid="cc-spotify">
        {card.image && <img className="cc-cover" src={card.image} alt={card.album} />}
        <div className="cc-track-title">{card.title}</div>
        <div className="cc-track-artist">{card.artist}</div>
        {card.album && <div className="cc-track-album">{card.album}</div>}
      </div>
    );
  }
  return (
    <div className="central-card" data-testid="central-card" onClick={onClose}>
      <div className="cc-scan" />
      <div className="cc-head">
        <span>{title}</span>
        <X size={16} className="cc-close" />
      </div>
      <div className="cc-body">{body}</div>
    </div>
  );
}

export function BootScreen({ onDone, userName, onOpenModule }) {
  const lines = [
    "> Initialisation du noyau S.I.R.I.U.S ...",
    "> Chargement des modules cognitifs ......... OK",
    "> Connexion aux capteurs système ........... OK",
    "> Calibration synthèse vocale .............. OK",
    "> Activation reconnaissance vocale ......... OK",
    "> Établissement liaison WebSocket .......... OK",
    "> Protocoles de sécurité ................... OK",
    userName ? `> Bienvenue, ${userName}. Système opérationnel.` : "> Système opérationnel.",
  ];
  const [shown, setShown] = useState(0);
  const [progress, setProgress] = useState(0);
  const [closing, setClosing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [speechDone, setSpeechDone] = useState(false);
  const speechStartedRef = useRef(false);
  const padRef = useRef(null);
  const isAndroid = Capacitor.getPlatform() === "android";
  const introSpeech = "Système. Intelligent. Réactif. Interface. Universel. Sécurisé. " +
    "Je suis Sirius... façonné par mon créateur, Daniel Partel. " +
    "Sirius scanne tous ses services... Tous mes services sont opérationnels... à votre disposition.";
  const playIntroSpeech = () => {
    try {
      const pad = padRef.current;
      if (pad) {
        pad.ctx.resume().catch(() => {});
        pad.master.gain.cancelScheduledValues(pad.ctx.currentTime);
        pad.master.gain.linearRampToValueAtTime(0.045, pad.ctx.currentTime + 0.25);
      }
    } catch (e) {}
    speakCinematic(introSpeech, {
      onstart: () => { speechStartedRef.current = true; },
      onend: () => setSpeechDone(true),
    });
  };

  // Fondu de sortie de la nappe sonore
  const stopPad = () => {
    const pad = padRef.current;
    padRef.current = null;
    if (!pad) return;
    try {
      pad.master.gain.linearRampToValueAtTime(0, pad.ctx.currentTime + 0.6);
      setTimeout(() => { try { pad.ctx.close(); } catch (e) {} }, 700);
    } catch (e) { try { pad.ctx.close(); } catch (err) {} }
  };

  useEffect(() => {
    // Présentation vocale : voix française grave et posée, style bande-annonce
    // (équivalents français des mots de l'acronyme : mêmes initiales S.I.R.I.U.S,
    //  la voix française butait sur les mots anglais comme « Responsive »)
    // Garde anti-écho : une seule présentation vocale par chargement de page
    if (!window.__siriusBootSpoken) {
      window.__siriusBootSpoken = true;
    } else {
      setSpeechDone(true);
    }
    // Nappe sonore cinématique discrète sous la voix (Web Audio, gratuite)
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      ctx.resume().catch(() => {});
      const master = ctx.createGain();
      master.gain.setValueAtTime(0, ctx.currentTime);
      master.connect(ctx.destination);
      [[55, "sine", 0.6], [110.4, "triangle", 0.35], [220.8, "sine", 0.12]].forEach(([f, type, lvl]) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = lvl;
        o.connect(g); g.connect(master);
        o.start();
      });
      padRef.current = { ctx, master };
    } catch (e) {}
    // Sécurité : on ne bloque jamais plus de 16 s si la voix ne répond pas.
    const safety = setTimeout(() => setSpeechDone(true), 16000);
    const hardStop = setTimeout(() => {
      setLoaded(true);
      setSpeechDone(true);
      setClosing(true);
      stopPad();
      setTimeout(onDone, 500);
    }, 18000);
    const step = 520;
    const dur = lines.length * step + 600;
    let i = 0;
    const lineTimer = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= lines.length) clearInterval(lineTimer);
    }, step);
    const start = Date.now();
    const progTimer = setInterval(() => {
      const p = Math.min(100, Math.round(((Date.now() - start) / dur) * 100));
      setProgress(p);
      if (p >= 100) { setLoaded(true); clearInterval(progTimer); }
    }, 40);
    return () => { clearInterval(lineTimer); clearInterval(progTimer); clearTimeout(safety); clearTimeout(hardStop); stopPad(); };
  }, [lines.length, onDone]); // eslint-disable-line react-hooks/exhaustive-deps

// Sur Windows, le chargement visuel ne doit jamais rester bloqué par la synthèse vocale.
  useEffect(() => {
    if (!loaded || closing || isAndroid) return;
    setClosing(true);
    stopPad();
    const closeTimer = setTimeout(onDone, 700);
    return () => clearTimeout(closeTimer);
  }, [loaded, closing, isAndroid, onDone]);
  // Chargé à 100 % mais voix jamais démarrée (autoplay bloqué / onend muet) → fermeture après 2,5 s
  useEffect(() => {
    if (!loaded || speechDone) return;
    if (window.Capacitor?.getPlatform?.() === "android") return;
    const t = setTimeout(() => { if (!speechStartedRef.current) setSpeechDone(true); }, 2500);
    return () => clearTimeout(t);
  }, [loaded, speechDone]);
  return (

    <div className={`boot-screen ${closing ? "closing" : ""}`} data-testid="boot-screen" onClick={() => {
      if (isAndroid && !speechStartedRef.current) { playIntroSpeech(); return; }
      if (!speechStartedRef.current && !speechDone) { playIntroSpeech(); return; }
      setClosing(true); stopPad(); setTimeout(onDone, 500);
    }}>
      <div className="boot-grid" />
      <div className="boot-scan" />
      <div className="boot-modules" data-testid="boot-modules">
        <div className="boot-modules-title font-divine">Panthéon des Modules</div>
        {[
          ["argus", "ARGUS", "Surveillance & réparation"],
          ["atlas", "ATLAS", "Carte & navigation"],
          ["oracle", "ORACLE", "Divination des données"],
          ["heracles", "HERACLES", "Investigation"],
          ["hephaistos", "HÉPHAÏSTOS", "Forge & maintenance"],
          ["themis", "THÉMIS", "Gestion d'entreprise"],
          ["solon", "SOLON", "Conseil juridique"],
          ["promethee", "PROMÉTHÉE", "Gestion de projet"],
          ["calliope", "CALLIOPE", "Bibliothèque audio"],
          ["pythagore", "PYTHAGORE", "Mathématiques & géométrie"],
          ["agora", "HERMÈS AGORA", "Expert en vente"],
          ["nummarius", "PORTUS NUMMARIUS", "Bourse & marchés"],
          ["keraunos", "KERAUNOS", "Foudre domotique"],
          ["locus", "LOCUS", "Géolocalisation"],
          ["pantheon", "PANTHÉON", "Cœur du système"],
          ["cortex", "CORTEX", "Intelligence centrale"],
        ].map(([id, name, role], i) => (
          <div
            className="boot-module"
            key={id}
            role="button"
            tabIndex={0}
            style={{ animationDelay: `${0.9 + i * 0.28}s` }}
            data-testid={`boot-module-${id}`}
            onClick={(e) => {
              e.stopPropagation();
              setClosing(true); stopPad();
              setTimeout(() => { onDone(); onOpenModule && onOpenModule(id); }, 450);
            }}
          >
            <span className="boot-module-name font-divine">{name}</span>
            <span className="boot-module-role">{role}</span>
          </div>
        ))}
      </div>
      <div className="boot-center">
        <div className="boot-reactor" data-testid="boot-reactor">
          <div className="core-rings" aria-hidden="true">
            <img src="/holo/ring-gold.png" alt="" className="core-ring outer" draggable={false} />
            <img src="/holo/ring-gold.png" alt="" className="core-ring inner" draggable={false} />
            <div className="core-pulse" />
            <div className="core-orbit">
              {["Σ", "Δ", "Ω", "Θ", "Φ"].map((l, i) => (
                <span key={l} className="core-letter" style={{ "--i": i }}><i>{l}</i></span>
              ))}
            </div>
          </div>
          <ReactorCore status="thinking" volume={0.35} color="#91e6f2" eco={false} />
        </div>
        <div className="boot-acronym" data-testid="boot-acronym">
          {[["S", "System"], ["I", "Intelligent"], ["R", "Responsive"], ["I", "Interface"], ["U", "Universal"], ["S", "Secure"]].map(([l, w], i) => (
            <span className="boot-acro-item" key={i} style={{ animationDelay: `${0.5 + i * 0.22}s` }}>
              <b>{l}</b>
              <i>{w}</i>
            </span>
          ))}
        </div>
        <div className="boot-log">
          {lines.slice(0, shown).map((l, idx) => (
            <div key={idx} className="boot-line">{l}</div>
          ))}
        </div>
        <div className="boot-bar">
          <div className="boot-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="boot-pct">{progress}%  —  touchez pour activer la voix</div>
        <div className="boot-copyright">© 2026 ΣIRIUS par Daniel Partel – Tous droits réservés.</div>
      </div>
    </div>
  );
}
