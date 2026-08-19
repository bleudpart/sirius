// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef } from "react";
import { Grip, X } from "lucide-react";
import "./ModulesMenu.css";

// Menu déroulant regroupé par familles (Guidage : groupement logique, max 2 niveaux).
const GROUPS = ["PANTHÉON", "OUTILS", "MÉDIAS", "SYSTÈME"];

export default function ModulesMenu({ open, onClose, items }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onEsc = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modmenu" ref={ref} data-testid="modules-menu">
      <div className="modmenu-head">
        <span><Grip size={13} /> MODULES · {items.length}</span>
        <button onClick={onClose} data-testid="modules-menu-close"><X size={14} /></button>
      </div>
      {GROUPS.map((g) => {
        const list = items.filter((it) => (it.group || "OUTILS") === g);
        if (!list.length) return null;
        return (
          <div key={g} className="modmenu-group" data-testid={`modules-menu-group-${g}`}>
            <div className="modmenu-group-title">{g}</div>
            <div className="modmenu-grid">
              {list.map((it) => {
                const Icon = it.Icon;
                return (
                  <button
                    key={it.id}
                    className={`modmenu-item ${it.active ? "active" : ""}`}
                    onClick={() => { it.run(); onClose(); }}
                    data-testid={`modules-menu-item-${it.id}`}
                    title={it.label}
                  >
                    <Icon size={16} />
                    <span className="modmenu-label">{it.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
