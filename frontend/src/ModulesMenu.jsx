// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { memo, useEffect, useRef } from "react";
import { Grip, X } from "lucide-react";
import "./ModulesMenu.css";
import { WORK_MODULES } from "./workModules";

// Menu déroulant regroupé par familles (Guidage : groupement logique, max 2 niveaux).
const GROUPS = ["PANTHÉON", "OUTILS", "MÉDIAS", "SYSTÈME"];

function ModulesMenu({ open, onClose, items }) {
  const ref = useRef(null);
  const compactLayout = typeof window !== "undefined" && window.innerWidth <= 1023;
  const visibleItems = compactLayout ? items.filter((item) => item.mobile !== false) : items;
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
        <span><Grip size={13} /> MODULES · {visibleItems.length}</span>
        <button onClick={onClose} data-testid="modules-menu-close"><X size={14} /></button>
      </div>
      {GROUPS.map((g) => {
        const list = visibleItems.filter((it) => (it.group || "OUTILS") === g);
        if (!list.length) return null;
        return (
          <div key={g} className="modmenu-group" data-testid={`modules-menu-group-${g}`}>
            <div className="modmenu-group-title">{g}</div>
            <div className="modmenu-grid">
              {list.map((it) => {
                const Icon = it.Icon;
                const workModule = WORK_MODULES.find((module) => module.id === it.id);
                const [name, purpose] = it.label.split(" — ");
                const functionLabel = workModule?.description || purpose;
                return (
                  <button
                    key={it.id}
                    className={`modmenu-item ${it.active ? "active" : ""}`}
                    onClick={() => { it.run(); onClose(); }}
                    data-testid={`modules-menu-item-${it.id}`}
                    title={it.label}
                  >
                    <Icon size={16} />
                    <span className="modmenu-label">
                      {functionLabel || name}
                      {functionLabel && <small>{workModule?.label || name}</small>}
                    </span>
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

export default memo(ModulesMenu);
