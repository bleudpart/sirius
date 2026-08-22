import { useState } from "react";
import { Code2, Loader2, ScanSearch, ShieldAlert } from "lucide-react";

import { productivityRequest } from "./productivityApi";

export default function CodeFixer() {
  const [language, setLanguage] = useState("python");
  const [code, setCode] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const analyze = async (event) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      setResult(await productivityRequest("/code/analyze", {
        method: "POST",
        body: JSON.stringify({ language, code }),
      }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="productivity-tool" data-testid="productivity-code-fixer">
      <div className="productivity-tool-head">
        <div><Code2 size={17} /><div><h3>CodeAssist</h3><p>Revue statique locale : le code fourni n'est jamais execute.</p></div></div>
      </div>
      <form className="productivity-form" onSubmit={analyze}>
        <label>LANGAGE
          <select value={language} onChange={(event) => setLanguage(event.target.value)}>
            <option value="python">Python</option>
            <option value="javascript">JavaScript</option>
            <option value="typescript">TypeScript</option>
            <option value="json">JSON</option>
            <option value="text">Texte / logs</option>
          </select>
        </label>
        <label>CODE OU LOG<textarea className="productivity-code-input" value={code} onChange={(event) => setCode(event.target.value)} maxLength={120000} spellCheck={false} placeholder="Collez du code ou un journal d'erreur..." /></label>
        <div className="productivity-form-footer">
          <span>{code.split("\n").length} ligne(s)</span>
          <button type="submit" className="productivity-primary-btn" disabled={busy || !code.trim()}>
            {busy ? <Loader2 size={14} className="productivity-spin" /> : <ScanSearch size={14} />} ANALYSER
          </button>
        </div>
      </form>
      {error && <div className="productivity-error" role="alert">{error}</div>}
      {result && (
        <div className="productivity-result" data-testid="productivity-code-result">
          <div className={`productivity-code-summary ${result.summary.status}`}>
            <ShieldAlert size={15} /> {result.summary.total ? `${result.summary.total} point(s) a verifier` : "Aucun point detecte"}
          </div>
          {!result.diagnostics.length && <p className="productivity-empty">Analyse locale terminee : aucune regle ne signale de risque.</p>}
          {result.diagnostics.map((issue) => (
            <article className={`productivity-diagnostic severity-${issue.severity}`} key={`${issue.line}-${issue.rule}`}>
              <span>L{issue.line}</span><div><b>{issue.message}</b><p>{issue.recommendation}</p></div><em>{issue.severity}</em>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

