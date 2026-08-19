// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useState } from "react";
import { Zap, Play, Wrench, Clock3, XCircle, HelpCircle, ShieldAlert } from "lucide-react";
import "./Proactive.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const MODES = [
  ["discret", "DISCRET"],
  ["equilibre", "ÉQUILIBRÉ"],
  ["proactif", "PROACTIF"],
];

export default function ProactivePanel({ onAction, onSpeak }) {
  const [suggestions, setSuggestions] = useState([]);
  const [settings, setSettings] = useState({ mode: "equilibre" });
  const [why, setWhy] = useState({});
  const [confirming, setConfirming] = useState({});

  const evaluate = useCallback(async (trigger) => {
    try {
      const r = await fetch(`${API}/suggestions/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger }),
      });
      const d = await r.json();
      setSuggestions(d.suggestions || []);
      if (d.settings) setSettings(d.settings);
    } catch (_) {}
  }, []);

  useEffect(() => {
    evaluate("app_open");
    const iv = setInterval(() => evaluate("periodic"), 10 * 60 * 1000);
    return () => clearInterval(iv);
  }, [evaluate]);

  const remove = (id) => setSuggestions((l) => l.filter((s) => s.id !== id));

  const act = async (s, action) => {
    try {
      const r = await fetch(`${API}/suggestions/${s.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, token: confirming[s.id] || null }),
      });
      const d = await r.json();
      if (d.needs_confirmation) {
        setConfirming((c) => ({ ...c, [s.id]: d.token }));
        onSpeak && onSpeak(d.message || "Cette action est sensible — confirmez-vous ?");
        return;
      }
      if (action === "executer" && d.executed) onAction && onAction(d.proposed_action);
      if (action === "preparer" && d.prepared) onAction && onAction({ ...d.proposed_action, prepare: true });
      remove(s.id);
    } catch (_) {}
  };

  const askWhy = async (s) => {
    if (why[s.id]) {
      setWhy((w) => ({ ...w, [s.id]: null }));
      return;
    }
    try {
      const r = await fetch(`${API}/suggestions/${s.id}/why`);
      const d = await r.json();
      setWhy((w) => ({ ...w, [s.id]: d }));
    } catch (_) {}
  };

  const setMode = async (mode) => {
    try {
      const r = await fetch(`${API}/suggestions/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { mode } }),
      });
      setSettings(await r.json());
    } catch (_) {}
  };

  if (!suggestions.length) return null;

  return (
    <div className="proactive-stack" data-testid="proactive-panel">
      <div className="pro-mode-row">
        <Zap size={11} />
        <span className="pro-mode-label">SUGGESTIONS</span>
        {MODES.map(([m, label]) => (
          <button
            key={m}
            className={`pro-mode-btn ${settings.mode === m ? "on" : ""}`}
            onClick={() => setMode(m)}
            data-testid={`sugg-mode-${m}`}
          >
            {label}
          </button>
        ))}
      </div>
      {suggestions.map((s) => (
        <div className={`sugg-card urg-${s.urgency}`} key={s.id} data-testid="suggestion-card">
          <div className="sugg-head">
            <b className="sugg-title">{s.title}</b>
            <span className={`sugg-badge urg-${s.urgency}`}>{s.urgency.toUpperCase()}</span>
            {s.risk_level !== "faible" && (
              <span className={`sugg-badge risk-${s.risk_level}`}>
                <ShieldAlert size={9} /> {s.risk_level.toUpperCase()}
              </span>
            )}
          </div>
          <p className="sugg-desc">{s.description}</p>
          {confirming[s.id] && (
            <p className="sugg-confirm" data-testid="sugg-confirm-msg">
              Action sensible — cliquez à nouveau sur EXÉCUTER pour confirmer.
            </p>
          )}
          {why[s.id] && (
            <div className="sugg-why" data-testid="sugg-why-box">
              <p><b>Raison :</b> {why[s.id].reason}</p>
              <p><b>Bénéfice :</b> {why[s.id].expected_benefit}</p>
              <p><b>Confiance :</b> {Math.round((why[s.id].confidence || 0) * 100)} %</p>
            </div>
          )}
          <div className="sugg-actions">
            <button className="sugg-btn exec" onClick={() => act(s, "executer")} data-testid="sugg-exec-btn">
              <Play size={10} /> EXÉCUTER
            </button>
            <button className="sugg-btn" onClick={() => act(s, "preparer")} data-testid="sugg-prepare-btn">
              <Wrench size={10} /> PRÉPARER
            </button>
            <button className="sugg-btn" onClick={() => act(s, "plus_tard")} data-testid="sugg-later-btn">
              <Clock3 size={10} /> PLUS TARD
            </button>
            <button className="sugg-btn danger" onClick={() => act(s, "ne_plus_proposer")} data-testid="sugg-block-btn">
              <XCircle size={10} /> NE PLUS PROPOSER
            </button>
            <button className="sugg-btn ghost" onClick={() => askWhy(s)} data-testid="sugg-why-btn">
              <HelpCircle size={10} /> POURQUOI ?
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
