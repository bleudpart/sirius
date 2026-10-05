// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clapperboard, Cpu, GripHorizontal, Landmark, LayoutGrid, Minus, Search, Wrench, X } from "lucide-react";
import "./ModulesMenu.css";
import { WORK_MODULES, workModuleName } from "./workModules";
import useWheelWindow from "./useWheelWindow";

// Roue orbitale centrée : la catégorie active pivote en haut, ses modules s'affichent à côté.
const GROUPS = [
  { id: "PANTHÉON", Icon: Landmark },
  { id: "OUTILS", Icon: Wrench },
  { id: "MÉDIAS", Icon: Clapperboard },
  { id: "SYSTÈME", Icon: Cpu },
];

const WHEEL = 300;
const CENTER = WHEEL / 2;
const R_OUT = 142;
const R_IN = 92;
const R_LABEL = (R_OUT + R_IN) / 2;

const polar = (radius, deg) => {
  const rad = (deg * Math.PI) / 180;
  return [CENTER + radius * Math.cos(rad), CENTER + radius * Math.sin(rad)];
};

const arcPath = (centerDeg) => {
  const a0 = centerDeg - 42;
  const a1 = centerDeg + 42;
  const [x0, y0] = polar(R_OUT, a0);
  const [x1, y1] = polar(R_OUT, a1);
  const [x2, y2] = polar(R_IN, a1);
  const [x3, y3] = polar(R_IN, a0);
  return `M${x0} ${y0} A${R_OUT} ${R_OUT} 0 0 1 ${x1} ${y1} L${x2} ${y2} A${R_IN} ${R_IN} 0 0 0 ${x3} ${y3}Z`;
};

const normalize = (text) => (text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function describe(item) {
  const workModule = WORK_MODULES.find((module) => module.id === item.id);
  const [name, purpose] = item.label.split(" — ");
  const functionLabel = workModule?.description || purpose;
  return { functionLabel, name: (workModule ? workModuleName(workModule.label) : name).replace(/\s*#$/, "") };
}

function ModulesMenu({ open, onClose, items }) {
  const searchRef = useRef(null);
  const compactLayout = typeof window !== "undefined" && window.innerWidth <= 1023;
  const visibleItems = compactLayout ? items.filter((item) => item.mobile !== false) : items;
  const groups = useMemo(() => {
    const known = GROUPS.map((g) => g.id);
    const extra = [...new Set(visibleItems.map((it) => it.group || "OUTILS"))].filter((id) => !known.includes(id));
    return [...GROUPS, ...extra.map((id) => ({ id, Icon: LayoutGrid }))]
      .map((g) => ({ ...g, items: visibleItems.filter((it) => (it.group || "OUTILS") === g.id) }))
      .filter((g) => g.items.length);
  }, [visibleItems]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [query, setQuery] = useState("");
  const [hovered, setHovered] = useState(null);
  const { minimized, setMinimized, windowProps } = useWheelWindow("modules");

  useEffect(() => {
    if (!open) return;
    setMinimized(false);
    setQuery("");
    setHovered(null);
    const current = groups.findIndex((g) => g.items.some((it) => it.active));
    const start = current >= 0 ? current : 0;
    setActiveIndex(start);
    setRotation(-start * (360 / Math.max(groups.length, 1)));
    if (!compactLayout) window.setTimeout(() => searchRef.current?.focus(), 0);
    // L'état est réinitialisé uniquement à l'ouverture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || !groups.length) return null;

  const step = 360 / groups.length;
  const safeIndex = Math.min(activeIndex, groups.length - 1);
  const activeGroup = groups[safeIndex];

  const selectGroup = (index) => {
    const n = groups.length;
    const target = ((index % n) + n) % n;
    const delta = ((target - safeIndex + n + Math.floor(n / 2)) % n) - Math.floor(n / 2);
    setRotation((r) => r - delta * step);
    setActiveIndex(target);
    setQuery("");
    setHovered(null);
  };

  const q = normalize(query.trim());
  const shown = q ? visibleItems.filter((it) => normalize(`${it.label} ${describe(it).functionLabel || ""}`).includes(q)) : activeGroup.items;

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (query) setQuery("");
      else onClose();
      return;
    }
    if (e.target === searchRef.current && query) return;
    if (e.key === "ArrowRight") { e.preventDefault(); selectGroup(safeIndex + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); selectGroup(safeIndex - 1); }
  };

  const core = hovered ? describe(hovered) : null;

  if (minimized) {
    return createPortal(
      <div className="modwheel-overlay is-minimized" data-testid="modules-menu" onKeyDown={onKeyDown}>
        <button type="button" className="modwheel-restore" onClick={() => setMinimized(false)} data-testid="modules-menu-restore" title="Rouvrir le menu des modules">
          <span className="modwheel-sigma">Σ</span> MODULES
        </button>
      </div>,
      document.body
    );
  }

  // Portail : le HUD crée des contextes d'empilement qui placeraient le menu sous les pastilles flottantes.
  return createPortal(
    <div
      className="modwheel-overlay"
      data-testid="modules-menu"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={onKeyDown}
    >
      <div className="modwheel" role="dialog" aria-modal="true" aria-label="Menu des modules" {...windowProps}>
        <span className="modwheel-grip" aria-hidden="true" title="Glisser pour déplacer · double-clic pour recentrer"><GripHorizontal size={16} /></span>
        <button type="button" className="modwheel-min" onClick={() => setMinimized(true)} data-testid="modules-menu-minimize" aria-label="Réduire le menu des modules" title="Réduire">
          <Minus size={16} />
        </button>
        <button type="button" className="modwheel-close" onClick={onClose} data-testid="modules-menu-close" aria-label="Fermer le menu des modules" title="Fermer (Échap)">
          <X size={16} />
        </button>

        <div className="modwheel-dial">
          <div className="modwheel-ring" style={{ "--rot": `${rotation}deg` }}>
            <svg viewBox={`0 0 ${WHEEL} ${WHEEL}`} aria-hidden="true">
              <circle className="modwheel-orbit" cx={CENTER} cy={CENTER} r={R_OUT + 8} />
              <circle className="modwheel-orbit modwheel-orbit-inner" cx={CENTER} cy={CENTER} r={R_IN - 10} />
              {groups.map((g, i) => (
                <path key={g.id} className={`modwheel-seg ${i === safeIndex && !q ? "active" : ""}`} d={arcPath(-90 + i * step)} />
              ))}
            </svg>
            {groups.map((g, i) => {
              const [x, y] = polar(R_LABEL, -90 + i * step);
              const GroupIcon = g.Icon;
              return (
                <button
                  type="button"
                  key={g.id}
                  className={`modwheel-cat ${i === safeIndex && !q ? "active" : ""}`}
                  style={{ left: `${(x / WHEEL) * 100}%`, top: `${(y / WHEEL) * 100}%`, "--counter": `${-rotation}deg` }}
                  onClick={() => selectGroup(i)}
                  aria-pressed={i === safeIndex && !q}
                  data-testid={`modules-menu-group-${g.id}`}
                >
                  <GroupIcon size={17} />
                  <span>{g.id}</span>
                  <small>{g.items.length}</small>
                </button>
              );
            })}
          </div>
          <div className="modwheel-core" aria-live="polite">
            <span className="modwheel-sigma">Σ</span>
            {core ? (
              <>
                <strong>{core.name}</strong>
                {core.functionLabel && <em>{core.functionLabel}</em>}
              </>
            ) : (
              <>
                <strong>{q ? "RECHERCHE" : activeGroup.id}</strong>
                <em>{shown.length} module{shown.length > 1 ? "s" : ""}</em>
              </>
            )}
          </div>
        </div>

        <div className="modwheel-panel">
          <label className="modwheel-search">
            <Search size={15} />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Rechercher parmi ${visibleItems.length} modules…`}
              aria-label="Rechercher un module"
              data-testid="modules-menu-search"
            />
          </label>
          <div className="modwheel-title">
            {q ? `Résultats · ${shown.length}` : `${activeGroup.id} · ${activeGroup.items.length}`}
            <span>← → pour tourner la roue</span>
          </div>
          <div className="modwheel-grid" key={q ? "search" : activeGroup.id}>
            {shown.length === 0 && <p className="modwheel-empty">Aucun module ne correspond.</p>}
            {shown.map((it, index) => {
              const Icon = it.Icon;
              const { functionLabel, name } = describe(it);
              return (
                <button
                  type="button"
                  key={it.id}
                  className={`modmenu-item ${it.active ? "active" : ""}`}
                  style={{ "--i": Math.min(index, 18) }}
                  onClick={() => { it.run(); onClose(); }}
                  onMouseEnter={() => setHovered(it)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(it)}
                  onBlur={() => setHovered(null)}
                  data-testid={`modules-menu-item-${it.id}`}
                  title={it.label}
                >
                  <span className="modmenu-ico"><Icon size={18} /></span>
                  <span className={`modmenu-label ${functionLabel ? "" : "modmenu-name"}`}>
                    {functionLabel || name}
                    {functionLabel && <small>{name}</small>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default memo(ModulesMenu);
