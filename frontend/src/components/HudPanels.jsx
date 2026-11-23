// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Panneaux HUD autonomes extraits d'App.js : mémoire, pop-ups holographiques,
// analytique, choix musical, jauges, météo flottante, carte centrale et écran de boot.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, BarChart3, Brain, Check, Database, MapPin, Music, Pencil, Plus, Thermometer, Trash2, Wind, X, Youtube, Cloud } from "lucide-react";

import { weatherInfo } from "@/appLogic";
import { CoreRings, ReactorCore } from "@/components/ReactorVisuals";
import { LiveClock, LiveDate, useLiveStats } from "@/liveStats";
import { getLocalDateKey, getTimeOfDayGreeting } from "@/dateTime";
import { speakCinematic, cancelSpeech, cleanTextForDisplay } from "@/voice";
import { API_BASE_URL } from "@/lib/api";
import { readAccountSetup } from "@/accountSetup";
import { APP_RELEASE, APP_VERSION } from "@/version";

const BRAIN_RETRY_MS = 2000;
const BRAIN_DEADLINE_MS = 20000;

// Le serveur local d'un PC met parfois une dizaine de secondes à démarrer, et le serveur
// public peut être lent à répondre : on réessaie avant de déclarer le cerveau injoignable.
export async function probeBrainOnce() {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), 4000);
  try {
    const response = await fetch(`${API_BASE_URL}/health`, { signal: controller?.signal, cache: "no-store" });
    return response.ok;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

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
            <h2 className="setup-title">Ce que ΣIRIUS sait sur {userName || "vous"}</h2>
            <p className="setup-sub">Vos souvenirs personnels. Ajoutez, modifiez ou supprimez ce que ΣIRIUS retient.</p>
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
              ΣIRIUS ne retient encore rien sur vous. Ajoutez un souvenir ci-dessus,
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
              <div className="memory-empty">Aucun fait en base locale. ΣIRIUS y enregistre aussi automatiquement les nouveaux souvenirs de conversation.</div>
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
  const { cpu, ram, live } = useLiveStats();
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
        <Ring label="CPU" v={live && cpu != null ? Math.round(cpu) : 0} />
        <Ring label="RAM" v={live && ram != null ? Math.round(ram) : 0} />
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

// L'écran reste visible au moins ce délai pour ne pas clignoter quand tout répond aussitôt.
const BOOT_MIN_VISIBLE_MS = 1200;
// Une voix qui ne démarre pas vite (lecture automatique bloquée, synthèse lente) n'est pas attendue.
const BOOT_VOICE_START_MS = 2500;
const BOOT_VOICE_CAP_MS = 7000;

export function BootScreen({ onDone, userName, probeBrain = probeBrainOnce, probeServices = readAccountSetup }) {
  const firstName = (userName || "").trim().split(/\s+/)[0];
  const welcomeName = firstName.charAt(0).toLocaleUpperCase("fr-FR") + firstName.slice(1);
  // État du cerveau (serveur) : null = recherche en cours, true = joint, false = injoignable.
  const [brain, setBrain] = useState(null);
  const [services, setServices] = useState(null);
  const [servicesError, setServicesError] = useState("");
  const [servicesDone, setServicesDone] = useState(false);
  const [brainAttempt, setBrainAttempt] = useState(0);
  const [brainRun, setBrainRun] = useState(0);
  const brainRef = useRef(brain);
  brainRef.current = brain;
  useEffect(() => {
    let active = true;
    setServicesDone(false);
    setServices(null);
    setServicesError("");
    Promise.resolve().then(() => probeServices()).then((data) => {
      if (!data || !Array.isArray(data.services)) throw new Error("Réponse des services invalide.");
      if (active) setServices(data.services);
    }).catch((error) => {
      if (active) {
        console.warn("Initialisation des services :", error);
        setServicesError(error.message || "Vérification des services indisponible.");
      }
    }).finally(() => { if (active) setServicesDone(true); });
    return () => { active = false; };
  }, [brainRun, probeServices]);
  useEffect(() => {
    if (brainRef.current === true) return undefined;
    let cancelled = false;
    let timer = null;
    const deadline = Date.now() + BRAIN_DEADLINE_MS;
    const attempt = async (n) => {
      if (cancelled) return;
      setBrainAttempt(n);
      const ok = await Promise.resolve(probeBrain()).catch(() => false);
      if (cancelled || brainRef.current === true) return;
      if (ok) { setBrain(true); return; }
      if (Date.now() >= deadline) { setBrain(false); return; }
      timer = setTimeout(() => attempt(n + 1), BRAIN_RETRY_MS);
    };
    attempt(1);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [brainRun]); // eslint-disable-line react-hooks/exhaustive-deps
  const retryBrain = () => {
    setBrain(null);
    setBrainRun((n) => n + 1);
  };

  // Chaque ligne annonce l'état réellement constaté, dès qu'il est connu.
  const checks = useMemo(() => {
    // La voix passe par le serveur (/tts lu en Audio) ; la synthèse du navigateur n'est
    // qu'un secours, absente de la WebView Android.
    const speech = typeof window !== "undefined"
      && ("speechSynthesis" in window || typeof window.Audio !== "undefined");
    // La dictée passe soit par le navigateur, soit par l'enregistrement micro transcrit
    // par le serveur (/stt) : c'est le cas de la WebView Android, sans SpeechRecognition.
    const recog = typeof window !== "undefined"
      && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window
        || (typeof window.MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia));
    return [
      { label: "Interface ΣIRIUS", state: true, success: "Initialisée", scope: "Initialisation de l'interface." },
      { label: "Connexion au serveur", state: brain === null ? null : brain === true, success: "Connexion établie", scope: "Joignabilité du serveur ; modèle et services externes non testés." },
      { label: "Configuration des services", state: !servicesDone ? null : services !== null, success: "Reçue", scope: servicesError || "Configuration reçue du serveur ; fournisseurs non testés." },
      { label: "Interface vocale", state: speech && recog, success: "API disponibles", scope: "API audio et micro présentes ; permissions, capture et sortie audible non vérifiées par ce contrôle." },
    ];
  }, [brain, servicesDone, services, servicesError]);
  const resolved = checks.filter(({ state }) => state !== null).length;
  const progress = Math.round(resolved / checks.length * 100);
  const loaded = resolved === checks.length;
  useEffect(() => {
    if (brain === null) return;
    window.__siriusStartupDiagnostic = {
      measuredAt: new Date().toISOString(),
      checks: checks.map(({ label, state, success, scope }) => ({ label, state, success, scope })),
    };
  }, [brain, checks]);

  const [timeGreeting] = useState(getTimeOfDayGreeting);
  const ready = brain === true && services !== null;
  const spokenGreeting = `${timeGreeting}${welcomeName ? ` ${welcomeName}` : ""}`;
  const welcomeSpeech = ready
    ? `${spokenGreeting}. Systèmes synchronisés. Cœur réactif en ligne. Je suis prêt.`
    : brain === false
      ? `${spokenGreeting}. Le serveur ne répond pas encore. Vous pouvez réessayer la connexion.`
      : `${spokenGreeting}. La configuration des services n'a pas pu être vérifiée.`;
  const phaseTone = !loaded ? "pending" : ready ? "ok" : "fail";
  const phase = !loaded ? "Synchronisation des systèmes…"
    : ready ? "Systèmes synchronisés · cœur réactif en ligne"
      : brain === false ? "Serveur injoignable" : "Services non vérifiés";

  const [closing, setClosing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [voiceSettled, setVoiceSettled] = useState(false);
  const mountedAtRef = useRef(Date.now());
  const closeTimerRef = useRef(null);
  const closingRef = useRef(false);
  const speechRequestedRef = useRef(false);
  const voiceStartedRef = useRef(false);
  const voiceDoneRef = useRef(false);
  const closeBoot = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (speechRequestedRef.current && !voiceDoneRef.current) cancelSpeech();
    setClosing(true);
    closeTimerRef.current = setTimeout(onDone, 500);
  };
  useEffect(() => {
    const reportVoiceError = () => {
      voiceDoneRef.current = true;
      setVoiceSettled(true);
    };
    window.addEventListener("sirius-voice-error", reportVoiceError);
    return () => {
      window.removeEventListener("sirius-voice-error", reportVoiceError);
      clearTimeout(closeTimerRef.current);
      if (speechRequestedRef.current && !voiceDoneRef.current && !closingRef.current) cancelSpeech();
    };
  }, []);
  // Une seule phrase d'accueil par chargement ; un « Réessayer » ne la relance pas.
  useEffect(() => {
    if (!loaded || speechRequestedRef.current) return;
    speechRequestedRef.current = true;
    if (window.__siriusBootSpoken) {
      voiceDoneRef.current = true;
      setVoiceSettled(true);
      return;
    }
    window.__siriusBootSpoken = true;
    speakCinematic(welcomeSpeech, {
      natural: true,
      onstart: () => { voiceStartedRef.current = true; },
      onend: () => {
        voiceDoneRef.current = true;
        setVoiceSettled(true);
      },
    });
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!loaded || voiceSettled) return undefined;
    const startTimer = setTimeout(() => {
      if (!voiceStartedRef.current) setVoiceSettled(true);
    }, BOOT_VOICE_START_MS);
    const capTimer = setTimeout(() => setVoiceSettled(true), BOOT_VOICE_CAP_MS);
    return () => { clearTimeout(startTimer); clearTimeout(capTimer); };
  }, [loaded, voiceSettled]);
  useEffect(() => {
    if (!loaded || !voiceSettled || brain === false || detailsOpen) return undefined;
    const wait = Math.max(0, mountedAtRef.current + BOOT_MIN_VISIBLE_MS - Date.now());
    const timer = setTimeout(closeBoot, wait);
    return () => clearTimeout(timer);
  }, [loaded, voiceSettled, brain, detailsOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`boot-screen boot-reference ${closing ? "closing" : ""}`} data-testid="boot-screen" onClick={() => {
      if (loaded) closeBoot();
    }}>
      <div className="boot-grid" />
      <div className="boot-scan" />
      <div className="boot-center">
        <div className="boot-identity">
          <p className="boot-kicker">Je suis ΣIRIUS</p>
          <h1 className="boot-welcome">{timeGreeting}{welcomeName ? `, ${welcomeName}` : ""}</h1>
        </div>
        <div className="boot-reactor" data-testid="boot-reactor">
          <CoreRings />
          <ReactorCore status="thinking" volume={0.35} color="#91e6f2" eco={false} />
        </div>
      </div>
      <section className="boot-status boot-status-reference" aria-label="Initialisation de ΣIRIUS">
        <p className={`boot-phase boot-phase-${phaseTone}`} data-testid="boot-phase" role="status">
          <span className="boot-phase-led" aria-hidden="true" />
          {phase}
        </p>
        <div className="boot-bar" role="progressbar" aria-label="Chargement de ΣIRIUS"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div className="boot-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <details className="boot-check-details" onClick={(event) => event.stopPropagation()}
          onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
          <summary>Détails des vérifications</summary>
          <ul>
            {checks.map(({ label, state, success, scope }) => (
              <li key={label}>
                <strong>{label} : {state === null ? "en cours" : state ? success : "indisponible"}</strong>
                <span>{scope}</span>
              </li>
            ))}
          </ul>
          {services && <ul>{services.map(({ id, label, state }) => (
            <li key={id}>{label} : {state === "configured" ? "configuré, fournisseur non testé"
              : state === "available" ? "disponible selon le serveur"
                : state === "not_configured" ? "non configuré"
                  : state === "restricted" ? "accès restreint" : "état non reconnu"}</li>
          ))}</ul>}
        </details>
        {servicesError && <div className="boot-service-error" onClick={(event) => event.stopPropagation()}>
          <p role="alert">{servicesError}</p>
          <button type="button" onClick={retryBrain}>Revérifier les services</button>
        </div>}
        {brain === null && brainAttempt > 1 && (
          <div className="boot-brain-wait" data-testid="boot-brain-wait" role="status">
            Connexion au cerveau ΣIRIUS… tentative {brainAttempt}
          </div>
        )}
        {brain === false && (
          <div className="boot-brain-alert" data-testid="boot-brain-alert" role="alert"
            onClick={(e) => e.stopPropagation()}>
            <strong>ΣIRIUS n'arrive pas à joindre son cerveau.</strong>
            <span>
              {/127\.0\.0\.1|localhost/.test(API_BASE_URL)
                ? "Le moteur de ΣIRIUS démarre encore sur cet ordinateur. Patientez quelques secondes puis réessayez ; si le problème continue, fermez et relancez ΣIRIUS."
                : "Vérifiez que l'appareil est connecté à Internet (Wi-Fi ou données mobiles), puis réessayez."}
            </span>
            <div className="boot-brain-actions">
              <button type="button" data-testid="boot-brain-retry" onClick={(event) => {
                event.stopPropagation();
                retryBrain();
              }}>Réessayer</button>
              <button type="button" data-testid="boot-brain-continue" onClick={() => closeBoot()}>Continuer quand même</button>
            </div>
          </div>
        )}
      </section>
      <div className="boot-copyright" data-testid="boot-copyright">
        COPYRIGHT © 2026 ΣIRIUS par Daniel Partel – Tous droits réservés.
        <span className="hud-version-badge footer-version-badge" title={APP_RELEASE}>v{APP_VERSION}</span>
      </div>
    </div>
  );
}
