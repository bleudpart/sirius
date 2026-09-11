// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import { Home, X, Plug, Lightbulb, Thermometer, ToggleLeft, Settings2, RefreshCw, CheckCircle2, AlertTriangle, Play, Lock, Fan, Tv, Wind, Eye } from "lucide-react";
import "./Keraunos.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const DOMAIN_META = {
  light: { label: "LUMIÈRES", Icon: Lightbulb },
  switch: { label: "PRISES & INTERRUPTEURS", Icon: Plug },
  fan: { label: "VENTILATEURS", Icon: Fan },
  climate: { label: "CLIMAT", Icon: Thermometer },
  cover: { label: "VOLETS & PORTES", Icon: ToggleLeft },
  lock: { label: "SERRURES", Icon: Lock },
  media_player: { label: "MÉDIAS", Icon: Tv },
  scene: { label: "SCÈNES", Icon: Play },
  script: { label: "SCRIPTS", Icon: Play },
  vacuum: { label: "ASPIRATEURS", Icon: Wind },
  input_boolean: { label: "COMMUTATEURS", Icon: ToggleLeft },
  sensor: { label: "CAPTEURS", Icon: Eye },
  binary_sensor: { label: "DÉTECTEURS", Icon: Eye },
  person: { label: "PERSONNES", Icon: Eye },
  weather: { label: "MÉTÉO HA", Icon: Eye },
};

const STATE_FR = { on: "ALLUMÉ", off: "ÉTEINT", unavailable: "INDISPONIBLE", unknown: "INCONNU", open: "OUVERT", closed: "FERMÉ", locked: "VERROUILLÉ", unlocked: "DÉVERROUILLÉ", playing: "LECTURE", paused: "PAUSE", idle: "INACTIF", home: "PRÉSENT", not_home: "ABSENT" };

function ConfigScreen({ initialUrl, onSaved, onClose, configured }) {
  const [url, setUrl] = useState(initialUrl || "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const test = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${API}/ha/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base_url: url, token }) });
      const d = await r.json();
      setMsg(r.ok ? { ok: true, text: "Connexion réussie — " + (d.message || "API active.") } : { ok: false, text: d.detail || "Échec de connexion." });
    } catch { setMsg({ ok: false, text: "Backend injoignable." }); }
    setBusy(false);
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`${API}/ha/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base_url: url, token }) });
      const d = await r.json();
      if (r.ok) { setMsg({ ok: true, text: "Configuration enregistrée." }); setTimeout(onSaved, 600); }
      else setMsg({ ok: false, text: d.detail || "Échec de l'enregistrement." });
    } catch { setMsg({ ok: false, text: "Backend injoignable." }); }
    setBusy(false);
  };

  return (
    <div className="kr-config" data-testid="keraunos-config">
      <p className="kr-help">
        Reliez Sirius à votre <b>Home Assistant</b>. Créez un jeton dans HA :
        profil (en bas à gauche) → Sécurité → « Jetons d&apos;accès longue durée » → Créer.
      </p>
      <label className="kr-label">URL HOME ASSISTANT</label>
      <input className="kr-input" placeholder="https://xxxx.ui.nabu.casa ou http://192.168.1.x:8123" value={url} onChange={(e) => setUrl(e.target.value)} data-testid="keraunos-url-input" />
      <label className="kr-label">TOKEN LONGUE DURÉE</label>
      <input className="kr-input" type="password" placeholder="eyJhbGciOi..." value={token} onChange={(e) => setToken(e.target.value)} data-testid="keraunos-token-input" />
      <div className="kr-actions">
        <button className="kr-btn" onClick={test} disabled={busy || !url || !token} data-testid="keraunos-test-btn">
          <RefreshCw size={12} className={busy ? "kr-spin" : ""} /> TESTER
        </button>
        <button className="kr-btn kr-btn-gold" onClick={save} disabled={busy || !url || !token} data-testid="keraunos-save-btn">
          <CheckCircle2 size={12} /> CONNECTER
        </button>
        {configured && (
          <button className="kr-btn" onClick={onClose} data-testid="keraunos-config-back-btn">RETOUR</button>
        )}
      </div>
      {msg && (
        <div className={`kr-msg ${msg.ok ? "ok" : "ko"}`} data-testid="keraunos-config-msg">
          {msg.ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />} {msg.text}
        </div>
      )}
    </div>
  );
}

function EntityRow({ ent, onToggle, onBrightness }) {
  const on = ["on", "open", "playing", "home", "unlocked"].includes(ent.state);
  const stateTxt = STATE_FR[ent.state] || (ent.unit ? `${ent.state} ${ent.unit}` : String(ent.state).toUpperCase());
  return (
    <div className={`kr-row ${on ? "on" : ""}`} data-testid={`keraunos-entity-${ent.entity_id}`}>
      <span className={`kr-led ${ent.state === "unavailable" ? "ko" : on ? "on" : "off"}`} />
      <span className="kr-name" title={ent.entity_id}>{ent.name}</span>
      {ent.domain === "light" && on && (
        <input
          type="range" min="1" max="100" className="kr-slider"
          defaultValue={ent.brightness ? Math.round((ent.brightness / 255) * 100) : 100}
          onMouseUp={(e) => onBrightness(ent.entity_id, Number(e.target.value))}
          onTouchEnd={(e) => onBrightness(ent.entity_id, Number(e.target.value))}
          data-testid={`keraunos-brightness-${ent.entity_id}`}
        />
      )}
      {ent.controllable ? (
        <button className={`kr-toggle ${on ? "on" : ""}`} onClick={() => onToggle(ent.entity_id)} data-testid={`keraunos-toggle-${ent.entity_id}`}>
          {["scene", "script"].includes(ent.domain) ? "LANCER" : stateTxt}
        </button>
      ) : (
        <span className="kr-state">{stateTxt}</span>
      )}
    </div>
  );
}

export default function KeraunosPanel({ onClose }) {
  const [config, setConfig] = useState(null);
  const [showConfig, setShowConfig] = useState(false);
  const [entities, setEntities] = useState([]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const pollRef = useRef(null);

  const loadConfig = useCallback(async () => {
    try {
      const d = await fetch(`${API}/ha/config`).then((r) => r.json());
      setConfig(d);
      if (!d.configured) setShowConfig(true);
    } catch { setConfig({ configured: false }); setShowConfig(true); }
    setLoading(false);
  }, []);

  const loadStates = useCallback(async () => {
    try {
      const r = await fetch(`${API}/ha/states`);
      const d = await r.json();
      if (r.ok) { setEntities(d.entities || []); setError(""); }
      else setError(d.detail || "Erreur de récupération des appareils.");
    } catch { setError("Backend injoignable."); }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  useEffect(() => {
    if (!config?.configured || showConfig) return;
    loadStates();
    pollRef.current = setInterval(loadStates, 4000);
    return () => clearInterval(pollRef.current);
  }, [config, showConfig, loadStates]);

  const toggle = async (entity_id) => {
    setEntities((es) => es.map((e) => (e.entity_id === entity_id && ["on", "off"].includes(e.state) ? { ...e, state: e.state === "on" ? "off" : "on" } : e)));
    try {
      const r = await fetch(`${API}/ha/toggle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity_id }) });
      if (!r.ok) { const d = await r.json(); setError(d.detail || "Commande refusée."); }
    } catch { setError("Backend injoignable."); }
    setTimeout(loadStates, 900);
  };

  const setBrightness = async (entity_id, pct) => {
    try {
      await fetch(`${API}/ha/service`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain: "light", service: "turn_on", data: { entity_id, brightness_pct: pct } }) });
    } catch { /* silencieux */ }
  };

  const visible = entities.filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()) || e.entity_id.includes(filter.toLowerCase()));
  const grouped = visible.reduce((acc, e) => { (acc[e.domain] = acc[e.domain] || []).push(e); return acc; }, {});
  const domainOrder = Object.keys(DOMAIN_META).filter((d) => grouped[d]);
  const nbOn = entities.filter((e) => e.state === "on").length;

  return (
    <div className="kr-panel" data-testid="keraunos-panel">
      <div className="kr-bar">
        <Home size={14} />
        <span className="kr-title">KERAUNOS# — DOMOTIQUE</span>
        {config?.configured && !showConfig && <span className="kr-count" data-testid="keraunos-count">{nbOn} actif{nbOn > 1 ? "s" : ""} / {entities.length}</span>}
        {config?.configured && (
          <button className="kr-icon-btn" onClick={() => setShowConfig((s) => !s)} title="Configuration" data-testid="keraunos-settings-btn"><Settings2 size={13} /></button>
        )}
        <button className="kr-icon-btn" onClick={onClose} data-testid="keraunos-close-btn"><X size={14} /></button>
      </div>

      {loading ? (
        <div className="kr-empty">Initialisation…</div>
      ) : showConfig ? (
        <ConfigScreen
          initialUrl={config?.base_url}
          configured={config?.configured}
          onClose={() => setShowConfig(false)}
          onSaved={() => { setShowConfig(false); loadConfig(); }}
        />
      ) : (
        <>
          <div className="kr-toolbar">
            <input className="kr-input kr-search" placeholder="Filtrer les appareils…" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="keraunos-filter-input" />
            <button className="kr-icon-btn" onClick={loadStates} title="Rafraîchir" data-testid="keraunos-refresh-btn"><RefreshCw size={13} /></button>
          </div>
          {error && <div className="kr-msg ko" data-testid="keraunos-error"><AlertTriangle size={12} /> {error}</div>}
          <div className="kr-list" data-testid="keraunos-entity-list">
            {domainOrder.map((dom) => {
              const meta = DOMAIN_META[dom];
              const DIcon = meta.Icon;
              return (
                <div key={dom} className="kr-group">
                  <div className="kr-group-head"><DIcon size={12} /> {meta.label} <i>{grouped[dom].length}</i></div>
                  {grouped[dom].map((ent) => (
                    <EntityRow key={ent.entity_id} ent={ent} onToggle={toggle} onBrightness={setBrightness} />
                  ))}
                </div>
              );
            })}
            {!error && entities.length === 0 && <div className="kr-empty">Aucun appareil détecté pour l&apos;instant.</div>}
          </div>
        </>
      )}
    </div>
  );
}
