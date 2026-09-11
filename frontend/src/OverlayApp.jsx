// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { speakFr } from "@/voice";
import "@/App.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
const today = () => new Date().toISOString().slice(0, 10);

// Overlay transparent type Spotlight (Alt+Espace dans l'app Electron)
export default function OverlayApp() {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current && inputRef.current.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        try { window.require && window.require("electron").ipcRenderer.send("sirius-close-overlay"); } catch (err) {}
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ask = async (e) => {
    e.preventDefault();
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setAnswer("");
    try {
      const resp = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          session_id: "overlay",
          keys: load("sirius_keys", {}),
          profile: load("sirius_profile", {}),
          memory: load("sirius_memory", []),
          mode: localStorage.getItem("sirius_mode") || "normal",
        }),
      });
      const data = await resp.json();
      const a = data.answer || "Je n'ai pas de réponse.";
      setAnswer(a);
      speakFr(a);
      // Mémorise en local ce que Sirius a détecté (cohérence avec le HUD)
      if (Array.isArray(data.memories) && data.memories.length) {
        const cur = load("sirius_memory", []);
        const norm = (m) => (typeof m === "string" ? { t: m, d: null } : m);
        const list = cur.map(norm);
        const fresh = data.memories
          .map((f) => String(f).trim().replace(/[.!?]+$/, ""))
          .filter((f) => f && !list.some((c) => (c.t || "").toLowerCase() === f.toLowerCase()));
        if (fresh.length) {
          localStorage.setItem("sirius_memory", JSON.stringify([...list, ...fresh.map((t) => ({ t, d: today() }))].slice(-30)));
        }
      }
    } catch (err) {
      setAnswer("Sirius est injoignable. Vérifiez que le noyau tourne.");
    }
    setBusy(false);
  };

  return (
    <div className="overlay-root" data-testid="sirius-overlay">
      <form className="overlay-bar" onSubmit={ask}>
        <span className="overlay-prompt">ΣIRIUS&gt;</span>
        <input
          ref={inputRef}
          className="overlay-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Posez votre question… (Échap pour fermer)"
          data-testid="overlay-input"
        />
        <button className="overlay-send" type="submit" disabled={busy} data-testid="overlay-send">
          {busy ? <Loader2 size={16} className="dg-spin" /> : "›"}
        </button>
      </form>
      {answer && <div className="overlay-answer" data-testid="overlay-answer">{answer}</div>}
    </div>
  );
}
