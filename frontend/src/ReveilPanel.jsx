// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Réveil matinal : à l'heure choisie, Sirius lance le briefing (météo incluse) puis lit les mails.
import { useState } from "react";
import { X, AlarmClock, BellRing, BellOff } from "lucide-react";

const KEY = "sirius_reveil";
const load = () => {
  try { return { on: false, time: "07:30", ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; }
  catch { return { on: false, time: "07:30" }; }
};

const nextLabel = (time) => {
  const [h, m] = time.split(":").map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  const demain = target <= now || localStorage.getItem("sirius_reveil_last") === now.toISOString().slice(0, 10);
  return `${demain && target <= now ? "demain" : "aujourd'hui"} à ${h} h${m ? ` ${String(m).padStart(2, "0")}` : ""}`;
};

export default function ReveilPanel({ onClose, onSpeak }) {
  const [cfg, setCfg] = useState(load);
  const save = (next) => {
    setCfg(next);
    localStorage.setItem(KEY, JSON.stringify(next));
    localStorage.removeItem("sirius_reveil_last");
  };
  const toggle = () => {
    const next = { ...cfg, on: !cfg.on };
    save(next);
    if (onSpeak) onSpeak(next.on ? `Réveil matinal activé, ${nextLabel(next.time)}.` : "Réveil matinal désactivé.");
  };
  return (
    <div className="prime-screen reveil-screen" data-testid="reveil-panel">
      <header className="zeus-head">
        <div className="zeus-title font-divine"><AlarmClock size={20} /> RÉVEIL MATINAL</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="reveil-close-btn"><X size={18} /></button>
      </header>
      <div className="reveil-body">
        <p className="reveil-desc">
          À l'heure choisie, Sirius te salue, lance ton <b>briefing du jour</b> (météo, agenda, rappels, marchés)
          puis lit tes <b>derniers mails Outlook</b> à voix haute. L'onglet ΣIRIUS doit rester ouvert.
        </p>
        <div className="reveil-row">
          <label htmlFor="reveil-time">HEURE DU RÉVEIL</label>
          <input
            id="reveil-time"
            type="time"
            value={cfg.time}
            onChange={(e) => save({ ...cfg, time: e.target.value || "07:30" })}
            data-testid="reveil-time-input"
          />
        </div>
        <button className={`cmd-send reveil-toggle ${cfg.on ? "off" : ""}`} onClick={toggle} data-testid="reveil-toggle-btn">
          {cfg.on ? <><BellOff size={14} /> DÉSACTIVER LE RÉVEIL</> : <><BellRing size={14} /> ACTIVER LE RÉVEIL</>}
        </button>
        <div className={`reveil-status ${cfg.on ? "on" : ""}`} data-testid="reveil-status">
          {cfg.on ? `Réveil armé — ${nextLabel(cfg.time)}` : "Réveil désactivé"}
        </div>
        <p className="reveil-hint">Commandes vocales : « réveille-moi à 7 h 30 », « active le réveil », « désactive le réveil ».</p>
      </div>
    </div>
  );
}
