import { Capacitor } from "@capacitor/core";

const TITLE_SELECTOR = ".sirius-window-title, .oracle-title, .prime-title, .zeus-title, .eu-title, .gcal-title, .setup-title, .fp-title, .p3d-title, .keys-title, .vision-title, .sp-title, .atlas-title, .kr-title, .esp-title, .ww-title, h1, h2";

const clean = (value, limit) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);

function platformName() {
  const platform = Capacitor.getPlatform();
  if (platform === "android" || platform === "ios") return platform;
  const desktop = typeof window !== "undefined" && (window.siriusDesktop
    || /Electron/i.test((typeof navigator !== "undefined" && navigator.userAgent) || ""));
  return desktop ? "windows" : "web";
}

function isShown(el) {
  return !el.hidden && !el.closest(".holo-minimized, [hidden], [aria-hidden='true']");
}

function topWindow(doc) {
  const windows = [...doc.querySelectorAll(".sirius-module-window")].filter(isShown);
  // Le z-index est relevé par holoWindows à chaque ouverture ou clic : la plus haute est au premier plan.
  return windows.reduce((top, el) => (
    !top || (Number(el.style.zIndex) || 0) >= (Number(top.style.zIndex) || 0) ? el : top
  ), null);
}

/** Résumé de l'écran visible pour l'auto-support : jamais le contenu des champs saisis. */
export function activeScreenContext(doc = document) {
  const screen = { platform: platformName() };
  const section = doc.querySelector(".sirius-root")?.className.match(/\bmobile-section-([a-z0-9-]+)/);
  if (section && (screen.platform === "android" || screen.platform === "ios")) screen.section = section[1];
  const win = topWindow(doc);
  if (win) {
    const id = win.getAttribute("data-testid") || win.id || "";
    if (id) screen.window_id = clean(id, 64);
    const title = clean(win.querySelector(TITLE_SELECTOR)?.textContent, 80);
    if (title) screen.window_title = title;
  }
  const alert = [...(win || doc).querySelectorAll("[role='alert']")].find(isShown);
  const alertText = clean(alert?.textContent, 160);
  if (alertText) screen.alert = alertText;
  return screen;
}
