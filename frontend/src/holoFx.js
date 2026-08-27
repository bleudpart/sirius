// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
// Fermeture holographique générique : intercepte les boutons de fermeture,
// joue l'animation GSAP 3D puis relaie le clic réel au composant.
import { animateHoloClose, animateHoloCloseCard } from "./gsapAnimations";

const PANELS = ".prime-screen, .zeus-screen, .modmenu, .central-card, .holo-popup, .hud-panel, .setup-panel";
const CLOSERS = '[data-testid*="close"], .zeus-close, .setup-close';

export function initHoloFx() {
  if (window.__holoFxInit) return;
  window.__holoFxInit = true;
  document.addEventListener(
    "click",
    (e) => {
      if (e.__holo) return;
      const btn = e.target.closest ? e.target.closest(CLOSERS) : null;
      if (!btn) return;
      const panel = btn.closest(PANELS);
      if (!panel || panel.classList.contains("holo-closing")) return;
      e.stopPropagation();
      e.preventDefault();
      panel.classList.add("holo-closing");
      const dispatch = () => {
        panel.classList.remove("holo-closing");
        const ev = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
        ev.__holo = true;
        btn.dispatchEvent(ev);
      };
      if (panel.classList.contains("central-card")) {
        animateHoloCloseCard(panel, dispatch);
      } else {
        animateHoloClose(panel, dispatch);
      }
    },
    true
  );
}
