// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Wrench, Clock3, XCircle, HelpCircle } from "lucide-react";
import "./Proactive.css";
import { API_BASE_URL } from "./lib/api";
import { liveWorkKeys } from "./LiveWorkSettings";

const API = API_BASE_URL;
const IDLE_BEFORE_SUGGESTION_MS = 45000;
const ANNOUNCEMENT_GAP_MS = 120000;

export default function ProactivePanel({ onSpeak, canSpeak, onInitiative, onError }) {
  const announcedIdsRef = useRef(new Set());
  const onSpeakRef = useRef(onSpeak);
  const canSpeakRef = useRef(canSpeak);
  const lastUserActivityRef = useRef(Date.now());
  const lastAnnouncementRef = useRef(null);
  const suggestionsRef = useRef([]);
  const liveSuggestionsRef = useRef([]);
  const evaluatingRef = useRef(false);
  const mountedRef = useRef(false);
  const voiceBusyRef = useRef(false);
  const [error, setError] = useState("");
  const onInitiativeRef = useRef(onInitiative);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onInitiativeRef.current = onInitiative;
    onErrorRef.current = onError;
  }, [onInitiative, onError]);
  useEffect(() => {
    if (error) onErrorRef.current?.(error);
  }, [error]);

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
    const suggestion = [...liveSuggestionsRef.current, ...suggestionsRef.current]
      .find((item) => !announcedIdsRef.current.has(item.id));
    if (!suggestion) return;
    const message = `${suggestion.description} ${suggestion.intervention || ""}`.trim();
    onInitiativeRef.current?.(suggestion, message);
    onSpeakRef.current(message);
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

  useEffect(() => {
    let active = true;
    let pending = false;
    let generation = 0;
    const controller = new AbortController();
    const invalidate = (event) => {
      generation += 1;
      liveSuggestionsRef.current = liveSuggestionsRef.current.filter((item) => item.dossier_id !== event.detail);
    };
    const poll = async () => {
      if (pending || document.visibilityState === "hidden" || voiceBusyRef.current
          || canSpeakRef.current?.() === false) return;
      pending = true;
      const startedGeneration = generation;
      try {
        const response = await fetch(`${API}/work-dossiers/live/evaluate`, {
          method: "POST", credentials: "include", signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keys: liveWorkKeys() }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data.updates)) throw new Error("Réponse de suivi invalide");
        if (!active || generation !== startedGeneration) return;
        liveSuggestionsRef.current = data.updates.map((item) => ({
          id: item.id, dossier_id: item.dossier_id, source: "live_work", title: item.title,
          description: item.description,
          intervention: item.analysis.text ? `Interprétation à vérifier : ${item.analysis.text}` : "",
          live: item,
        }));
        if (data.errors?.length || data.truncated) {
          onErrorRef.current?.(data.errors?.map((item) => item.message).join(" ")
            || "Le suivi automatique est limité aux 10 premiers dossiers actifs.");
        }
        announce();
      } catch (cause) {
        if (!active || cause.name === "AbortError") return;
        console.error("Suivi contextuel indisponible :", cause);
        onErrorRef.current?.("Suivi contextuel indisponible : vérifiez la connexion au backend.");
      } finally {
        pending = false;
      }
    };
    poll();
    window.addEventListener("sirius:live-settings-changed", invalidate);
    const timer = window.setInterval(poll, 60000);
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener("sirius:live-settings-changed", invalidate);
      window.clearInterval(timer);
    };
  }, [announce]);

  return null;
}

export function ProactiveConversation({ suggestion, onAction, onSpeak }) {
  const [why, setWhy] = useState({});
  const [confirming, setConfirming] = useState({});
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (s, action) => {
    if (busy) return;
    setBusy(true);
    setError("");
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
      if (action === "executer" && d.executed && onAction) await onAction(d.proposed_action);
      if (action === "preparer" && d.prepared && onAction) await onAction({ ...d.proposed_action, prepare: true });
      setCompleted(true);
    } catch (cause) {
      console.error("Action proactive impossible :", cause);
      setError("Action impossible. La suggestion a été conservée.");
    } finally {
      setBusy(false);
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

  const s = suggestion;
  if (completed) return <p className="pro-conversation-result" role="status">Votre choix a été pris en compte.</p>;
  if (s.source === "live_work") return <div className="pro-conversation" data-testid="live-work-conversation">
    {error && <p role="alert">{error}</p>}
    <p>Sources vérifiées le {new Date(s.live.verified_at).toLocaleString("fr-FR")} · aucune action exécutée.</p>
    {s.live.analysis.error && <p role="status">{s.live.analysis.error}</p>}
    <details><summary>Voir les différences calculées</summary>
      {s.live.changes.map((change) => <div key={`${change.source.kind}:${change.source.id}`}>
        <strong>{change.source.kind} · {change.source.id}</strong>
        <ul>{change.fields.map((field) => <li key={field.name}>
          {field.name} : {JSON.stringify(field.before)} → {JSON.stringify(field.after)}
          {field.delta != null && ` · différence ${field.delta}${field.percent != null ? ` (${field.percent} %)` : ""}`}
        </li>)}</ul>
      </div>)}
    </details>
    <fieldset className="sugg-actions" disabled={busy}>
      <button className="sugg-btn" onClick={async () => {
        setBusy(true);
        try {
          if (!onAction) throw new Error("Action de dossier non disponible");
          await onAction({ type: "work_dossier", dossier_id: s.dossier_id });
        }
        catch (cause) { console.error("Ouverture du dossier impossible :", cause); setError("Ouverture du dossier impossible."); }
        finally { setBusy(false); }
      }}>Ouvrir le dossier</button>
      <button className="sugg-btn" onClick={async () => {
        setBusy(true);
        try {
          const response = await fetch(`${API}/work-dossiers/${encodeURIComponent(s.dossier_id)}/live/dismiss`, {
            method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: s.id }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setCompleted(true);
        } catch (cause) { console.error("Mise de côté impossible :", cause); setError("Impossible de mettre ce point de côté."); }
        finally { setBusy(false); }
      }}>Mettre ce point de côté</button>
    </fieldset>
  </div>;

  return (
    <div className="pro-conversation" data-testid="proactive-conversation">
      {error && <p role="alert">{error}</p>}
          {s.alternative && <p className="sugg-alternative">Alternative : {s.alternative}</p>}
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
          <fieldset className="sugg-actions" disabled={busy}>
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
          </fieldset>
    </div>
  );
}
