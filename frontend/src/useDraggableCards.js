// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef } from "react";

// Rend déplaçables (drag & drop souris) les fenêtres .prime-card d'un module personnage.
// Position mémorisée par module + data-testid dans localStorage. À appeler avec le ref du conteneur racine.
export default function useDraggableCards(deps = []) {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ns = root.getAttribute("data-testid") || "module";
    const cleanups = [];
    const cards = root.querySelectorAll(".prime-card");

    cards.forEach((card, idx) => {
      const key = `sirius_card_pos_${ns}_` + (card.getAttribute("data-testid") || `card-${idx}`);
      card.classList.add("draggable-card");

      // Restaurer la position sauvegardée
      try {
        const saved = JSON.parse(localStorage.getItem(key));
        if (saved && typeof saved.x === "number") {
          card.style.transform = `translate(${saved.x}px, ${saved.y}px)`;
        }
      } catch (e) { /* position invalide ignorée */ }

      // Poignée de déplacement
      let grip = card.querySelector(".card-drag-grip");
      if (!grip) {
        grip = document.createElement("div");
        grip.className = "card-drag-grip";
        grip.title = "Glisser pour déplacer cette fenêtre";
        grip.innerHTML = "&#8942;&#8942;";
        card.appendChild(grip);
      }

      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;

      const parseXY = () => {
        const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(card.style.transform || "");
        return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
      };

      const onMove = (e) => {
        if (!dragging) return;
        card.style.transform = `translate(${ox + e.clientX - sx}px, ${oy + e.clientY - sy}px)`;
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        card.classList.remove("dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        try { localStorage.setItem(key, JSON.stringify(parseXY())); } catch (e) { /* stockage plein ignoré */ }
      };
      const onDown = (e) => {
        // Ne pas démarrer le drag sur un élément interactif
        if (e.target.closest("button, a, input, select, textarea, [role='button']")) return;
        const cur = parseXY();
        ox = cur.x; oy = cur.y; sx = e.clientX; sy = e.clientY;
        dragging = true;
        card.classList.add("dragging");
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        e.preventDefault();
      };

      // Le drag démarre depuis la poignée OU n'importe quel en-tête de la carte
      grip.addEventListener("pointerdown", onDown);
      const headings = card.querySelectorAll(".zc-section-title, .prime-card-title, .oracle-card-title, h3, h4");
      headings.forEach((h) => { h.style.cursor = "grab"; h.addEventListener("pointerdown", onDown); });

      cleanups.push(() => {
        grip.removeEventListener("pointerdown", onDown);
        headings.forEach((h) => h.removeEventListener("pointerdown", onDown));
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      });
    });

    return () => cleanups.forEach((fn) => fn());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return rootRef;
}
