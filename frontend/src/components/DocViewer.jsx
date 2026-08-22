import { useRef, useState } from "react";
import { FileText, FolderOpen, Loader2, Sparkles } from "lucide-react";

import { productivityRequest } from "./productivityApi";

export default function DocViewer() {
  const [title, setTitle] = useState("Document de travail");
  const [content, setContent] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  const analyze = async (event) => {
    event.preventDefault();
    if (!content.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await productivityRequest("/documents/analyze", {
        method: "POST",
        body: JSON.stringify({ title, content }),
      });
      setAnalysis(result);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const loadTextFile = async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setError("Le fichier texte depasse 1 Mo. Collez un extrait plus court.");
      event.target.value = "";
      return;
    }
    if (file.type && !file.type.startsWith("text/") && !file.name.match(/\.(md|txt|csv|json)$/i)) {
      setError("DocAnalyzer lit les fichiers texte. Collez le contenu d'un PDF dans cette version.");
      event.target.value = "";
      return;
    }
    try {
      setContent(await file.text());
      setTitle(file.name.replace(/\.[^.]+$/, "") || "Document de travail");
      setAnalysis(null);
      setError("");
    } catch (fileError) {
      setError(fileError.message || "Lecture du fichier impossible.");
    } finally {
      event.target.value = "";
    }
  };

  return (
    <section className="productivity-tool" data-testid="productivity-doc-viewer">
      <div className="productivity-tool-head">
        <div><FileText size={17} /><div><h3>DocAnalyzer</h3><p>Synthese locale, titres, mots-cles et actions.</p></div></div>
        <button type="button" className="productivity-secondary-btn" onClick={() => inputRef.current?.click()}>
          <FolderOpen size={13} /> IMPORTER TEXTE
        </button>
        <input ref={inputRef} type="file" accept=".txt,.md,.csv,.json,text/*" onChange={loadTextFile} hidden />
      </div>

      <form className="productivity-form" onSubmit={analyze}>
        <label>TITRE<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} /></label>
        <label>DOCUMENT<textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={120000} placeholder="Collez ici un document, un compte rendu ou des notes de reunion..." /></label>
        <div className="productivity-form-footer">
          <span>{content.trim().length.toLocaleString("fr-FR")} caracteres</span>
          <button type="submit" className="productivity-primary-btn" disabled={busy || !content.trim()}>
            {busy ? <Loader2 size={14} className="productivity-spin" /> : <Sparkles size={14} />} ANALYSER
          </button>
        </div>
      </form>

      {error && <div className="productivity-error" role="alert">{error}</div>}
      {analysis && (
        <div className="productivity-result" data-testid="productivity-doc-result">
          <div className="productivity-result-title">{analysis.title}</div>
          <p className="productivity-summary">{analysis.summary}</p>
          <div className="productivity-result-grid">
            <div><b>SECTIONS</b>{analysis.headings.length ? <ul>{analysis.headings.map((heading) => <li key={heading}>{heading}</li>)}</ul> : <span>Aucune section detectee.</span>}</div>
            <div><b>ACTIONS</b>{analysis.action_items.length ? <ul>{analysis.action_items.map((item) => <li key={item}>{item}</li>)}</ul> : <span>Aucune action explicite.</span>}</div>
            <div><b>MOTS-CLES</b><div className="productivity-tags">{analysis.keywords.map((keyword) => <span key={keyword.term}>{keyword.term} <i>{keyword.count}</i></span>)}</div></div>
          </div>
        </div>
      )}
    </section>
  );
}

