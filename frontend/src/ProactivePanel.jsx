// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import { Zap, Play, Wrench, Clock3, XCircle, HelpCircle, ShieldAlert, BrainCircuit } from "lucide-react";
import "./Proactive.css";
import { trackWindowGesture, isPrimaryGesture } from "./windowGesture";
import { API_BASE_URL } from "./lib/api";

const API = API_BASE_URL;
const IDLE_BEFORE_SUGGESTION_MS = 45000;
const ANNOUNCEMENT_GAP_MS = 120000;

export default function ProactivePanel({ onAction, onSpeak, canSpeak }) {
  const [suggestions, setSuggestions] = useState([]);
  const [why, setWhy] = useState({});
  const [confirming, setConfirming] = useState({});
  const announcedIdsRef = useRef(new Set());
  const onSpeakRef = useRef(onSpeak);
  const canSpeakRef = useRef(canSpeak);
  const lastUserActivityRef = useRef(Date.now());
  const lastAnnouncementRef = useRef(null);
  const suggestionsRef = useRef([]);
  const evaluatingRef = useRef(false);
  const mountedRef = useRef(false);
  const voiceBusyRef = useRef(false);
  const [error, setError] = useState("");
  const panelRef = useRef(null);
  const hasSuggestions = suggestions.length > 0;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const header = panel.querySelector(".pro-mode-row");
    const key = "sirius_panel_pos";
    const readPositions = () => JSON.parse(localStorage.getItem(key) || "{}");
    const position = (x, y) => {
      panel.style.left = `${Math.min(Math.max(0, x), Math.max(0, window.innerWidth - panel.offsetWidth))}px`;
      // Keep the handle reachable even when the suggestions exceed the viewport.
      panel.style.top = `${Math.min(Math.max(0, y), Math.max(0, window.innerHeight - header.offsetHeight))}px`;
    };
    try {
      const saved = readPositions()["proactive-panel"];
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) position(saved.x, saved.y);
    } catch (cause) { console.error("Restauration de la position SIRIUS ANTICIPE impossible :", cause); }
    let drag = null;
    let disposeGesture = null;
    const onDown = (event) => {
      if (!isPrimaryGesture(event)) return;
      disposeGesture?.();
      const rect = panel.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top, id: event.pointerId };
      panel.classList.add("dragging");
      disposeGesture = trackWindowGesture(event, { element: panel, onMove, onEnd: onUp });
    };
    const onMove = (event) => {
      if (drag && event.pointerId === drag.id) position(event.clientX - drag.x, event.clientY - drag.y);
    };
    const onUp = (event) => {
      if (!drag || (event?.pointerId != null && event.pointerId !== drag.id)) return;
      drag = null;
      panel.classList.remove("dragging");
      try {
        const saved = readPositions();
        const rect = panel.getBoundingClientRect();
        saved["proactive-panel"] = { x: rect.left, y: rect.top };
        localStorage.setItem(key, JSON.stringify(saved));
      } catch (cause) { console.error("Sauvegarde de la position SIRIUS ANTICIPE impossible :", cause); }
    };
    const onResize = () => {
      const rect = panel.getBoundingClientRect();
      position(rect.left, rect.top);
    };
    header.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onResize);
    return () => {
      header.removeEventListener("pointerdown", onDown);
      disposeGesture?.();
      window.removeEventListener("resize", onResize);
    };
  }, [hasSuggestions]);

  useEffect(() => {
    onSpeakRef.current = onSpeak;
    canSpeakRef.current = canSpeak;
  }, [onSpeak, canSpeak]);

  const announce = useCallback(() => {
    const now = Date.now();
    if (!mountedRef.current || !onSpeakRef.current || document.visibilityState === "hidden"
        || voiceBusyRef.current || canSpeakRef.current?.() === false
        || now - lastUserActivityRef.current < IDLE_BEFORE_SUGGESTION_MS
        || (lastAnnouncementRef.current !== null && now - lastAnnouncementRef.current < ANNOUNCEMENT_GAP_MS)) return;
    const suggestion = suggestionsRef.current.find((item) => !announcedIdsRef.current.has(item.id));
    if (!suggestion) return;
    onSpeakRef.current(`${suggestion.description} ${suggestion.intervention || ""}`.trim());
    announcedIdsRef.current.add(suggestion.id);
    lastAnnouncementRef.current = now;
  }, []);

  const evaluate = useCallback(async (trigger) => {
    if (evaluatingRef.current) return;
    evaluatingRef.current = true;
    try {
      const r = await fetch(`${API}/suggestions/evaluate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!Array.isArray(d.suggestions)) throw new Error("Réponse de proactivité invalide");
      if (!mountedRef.current) return;
      const nextSuggestions = d.suggestions || [];
      suggestionsRef.current = nextSuggestions;
      setSuggestions(nextSuggestions);
      setError(d.news_status === "partial" ? "Veille actualités partiellement indisponible. Les autres suggestions restent actives." : "");
      announce();
    } catch (cause) {
      console.error("Évaluation de la proactivité impossible :", cause);
      if (mountedRef.current) setError("Proactivité indisponible : vérifiez la connexion au backend.");
    } finally {
      evaluatingRef.current = false;
    }
  }, [announce]);

  useEffect(() => {
    mountedRef.current = true;
    evaluate("app_open");
    let activityTimer;
    const onActivity = () => {
      lastUserActivityRef.current = Date.now();
      window.clearTimeout(activityTimer);
      activityTimer = window.setTimeout(() => evaluate("activity"), 2000);
    };
    const onVoice = (event) => {
      voiceBusyRef.current = event.detail !== "idle";
      lastUserActivityRef.current = Date.now();
    };
    window.addEventListener("sirius:activity", onActivity);
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    window.addEventListener("sirius-voice-phase", onVoice);
    const timer = window.setInterval(() => evaluate("timer"), 60000);
    const announcementTimer = window.setInterval(announce, 5000);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("sirius:activity", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("sirius-voice-phase", onVoice);
      window.clearTimeout(activityTimer);
      window.clearInterval(timer);
      window.clearInterval(announcementTimer);
    };
  }, [evaluate, announce]);

  const remove = (id) => {
    suggestionsRef.current = suggestionsRef.current.filter((s) => s.id !== id);
    setSuggestions(suggestionsRef.current);
  };

  const act = async (s, action) => {
    try {
      const r = await fetch(`${API}/suggestions/${s.id}/action`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, token: confirming[s.id] || null }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (d.needs_confirmation) {
        setConfirming((c) => ({ ...c, [s.id]: d.token }));
        onSpeak && onSpeak(d.message || "Cette action est sensible — confirmez-vous ?");
        return;
      }
      if (action === "executer" && d.executed) onAction && onAction(d.proposed_action);
      if (action === "preparer" && d.prepared) onAction && onAction({ ...d.proposed_action, prepare: true });
      remove(s.id);
    } catch (cause) {
      console.error("Action proactive impossible :", cause);
      setError("Action impossible. La suggestion a été conservée.");
    }
  };

  const askWhy = async (s) => {
    if (why[s.id]) {
      setWhy((w) => ({ ...w, [s.id]: null }));
      return;
    }
    try {
      const r = await fetch(`${API}/suggestions/${s.id}/why`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setWhy((w) => ({ ...w, [s.id]: d }));
    } catch (cause) {
      console.error("Explication proactive indisponible :", cause);
      setError("Explication indisponible pour le moment.");
    }
  };

  if (!suggestions.length && !error) return null;

  return (
    <div ref={panelRef} className="proactive-stack" data-testid="proactive-panel">
      <div className="pro-mode-row" title="Glisser pour déplacer SIRIUS ANTICIPE">
        <Zap size={11} />
        <span className="pro-mode-label"><BrainCircuit size={11} /> SIRIUS ANTICIPE</span>
      </div>
      {error && <p role="alert">{error}</p>}
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
          {s.intervention && <p className="sugg-intervention">{s.intervention}</p>}
          {s.alternative && <p className="sugg-alternative">Alternative : {s.alternative}</p>}
          <div className="sugg-confidence" title={s.reason || "Suggestion issue de la mémoire locale"}>
            <span>CONFIANCE {Math.round((s.confidence || 0) * 100)} %</span>
            <i><b style={{ width: `${Math.round((s.confidence || 0) * 100)}%` }} /></i>
            <small>{s.source === "actualite" ? "ACTUALITÉ SOURCÉE" : s.source === "projet" ? "PROJET EN MÉMOIRE" : s.source === "habitude" ? "HABITUDE DÉTECTÉE" : "CONTEXTE RÉCENT"}</small>
          </div>
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
