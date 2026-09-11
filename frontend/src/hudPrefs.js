// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Préférences HUD : transparence des panneaux, taille du texte, mode minimal.
export const HUD_DEFAULTS = { alpha: 1, zoom: 1, minimal: false };

export function loadHud() {
  try { return { ...HUD_DEFAULTS, ...(JSON.parse(localStorage.getItem("sirius_hud")) || {}) }; }
  catch (e) { return { ...HUD_DEFAULTS }; }
}

export function applyHud(p) {
  const root = document.documentElement;
  root.style.setProperty("--hud-panel-alpha", String(p.alpha ?? 1));
  root.style.setProperty("--hud-zoom", String(p.zoom ?? 1));
  document.body.classList.toggle("hud-minimal", !!p.minimal);
}

export function saveHud(p) {
  localStorage.setItem("sirius_hud", JSON.stringify(p));
  applyHud(p);
}
