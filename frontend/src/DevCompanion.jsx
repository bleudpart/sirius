// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useState } from "react";
import { Code2, X, GitCommitHorizontal, SearchCode, FileWarning, Copy, Check, Loader2 } from "lucide-react";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const ACTIONS = [
  { id: "review", label: "Revue de code", Icon: SearchCode },
  { id: "commit", label: "Message de commit", Icon: GitCommitHorizontal },
  { id: "logs", label: "Analyse de logs", Icon: FileWarning },
];

export default function DevCompanion({ keys, onClose }) {
  const [code, setCode] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const run = async (action) => {
    if (!code.trim() || loading) return;
    setLoading(action);
    setError("");
    setResult("");
    try {
      const r = await fetch(`${API}/dev/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, action, keys: keys || {} }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Erreur serveur");
      setResult(data.result || "");
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading("");
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  return (
    <div className="setup-screen" data-testid="dev-companion-panel" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="setup-grid-bg" />
      <div className="setup-card dev-modal">
        <button className="setup-close" onClick={onClose} data-testid="dev-close-btn"><X size={18} /></button>
        <div className="setup-head">
          <Code2 size={22} />
          <div>
            <h2 className="setup-title">Mode Compagnon Dev</h2>
            <p className="setup-sub">Collez du code, un diff ou des logs — Sirius analyse, corrige et propose des commits.</p>
          </div>
        </div>

        <textarea
          className="dev-textarea"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={"Collez ici votre code Python, JS, un diff Git ou des logs d'erreur..."}
          spellCheck={false}
          data-testid="dev-code-input"
        />

        <div className="dev-actions">
          {ACTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className="cmd-send dev-action-btn"
              onClick={() => run(id)}
              disabled={!!loading || !code.trim()}
              data-testid={`dev-action-${id}`}
            >
              {loading === id ? <Loader2 size={15} className="dev-spin" /> : <Icon size={15} />} {label}
            </button>
          ))}
        </div>

        {error && <div className="dev-error" data-testid="dev-error">{error}</div>}

        {result && (
          <div className="dev-result-wrap">
            <button className="memory-icon-btn dev-copy-btn" onClick={copy} title="Copier" data-testid="dev-copy-btn">
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
            <pre className="dev-result" data-testid="dev-result">{result}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
