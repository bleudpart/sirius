// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useState } from "react";
import { KeyRound, X, BellRing, Send, CheckCircle2 } from "lucide-react";
import "./KeysStatus.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

export default function KeysStatus({ onClose }) {
  const [keys, setKeys] = useState([]);
  const [watch, setWatch] = useState(null);
  const [testMsg, setTestMsg] = useState("");

  const loadAll = async () => {
    try {
      const [k, w] = await Promise.all([
        fetch(`${API}/system/keys_status`).then((r) => r.json()),
        fetch(`${API}/push/watch`).then((r) => r.json()),
      ]);
      setKeys(k.keys || []);
      setWatch(w);
    } catch (e) { /* backend injoignable */ }
  };

  useEffect(() => { loadAll(); }, []);

  const toggleWatch = async () => {
    if (!watch) return;
    const r = await fetch(`${API}/push/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !watch.enabled }),
    });
    const d = await r.json();
    setWatch((w) => ({ ...w, enabled: d.enabled }));
  };

  const testPush = async () => {
    setTestMsg("");
    const r = await fetch(`${API}/push/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "SIRIUS — Test", body: "La veille active fonctionne. Je vous préviendrai des actualités importantes." }),
    });
    const d = await r.json();
    setTestMsg(d.sent > 0 ? `Notification envoyée à ${d.sent} appareil${d.sent > 1 ? "s" : ""}.` : "Aucun appareil abonné — activez d'abord les notifications.");
  };

  const nb = keys.filter((k) => k.configured).length;

  return (
    <div className="keys-panel" data-testid="keys-status-panel">
      <div className="keys-bar">
        <KeyRound size={14} />
        <span className="keys-title">STATUT DES CLÉS API</span>
        <span className="keys-count">{nb}/{keys.length}</span>
        <button className="keys-close" onClick={onClose} data-testid="keys-status-close-btn"><X size={14} /></button>
      </div>
      <div className="keys-list">
        {keys.map((k) => (
          <div key={k.id} className="keys-row" data-testid={`keys-row-${k.id}`}>
            <span className={`keys-led ${k.configured ? "on" : "off"}`} data-testid={`keys-led-${k.id}`} />
            <span className="keys-service">{k.service}</span>
            <span className={`keys-state ${k.configured ? "ok" : "ko"}`}>{k.configured ? "CONFIGURÉE" : "MANQUANTE"}</span>
          </div>
        ))}
        {keys.length === 0 && <div className="keys-empty">Chargement du statut…</div>}
      </div>

      {watch && (
        <div className="keys-watch" data-testid="keys-watch-section">
          <div className="keys-watch-head">
            <BellRing size={13} />
            <span>VEILLE PUSH PROACTIVE</span>
            <span className={`keys-led ${watch.enabled ? "on" : "off"}`} data-testid="watch-led" />
          </div>
          <p className="keys-watch-desc">
            Sirius surveille les actualités toutes les {watch.interval_min} min et vous prévient par notification,
            même application fermée. {watch.subscribers} appareil{watch.subscribers > 1 ? "s" : ""} abonné{watch.subscribers > 1 ? "s" : ""}.
          </p>
          <div className="keys-watch-actions">
            <button className={`keys-btn ${watch.enabled ? "on" : ""}`} onClick={toggleWatch} data-testid="watch-toggle-btn">
              <CheckCircle2 size={12} /> {watch.enabled ? "VEILLE ACTIVÉE" : "VEILLE DÉSACTIVÉE"}
            </button>
            <button className="keys-btn" onClick={testPush} data-testid="watch-test-btn">
              <Send size={12} /> TESTER
            </button>
          </div>
          {testMsg && <div className="keys-test-msg" data-testid="watch-test-msg">{testMsg}</div>}
        </div>
      )}
    </div>
  );
}
