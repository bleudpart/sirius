// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
// Lecture à voix haute universelle : dès qu'un contenu textuel significatif apparaît
// dans un panneau (tous modules), Sirius propose « Veux-tu que je te lise ça à voix haute ? ».
import { speakFr, cancelSpeech } from "@/voice";

const PANEL_SELECTOR = ".prime-screen, .zeus-screen, .hud-panel, .central-card, .holo-popup";
const MIN_CHARS = 110;
const MAX_SPEECH_CHARS = 2500;
const RESHOW_DELTA = 80; // nouveau contenu significatif = variation de longueur > 80 caractères
const SKIP_TAGS = new Set(["BUTTON", "INPUT", "TEXTAREA", "SELECT", "SCRIPT", "STYLE", "SVG", "CANVAS", "OPTION", "LABEL"]);

const state = new WeakMap(); // panel -> { muted, promptedLen, bar, timer }
let currentPanel = null; // dernier panneau proposant une lecture
let miniRec = null;
const enabled = () => localStorage.getItem("sirius_read_aloud") !== "off";

// Réponse vocale « oui / non » : consommée par le micro principal (App.js) ou la mini-écoute locale
function answerFromVoice(text) {
  const t = (text || "").toLowerCase().trim();
  const st = currentPanel ? state.get(currentPanel) : null;
  if (!st || !st.bar) return false;
  if (/^(oui|ouais|ok|d'accord|vas[- ]?y|lis|lis[- ]?(le|la|ça))\b/.test(t)) {
    st.bar.querySelector(".read-aloud-yes").click();
    return true;
  }
  if (/^(non|nan|pas maintenant|laisse|annule|stop)\b/.test(t)) {
    st.bar.querySelector(".read-aloud-no").click();
    return true;
  }
  return false;
}
if (typeof window !== "undefined") window.__siriusReadAloudAnswer = answerFromVoice;

function stopMiniRec() {
  if (miniRec) { try { miniRec.abort(); } catch (e) { /* déjà arrêté */ } miniRec = null; }
}

// Mini-écoute (7 s) : uniquement si le micro principal est inactif et déjà autorisé
async function listenForAnswer() {
  if (window.__siriusMicOn || (window.speechSynthesis && window.speechSynthesis.speaking)) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  try {
    const perm = await navigator.permissions.query({ name: "microphone" });
    if (perm.state !== "granted") return;
  } catch (e) { return; }
  if (window.__siriusMicOn) return;
  stopMiniRec();
  try {
    const rec = new SR();
    rec.lang = "fr-FR";
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => answerFromVoice(e.results[e.results.length - 1][0].transcript);
    rec.onend = () => { if (miniRec === rec) miniRec = null; };
    rec.onerror = () => {};
    rec.start();
    miniRec = rec;
    setTimeout(() => { try { rec.stop(); } catch (e) { /* fini */ } }, 7000);
  } catch (e) { /* micro indisponible */ }
}

function extractText(panel) {
  const parts = [];
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let el = node.parentElement;
      while (el && el !== panel) {
        if (SKIP_TAGS.has(el.tagName) || el.classList.contains("read-aloud-bar") || el.hasAttribute("data-no-read")) {
          return NodeFilter.FILTER_REJECT;
        }
        el = el.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.replace(/\s+/g, " ").trim();
    if (t.length > 1) parts.push(t);
  }
  return parts.join(". ").replace(/\.\s*\./g, ".").trim();
}

function removeBar(panel) {
  const st = state.get(panel);
  if (st && st.bar) { st.bar.remove(); st.bar = null; }
  if (currentPanel === panel) { currentPanel = null; stopMiniRec(); }
}

function buildBar(panel) {
  removeBar(panel);
  const st = state.get(panel);
  const bar = document.createElement("div");
  bar.className = "read-aloud-bar";
  bar.setAttribute("data-testid", "read-aloud-bar");
  bar.innerHTML = `
    <span class="read-aloud-q">Veux-tu que je te lise ça à voix haute ? <span class="read-aloud-hint">— dis « oui » ou « non »</span></span>
    <span class="read-aloud-actions">
      <button type="button" class="read-aloud-yes" data-testid="read-aloud-yes">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
        <span class="read-aloud-yes-label">OUI, LIS-LE</span>
      </button>
      <button type="button" class="read-aloud-no" data-testid="read-aloud-no">NON</button>
    </span>`;
  const yes = bar.querySelector(".read-aloud-yes");
  const label = bar.querySelector(".read-aloud-yes-label");
  const no = bar.querySelector(".read-aloud-no");
  let speaking = false;
  yes.addEventListener("click", (e) => {
    e.stopPropagation();
    if (speaking) {
      cancelSpeech();
      speaking = false;
      label.textContent = "OUI, LIS-LE";
      return;
    }
    speaking = true;
    label.textContent = "ARRÊTER";
    let toRead = extractText(panel); // contenu à jour au moment du clic
    if (toRead.length > MAX_SPEECH_CHARS) toRead = toRead.slice(0, MAX_SPEECH_CHARS) + ". La suite est à l'écran.";
    speakFr(toRead, { onend: () => { speaking = false; removeBar(panel); } });
  });
  no.addEventListener("click", (e) => {
    e.stopPropagation();
    if (speaking) cancelSpeech();
    st.muted = true; // plus de proposition tant que cette fenêtre reste ouverte
    removeBar(panel);
  });
  panel.appendChild(bar);
  st.bar = bar;
  currentPanel = panel;
  listenForAnswer();
}

function evaluate(panel) {
  if (!enabled() || !document.body.contains(panel)) return;
  const st = state.get(panel);
  if (st.muted || st.bar) return;
  const text = extractText(panel);
  if (text.length < MIN_CHARS) return;
  // Re-proposition uniquement si le contenu a réellement changé (pas un simple rafraîchissement de jauges)
  if (st.promptedLen && Math.abs(text.length - st.promptedLen) <= RESHOW_DELTA) return;
  st.promptedLen = text.length;
  buildBar(panel);
}

function schedule(panel) {
  let st = state.get(panel);
  if (!st) { st = { muted: false, promptedLen: 0, bar: null, timer: null }; state.set(panel, st); }
  clearTimeout(st.timer);
  st.timer = setTimeout(() => evaluate(panel), 1200);
}

let wired = false;
export function initReadAloud() {
  if (wired) return;
  wired = true;
  document.querySelectorAll(PANEL_SELECTOR).forEach(schedule);
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.target.nodeType === 1 && m.target.closest && m.target.closest(".read-aloud-bar")) continue;
      const panel = m.target.nodeType === 1 && m.target.closest ? m.target.closest(PANEL_SELECTOR) : null;
      if (panel) schedule(panel);
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches && n.matches(PANEL_SELECTOR)) schedule(n);
        if (n.querySelectorAll) n.querySelectorAll(PANEL_SELECTOR).forEach(schedule);
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
}
