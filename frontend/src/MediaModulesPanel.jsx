import { Clapperboard, X } from "lucide-react";
import ModulesMedia from "./ModulesMedia";

export default function MediaModulesPanel({ onClose }) {
  return (
    <div className="prime-screen media-catalogue-screen" role="dialog" aria-label="Modules multimédia ΣIRIUS" data-testid="media-modules-panel">
      <header className="zeus-head">
        <div className="zeus-title font-divine"><Clapperboard size={20} /> MODULES MULTIMÉDIA</div>
        <button className="setup-close zeus-close" onClick={onClose} aria-label="Fermer les modules multimédia"><X size={18} /></button>
      </header>
      <ModulesMedia />
    </div>
  );
}
