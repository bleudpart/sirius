import { useState } from "react";
import { BookOpen, FolderOpen, Info, LayoutGrid, MessageCircle, Mic, Search, SlidersHorizontal } from "lucide-react";
import { LiveDate, LiveTime } from "../liveStats";

export function WorkspaceNavigation({ active, connected, onAssistant, onModules, onInfo, onSettings, onOdysseia, onDossiers, onVoice, onSearch }) {
  const entries = [
    { id: "modules", label: "Mes modules", description: "Les outils de votre quotidien", Icon: LayoutGrid, run: onModules },
    { id: "dossiers", label: "Mes dossiers", description: "Projets, notes et documents", Icon: FolderOpen, run: onDossiers },
    { id: "odysseia", label: "ODYSSEIA", description: "Explorer et découvrir", Icon: BookOpen, run: onOdysseia },
    { id: "search", label: "Rechercher", description: "Retrouver une information", Icon: Search, run: onSearch },
  ];
  return (
    <nav className="workspace-navigation workspace-surface" aria-label="Espace ΣIRIUS" data-testid="workspace-navigation">
      <span className="workspace-kicker">VOTRE ESPACE</span>
      <div className="workspace-links">
        {entries.map(({ id, label, description, Icon, run }) => (
          <button key={id} type="button" data-destination={id} onClick={run} aria-label={label}
            aria-describedby={`workspace-nav-${id}`} aria-current={active === id ? "page" : undefined}>
            <Icon size={18} aria-hidden="true" /><span>{label}<small id={`workspace-nav-${id}`}>{description}</small></span>
          </button>
        ))}
      </div>
      <div className="workspace-divider" />
      <details className="workspace-secondary">
        <summary>Mon espace personnel</summary>
        <div className="workspace-links">
        <button type="button" onClick={onAssistant}><MessageCircle size={18} aria-hidden="true" /><span>Assistant</span></button>
        <button type="button" onClick={onInfo}><Info size={18} aria-hidden="true" /><span>Informations</span></button>
        <button type="button" onClick={onSettings}><SlidersHorizontal size={18} aria-hidden="true" /><span>Configuration</span></button>
        <button type="button" onClick={onVoice}><Mic size={18} aria-hidden="true" /><span>Ma voix et ma diction</span></button>
        </div>
      </details>
      <p className="workspace-connection"><i className={connected ? "is-online" : ""} aria-hidden="true" />
        {connected ? "Serveur connecté" : "Serveur indisponible"}
      </p>
    </nav>
  );
}

export function WorkspaceClock() {
  return <div className="workspace-header-clock"><strong><LiveTime /></strong><span><LiveDate /></span></div>;
}

export function WorkspaceSummary({ connected }) {
  const [note, setNote] = useState("");
  return (
    <aside className="workspace-summary" aria-label="Votre espace personnel" data-testid="workspace-summary">
      <section className="workspace-surface">
        <span className="workspace-kicker">VOTRE ESPACE</span>
        <h2>À vos côtés</h2>
        <p className="workspace-connection"><i className={connected ? "is-online" : ""} aria-hidden="true" />
          {connected ? "Serveur connecté" : "Serveur indisponible"}
        </p>
        <div className="workspace-divider" />
        <p className="workspace-subtitle">Vous demandez. Vous vérifiez les propositions. Vous gardez la main.</p>
      </section>
      <section className="workspace-surface">
        <label className="workspace-kicker" htmlFor="workspace-quick-note">NOTES RAPIDES</label>
        <h2>Une idée à garder</h2>
        <textarea id="workspace-quick-note" value={note} onChange={(event) => setNote(event.target.value)}
          placeholder="Une question, une idée, un point à retenir…" aria-describedby="workspace-note-help" />
        <p id="workspace-note-help" className="workspace-subtitle">Note temporaire, non enregistrée : elle disparaît au rechargement.</p>
      </section>
    </aside>
  );
}
