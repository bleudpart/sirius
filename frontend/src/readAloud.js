// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Lecture des modules uniquement sur demande, sans pastille ni écoute secondaire.
import { speakFr, cancelSpeech } from "@/voice";

const PANEL_SELECTOR = ".prime-screen, .zeus-screen, .hud-panel, .central-card, .holo-popup, [role='dialog'][aria-label], [data-hud-panel]";
const MAX_SPEECH_CHARS = 2500;
const SKIP_TAGS = new Set(["BUTTON", "INPUT", "TEXTAREA", "SELECT", "SCRIPT", "STYLE", "SVG", "CANVAS", "OPTION", "LABEL"]);
let lastPanel = null;
const READ_COMMAND = /^(?:lis|lit|lire|relis|lecture)(?:[- ]moi)?\b\s*(.*)$/i;
const READ_FILLERS = /^(?:(?:tout\s+)?ce\s+qu['’]?\s*il\s+y\s+a\s+dans|ce\s+qui\s+est\s+affich[ée]\s+dans|(?:à|a)\s+voix\s+haute|le\s+contenu\s+(?:de|du|des|de\s+la)|le|la|les|l'|de|du|des|d'|ça|ca|cela|ce|cet|cette|contenu|texte|fenêtre|fenetre|module|panneau|page|écran|ecran)\b\s*/i;
const OTHER_READ_TARGET = /\b(?:e-?mails?|mails?|courriels?|messages?|sms|notifications?|premier|premi[eè]re|deuxi[eè]me|troisi[eè]me|dernier|derni[eè]re|\d+)\b/i;
const normalizeLabel = (value) => String(value || "").toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export function parseReadPanelCommand(command) {
  const match = String(command || "").trim().match(READ_COMMAND);
  if (!match) return null;
  let target = match[1].trim().replace(/[.!?]+$/, "");
  if (OTHER_READ_TARGET.test(target)) return null;
  let previous;
  do { previous = target; target = target.replace(READ_FILLERS, "").trim(); } while (target !== previous);
  return target;
}

const isVisible = (panel) => document.body.contains(panel) && panel.getClientRects().length > 0;

function extractText(panel) {
  const content = panel.querySelector("[data-read-content]") || panel;
  const parts = [];
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let el = node.parentElement;
      while (el) {
        if (SKIP_TAGS.has(el.tagName) || el.hasAttribute("data-no-read") || el.hidden
            || el.getAttribute("aria-hidden") === "true") return NodeFilter.FILTER_REJECT;
        if (el === content) break;
        el = el.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (text.length > 1) parts.push(text);
  }
  return parts.join(". ").replace(/\.\s*\./g, ".").trim();
}

function findPanel(target) {
  const panels = [...document.querySelectorAll(PANEL_SELECTOR)].filter(isVisible);
  if (!panels.length) return null;
  const wanted = normalizeLabel(target).split(" ").filter((word) => word.length > 1);
  if (wanted.length) {
    let best = null;
    let bestScore = 0;
    for (const panel of panels) {
      const heading = normalizeLabel(`${panel.getAttribute("aria-label") || ""} ${panel.getAttribute("data-testid") || ""} ${extractText(panel).slice(0, 160)}`);
      const score = wanted.filter((word) => heading.includes(word)).length;
      if (score > bestScore) { best = panel; bestScore = score; }
    }
    return best;
  }
  return lastPanel && isVisible(lastPanel) ? lastPanel : panels[panels.length - 1];
}

export function readPanelAloud(target = "") {
  const panel = findPanel(target);
  if (!panel) return false;
  let toRead = extractText(panel);
  if (toRead.length < 2) return false;
  if (toRead.length > MAX_SPEECH_CHARS) {
    const boundary = toRead.lastIndexOf(" ", MAX_SPEECH_CHARS);
    toRead = toRead.slice(0, boundary > 0 ? boundary : MAX_SPEECH_CHARS) + ". La suite est à l'écran.";
  }
  const heading = (panel.getAttribute("aria-label") || panel.querySelector(".zeus-title, .eu-title, h1, h2, h3")?.textContent || "")
    .replace(/\s+/g, " ").trim().slice(0, 40);
  cancelSpeech();
  speakFr(!heading ? toRead : toRead.startsWith(heading) ? `Je lis ${toRead}` : `Je lis ${heading}. ${toRead}`);
  return true;
}

let wired = false;
export function initReadAloud() {
  if (wired) return;
  wired = true;
  const markPanel = (node) => {
    const panel = node?.nodeType === 1 ? node.closest?.(PANEL_SELECTOR) : node?.parentElement?.closest(PANEL_SELECTOR);
    if (panel) lastPanel = panel;
  };
  document.addEventListener("pointerdown", (event) => markPanel(event.target));
  document.addEventListener("focusin", (event) => markPanel(event.target));
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      markPanel(mutation.target);
      for (const node of mutation.addedNodes) markPanel(node);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
