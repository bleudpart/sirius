import { BookOpen, FolderOpen, Info, LayoutGrid, MessageCircle, Mic, SlidersHorizontal } from "lucide-react";
import { LiveDate, LiveTime } from "../liveStats";

export function WorkspaceNavigation({ active, onAssistant, onModules, onInfo, onSettings, onOdysseia, onDossiers, onVoice }) {
  const entries = [
    { id: "assistant", label: "Assistant", Icon: MessageCircle, run: onAssistant },
    { id: "modules", label: "Modules", Icon: LayoutGrid, run: onModules },
    { id: "odysseia", label: "ODYSSEIA", Icon: BookOpen, run: onOdysseia },
    { id: "info", label: "Informations", Icon: Info, run: onInfo },
    { id: "settings", label: "Configuration", Icon: SlidersHorizontal, run: onSettings },
  ];
  return (
    <nav className="workspace-navigation workspace-surface" aria-label="Espace ΣIRIUS" data-testid="workspace-navigation">
      <span className="workspace-kicker">VOTRE ESPACE</span>
      <h2>Le Panthéon</h2>
      <div className="workspace-links">
        {entries.map(({ id, label, Icon, run }) => (
          <button key={id} type="button" onClick={run} aria-current={active === id ? "page" : undefined}>
            <Icon size={18} aria-hidden="true" /><span>{label}</span>
          </button>
        ))}
      </div>
      <div className="workspace-divider" />
      <span className="workspace-kicker">ACCÈS RAPIDE</span>
      <div className="workspace-links">
        <button type="button" onClick={onDossiers}><FolderOpen size={18} aria-hidden="true" /><span>Mes dossiers</span></button>
        <button type="button" onClick={onVoice}><Mic size={18} aria-hidden="true" /><span>Ma voix et ma diction</span></button>
      </div>
    </nav>
  );
}

export function WorkspaceSummary({ connected, onDossiers, onVoice, onOdysseia }) {
  return (
    <aside className="workspace-summary" aria-label="Votre espace personnel" data-testid="workspace-summary">
      <section className="workspace-surface">
        <span className="workspace-kicker">L’INSTANT PRÉSENT</span>
        <div className="workspace-clock"><LiveTime /></div>
        <p className="workspace-subtitle"><LiveDate /></p>
        <p className="workspace-connection"><i className={connected ? "is-online" : ""} aria-hidden="true" />
          {connected ? "Serveur connecté" : "Serveur indisponible"}
        </p>
        <div className="workspace-divider" />
        <button type="button" className="workspace-summary-link" onClick={onDossiers}>
          <FolderOpen size={18} aria-hidden="true" /><span><strong>Vos dossiers</strong><small>Retrouvez vos projets et leurs suivis.</small></span>
        </button>
        <button type="button" className="workspace-summary-link" onClick={onVoice}>
          <Mic size={18} aria-hidden="true" /><span><strong>Votre voix</strong><small>Vos expressions, à votre rythme.</small></span>
        </button>
      </section>
      <section className="workspace-surface">
        <span className="workspace-kicker">ODYSSEIA</span>
        <h2>Une fenêtre sur le savoir</h2>
        <p className="workspace-subtitle">Explorez les mythes et leur histoire.</p>
        <button type="button" className="workspace-explore" onClick={onOdysseia}><BookOpen size={18} aria-hidden="true" /> Ouvrir ODYSSEIA</button>
      </section>
    </aside>
  );
}
