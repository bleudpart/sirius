// Traduction de l'interface par le DOM : les composants restent écrits en français,
// et les textes affichés sont remplacés à partir des dictionnaires JSON (clé = texte FR).
// Aucun état React ni aucune logique métier n'est modifié ; en français, rien n'est observé.

export const LANGUAGES = [
  { code: "fr", short: "FR", label: "Français" },
  { code: "en", short: "EN", label: "English" },
  { code: "ta", short: "TA", label: "தமிழ்" },
];

const STORAGE_KEY = "sirius.language";
const ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"];
const SKIP_SELECTOR = [
  "script", "style", "textarea", "code", "pre", "noscript",
  "[contenteditable='true']", "[contenteditable='']",
  "[translate='no']", "[data-no-translate]",
].join(",");

const loaders = {
  en: () => import("./locales/en.json"),
  ta: () => import("./locales/ta.json"),
};

let current = "fr";
let dictionary = null;
let observer = null;
let requestId = 0;
const listeners = new Set();
const textRecords = new WeakMap();
const attrRecords = new WeakMap();

function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}

export function translateString(raw, dict = dictionary) {
  if (!dict || typeof raw !== "string") return null;
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
  const core = normalize(match[2]);
  if (!core) return null;
  let translated = dict[core];
  if (!translated) {
    const colon = /^(.*?)(\s*:)$/.exec(core);
    if (colon && dict[colon[1]]) translated = `${dict[colon[1]]}${colon[2]}`;
  }
  return translated ? `${match[1]}${translated}${match[3]}` : null;
}

function skipped(element) {
  return !element || Boolean(element.closest(SKIP_SELECTOR));
}

function applyText(node) {
  const value = node.nodeValue;
  let record = textRecords.get(node);
  if (!record || value !== record.written) {
    if (!record && !/[A-Za-zÀ-ÿ]/.test(value)) return;
    record = { source: value, written: value };
    textRecords.set(node, record);
  }
  if (skipped(node.parentElement)) return;
  const next = translateString(record.source) ?? record.source;
  record.written = next;
  if (node.nodeValue !== next) node.nodeValue = next;
}

function applyAttribute(element, name) {
  const value = element.getAttribute(name);
  let records = attrRecords.get(element);
  let record = records?.get(name);
  if (value === null) {
    records?.delete(name);
    return;
  }
  if (!record || value !== record.written) {
    if (!record && !dictionary) return;
    record = { source: value, written: value };
    if (!records) {
      records = new Map();
      attrRecords.set(element, records);
    }
    records.set(name, record);
  }
  if (skipped(element)) return;
  const next = translateString(record.source) ?? record.source;
  record.written = next;
  if (value !== next) element.setAttribute(name, next);
}

function applyTree(root) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    applyText(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) {
    for (const name of ATTRIBUTES) if (root.hasAttribute(name)) applyAttribute(root, name);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) applyText(node);
    else for (const name of ATTRIBUTES) if (node.hasAttribute(name)) applyAttribute(node, name);
  }
}

function onMutations(mutations) {
  for (const mutation of mutations) {
    if (mutation.type === "characterData") applyText(mutation.target);
    else if (mutation.type === "attributes") applyAttribute(mutation.target, mutation.attributeName);
    else mutation.addedNodes.forEach(applyTree);
  }
}

function startObserver() {
  if (observer || typeof MutationObserver === "undefined") return;
  observer = new MutationObserver(onMutations);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRIBUTES,
  });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
}

function readStoredLanguage() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.some((lang) => lang.code === stored) ? stored : "fr";
  } catch {
    return "fr";
  }
}

export function getLanguage() {
  return current;
}

export function subscribeLanguage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function setLanguage(code) {
  const target = LANGUAGES.some((lang) => lang.code === code) ? code : "fr";
  const id = ++requestId;
  let nextDictionary = null;
  if (target !== "fr") {
    try {
      const module = await loaders[target]();
      nextDictionary = module.default || module;
    } catch (error) {
      console.warn("[i18n] dictionnaire indisponible", target, error);
      return current;
    }
  }
  if (id !== requestId) return current;
  current = target;
  dictionary = nextDictionary;
  try { window.localStorage.setItem(STORAGE_KEY, target); } catch { /* stockage indisponible */ }
  document.documentElement.lang = target;
  document.documentElement.dataset.siriusLanguage = target;
  stopObserver();
  if (document.body) applyTree(document.body);
  if (dictionary) startObserver();
  listeners.forEach((listener) => listener(target));
  return target;
}

export function initLanguage() {
  const stored = readStoredLanguage();
  document.documentElement.dataset.siriusLanguage = stored;
  if (stored !== "fr") setLanguage(stored);
}
