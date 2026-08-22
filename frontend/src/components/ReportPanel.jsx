import { useCallback, useEffect, useState } from "react";
import { Check, ClipboardCopy, FileBarChart, Loader2, Plus } from "lucide-react";

import { productivityRequest } from "./productivityApi";

export default function ReportPanel() {
  const [title, setTitle] = useState("Point hebdomadaire");
  const [reports, setReports] = useState([]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await productivityRequest("/reports");
      setReports(payload.reports || []);
      setSelected((current) => current || payload.reports?.[0] || null);
    } catch (requestError) {
      setError(requestError.message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const build = async (event) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const report = await productivityRequest("/reports/build", {
        method: "POST",
        body: JSON.stringify({ title, report_type: "work" }),
      });
      setSelected(report);
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!selected?.content) return;
    try {
      await navigator.clipboard.writeText(selected.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (copyError) {
      setError(copyError.message || "Copie du rapport impossible.");
    }
  };

  return (
    <section className="productivity-tool" data-testid="productivity-report-panel">
      <div className="productivity-tool-head">
        <div><FileBarChart size={17} /><div><h3>ReportBuilder</h3><p>Rapport Markdown a partir des notes et taches locales.</p></div></div>
      </div>
      <form className="productivity-report-form" onSubmit={build}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} />
        <button type="submit" className="productivity-primary-btn" disabled={busy}>{busy ? <Loader2 size={14} className="productivity-spin" /> : <Plus size={14} />} GENERER</button>
      </form>
      {error && <div className="productivity-error" role="alert">{error}</div>}
      <div className="productivity-report-layout">
        <div className="productivity-report-list">{!reports.length && <p className="productivity-empty">Aucun rapport genere.</p>}{reports.map((report) => <button type="button" className={selected?.id === report.id ? "active" : ""} onClick={() => setSelected(report)} key={report.id}><b>{report.title}</b><span>{new Date(report.created_at).toLocaleString("fr-FR")}</span></button>)}</div>
        <div className="productivity-report-content">{selected ? <><button type="button" className="productivity-copy-btn" onClick={copy}>{copied ? <Check size={13} /> : <ClipboardCopy size={13} />} {copied ? "COPIE" : "COPIER"}</button><pre>{selected.content}</pre></> : <p className="productivity-empty">Generez un rapport pour afficher sa synthese.</p>}</div>
      </div>
    </section>
  );
}

