import { useEffect, useState } from "react";
import { Code2, FileBarChart, FileText, ListTodo, StickyNote, X } from "lucide-react";

import CodeFixer from "@/components/CodeFixer";
import DocViewer from "@/components/DocViewer";
import NotesPanel from "@/components/NotesPanel";
import ReportPanel from "@/components/ReportPanel";
import TaskPanel from "@/components/TaskPanel";
import "./Productivity.css";

const TABS = [
  { id: "documents", label: "DOCUMENTS", Icon: FileText, Component: DocViewer },
  { id: "code", label: "CODE", Icon: Code2, Component: CodeFixer },
  { id: "notes", label: "NOTES", Icon: StickyNote, Component: NotesPanel },
  { id: "tasks", label: "TACHES", Icon: ListTodo, Component: TaskPanel },
  { id: "reports", label: "RAPPORTS", Icon: FileBarChart, Component: ReportPanel },
];

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

