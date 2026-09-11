// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, CornerDownLeft } from "lucide-react";
import "./CommandPalette.css";

// Palette de commandes (Ctrl+K) : recherche et lance n'importe quel module par son nom.
export default function CommandPalette({ open, onClose, items }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((it) => it.label.toLowerCase().includes(s) || it.id.includes(s));
  }, [q, items]);

  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 50); } }, [open]);
  useEffect(() => { setSel(0); }, [q]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); const it = filtered[sel]; if (it) { it.run(); onClose(); } }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, filtered, sel, onClose]);

  if (!open) return null;
  return (
    <div className="cmdp-overlay" onClick={onClose} data-testid="command-palette">
      <div className="cmdp-box" onClick={(e) => e.stopPropagation()}>
        <div className="cmdp-search">
          <Search size={16} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un module… (ex: locus, oracle, packager)"
            data-testid="command-palette-input"
          />
          <kbd>ESC</kbd>
        </div>
        <div className="cmdp-list" data-testid="command-palette-list">
          {filtered.length === 0 && <div className="cmdp-empty">Aucun module trouvé.</div>}
          {filtered.map((it, i) => {
            const Icon = it.Icon;
            return (
              <button
                key={it.id}
                className={`cmdp-item ${i === sel ? "sel" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => { it.run(); onClose(); }}
                data-testid={`command-palette-item-${it.id}`}
              >
                <Icon size={16} />
                <span className="cmdp-label">{it.label}</span>
                {i === sel && <CornerDownLeft size={13} className="cmdp-enter" />}
              </button>
            );
          })}
        </div>
        <div className="cmdp-foot"><span>↑↓ naviguer</span><span>↵ ouvrir</span><span>Ctrl+K</span></div>
      </div>
    </div>
  );
}
