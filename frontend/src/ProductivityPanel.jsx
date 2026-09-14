import { useEffect, useState } from "react";
import { Code2, FileBarChart, FileText, ListTodo, StickyNote, X, RefreshCw } from "lucide-react";
import { productivityRequest } from "@/components/productivityApi";

import CodeFixer from "@/components/CodeFixer";
import DocViewer from "@/components/DocViewer";
import NotesPanel from "@/components/NotesPanel";
import ReportPanel from "@/components/ReportPanel";
import TaskPanel from "@/components/TaskPanel";
import "./Productivity.css";

const BASE_TABS = [
  { id: "documents", label: "DOCUMENTS", Icon: FileText, Component: DocViewer },
  { id: "code", label: "CODE", Icon: Code2, Component: CodeFixer },
  { id: "notes", label: "NOTES", Icon: StickyNote, Component: NotesPanel },
  { id: "tasks", label: "TACHES", Icon: ListTodo, Component: TaskPanel },
  { id: "reports", label: "RAPPORTS", Icon: FileBarChart, Component: ReportPanel },
];

function SyncPanel() {
  const [state, setState] = useState({ busy: false, message: "", conflicts: [] });
  const sync = async () => {
    setState({ busy: true, message: "Synchronisation en cours…", conflicts: [] });
    try {
      let deviceId = localStorage.getItem("sirius_productivity_device");
      if (!deviceId) { deviceId = crypto.randomUUID(); localStorage.setItem("sirius_productivity_device", deviceId); }
      const [noteData, taskData] = await Promise.all([productivityRequest("/notes"), productivityRequest("/tasks")]);
      const changes = [
        ...(noteData.notes || []).map((payload) => ({ entity_type: "note", entity_id: payload.id, operation: "upsert", payload })),
        ...(taskData.tasks || []).map((payload) => ({ entity_type: "task", entity_id: payload.id, operation: "upsert", payload })),
      ];
      const result = await productivityRequest("/sync/push", { method: "POST", body: JSON.stringify({ device_id: deviceId, changes }) });
      const pulled = await productivityRequest("/sync/pull", { method: "POST", body: JSON.stringify({ device_id: deviceId, since: "" }) });
      window.dispatchEvent(new CustomEvent("productivity-sync-complete", { detail: pulled }));
      setState({ busy: false, message: `${pulled.notes.length} note(s) et ${pulled.tasks.length} tâche(s) synchronisée(s).`, conflicts: result.conflicts || [] });
    } catch (error) { setState({ busy: false, message: error.message || "Synchronisation impossible.", conflicts: [] }); }
  };
  return <section className="productivity-tool" data-testid="productivity-sync-panel"><div><RefreshCw size={17} /><h3>Synchronisation</h3><p>Notes et tâches sur tes appareils connectés.</p></div><button type="button" onClick={sync} disabled={state.busy}><RefreshCw size={14} /> {state.busy ? "SYNCHRONISATION…" : "SYNCHRONISER"}</button>{state.message && <p>{state.message}</p>}{state.conflicts.length > 0 && <p>{state.conflicts.length} conflit(s) à vérifier.</p>}</section>;
}

const TABS = [...BASE_TABS, { id: "sync", label: "SYNC", Icon: RefreshCw, Component: SyncPanel }];

export default function ProductivityPanel({ onClose, initialTab = "documents" }) {
  const [tab, setTab] = useState(TABS.some((item) => item.id === initialTab) ? initialTab : "documents");
  const active = TABS.find((item) => item.id === tab) || TABS[0];
  const ActiveComponent = active.Component;

  useEffect(() => {
    if (TABS.some((item) => item.id === initialTab)) setTab(initialTab);
  }, [initialTab]);

  return (
    <div className="productivity-screen" data-testid="productivity-panel" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="productivity-card">
        <header className="productivity-header">
          <div><span>MODULE 4</span><h2>PRODUCTIVITE &amp; TRAVAIL</h2><p>Documents, code, notes, taches et rapports restent sur votre poste.</p></div>
          <button type="button" onClick={onClose} aria-label="Fermer Productivite"><X size={18} /></button>
        </header>
        <nav className="productivity-tabs" aria-label="Outils Productivite">
          {TABS.map((item) => <button type="button" className={item.id === tab ? "active" : ""} onClick={() => setTab(item.id)} key={item.id}><item.Icon size={14} /> {item.label}</button>)}
        </nav>
        <main className="productivity-content"><ActiveComponent /></main>
      </div>
    </div>
  );
}

