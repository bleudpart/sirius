// Les confirmations reprennent le titre visible de la fenêtre.
const norm = (value) => String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function cleanModuleLabel(label) {
  return String(label || "").replace(/#/g, "").replace(/\s+/g, " ").replace(/[.!?:]+$/, "").trim();
}

export function moduleActionConfirmation(command, label, action = "open") {
  const name = cleanModuleLabel(label);
  const low = norm(command);
  if (action === "close") {
    if (!name) return "Je ferme la fenêtre.";
    return /\b(?:masque|cache)/.test(low) ? `Je masque ${name}.` : `Je ferme ${name}.`;
  }
  if (action === "minimize") return name ? `Je réduis ${name}.` : "Je réduis la fenêtre.";
  if (!name) return "J'ouvre la fenêtre.";
  if (/\b(?:affiche|montre|presente)/.test(low)) return `J'affiche ${name}.`;
  if (/\b(?:lance|demarre|active)/.test(low)) return `Je lance ${name}.`;
  return `J'ouvre ${name}.`;
}

// Fenêtres de module réellement affichées (mêmes surfaces que celles qui couvrent l'écran mobile).
const WINDOW_SELECTOR = ".holo-win, .prime-screen, .zeus-screen, .eu-screen, .setup-screen, .kr-panel, .atlas-panel, .esp-panel, .p3d-overlay, .about-panel, .media-hud-window";
const TITLE_SELECTOR = ".oracle-title, .zeus-title, .eu-title, .gcal-title, .setup-title, .kr-title, .atlas-title, .fp-title, .p3d-title, .keys-title, .vision-title, .sp-title, .about-title, [class*='-title'].font-divine";
export const WINDOW_COMMAND = /\b(?:ouvr\w*|affich\w*|montr\w*|lanc\w*|demarr\w*|activ\w*|desactiv\w*|present\w*|deplo\w*|ferm\w*|quitt\w*|masqu\w*|cach\w*|lis|lire|relis|joue\w*|mets?|allum\w*|etein\w*|coup\w*|arret\w*|envo\w*|cherch\w*|recherch\w*|connect\w*|deconnect\w*|enregistr\w*|supprim\w*|ajout\w*|cre\w*|regl\w*|program\w*|rappel\w*|synchronis\w*|actualis\w*|rafraich\w*|telecharg\w*|import\w*|export\w*|imprim\w*|partag\w*)\b/;
export const isWindowCommand = (command) => WINDOW_COMMAND.test(norm(command));

// Un message affiché mérite d'être lu s'il est nouveau, court et définitif (pas « Recherche en cours… »).
export function shortStatusToSpeak(shown, before, command) {
  const text = String(shown || "").trim();
  if (!text || text === String(before || "").trim() || norm(text) === norm(command)) return null;
  if (text.length > 120 || /(?:\.\.\.|…)$/.test(text)) return null;
  return text;
}

const spokenCase = (text) => (text === text.toUpperCase() && /[A-Z]{3}/.test(text)
  ? text.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
  : text);

export function windowLabel(el) {
  const title = el.querySelector("[data-module-name]")?.getAttribute("data-module-name")
    || el.querySelector(TITLE_SELECTOR)?.textContent || el.querySelector("h1, h2, h3")?.textContent
    || el.getAttribute("aria-label")
    || (el.getAttribute("data-testid") || "").replace(/[-_]/g, " ");
  return spokenCase(cleanModuleLabel(title));
}

export function snapshotWindows(root = document) {
  const outer = [...root.querySelectorAll(WINDOW_SELECTOR)]
    .filter((el) => !el.classList.contains("holo-minimized") && !el.parentElement?.closest(WINDOW_SELECTOR));
  return new Map(outer.map((el) => [el, windowLabel(el)]));
}

// Diff entre deux instantanés : nouvelles fenêtres, et fenêtres retirées de la page
// (une fenêtre simplement rangée en pastille par l'ouverture d'une autre n'est pas « fermée »).
export function windowChangeConfirmation(command, before, after, root = document) {
  const opened = [...after.keys()].filter((el) => !before.has(el)).map((el) => after.get(el)).filter(Boolean);
  if (opened.length) return moduleActionConfirmation(command, opened[opened.length - 1], "open");
  const closed = [...before.keys()].filter((el) => !root.contains(el)).map((el) => before.get(el));
  if (closed.length > 1) return `Je ferme ${closed.length} fenêtres.`;
  if (closed.length) return moduleActionConfirmation(command, closed[0], "close");
  return null;
}

// Surveille en continu l'ouverture et la fermeture des fenêtres, quelle qu'en soit l'origine
// (voix, doigt, souris). onChange(avant, après) est appelé une fois l'affichage stabilisé.
export function observeWindowChanges(onChange, { delay = 700, root = document } = {}) {
  let current = snapshotWindows(root);
  let timer = null;
  const sameWindows = (a, b) => a.size === b.size && [...a.keys()].every((el) => b.has(el));
  const flush = () => {
    timer = null;
    const next = snapshotWindows(root);
    if (sameWindows(current, next)) return;
    const previous = current;
    current = next;
    onChange(previous, next);
  };
  const observer = new MutationObserver(() => {
    if (!timer) timer = setTimeout(flush, delay);
  });
  observer.observe(root.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  return () => { observer.disconnect(); clearTimeout(timer); };
}
