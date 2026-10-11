import { X } from "lucide-react";

export default function MinimizedWindowPill({ label, symbol = "Σ", onRestore, onClose, restoreProps = {} }) {
  return <div className="modwheel-minimized-pill">
    <button type="button" className="modwheel-restore" onClick={onRestore}
      aria-label={`Rouvrir ${label}`} {...restoreProps}>
      <span className="modwheel-sigma">{symbol}</span> {label}
    </button>
    <button type="button" className="minimized-pill-close" aria-label={`Fermer ${label}`}
      title={`Fermer ${label}`} onClick={(event) => { event.stopPropagation(); onClose(); }}>
      <X size={14} aria-hidden="true" />
    </button>
  </div>;
}
