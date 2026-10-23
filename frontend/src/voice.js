// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
// Voix de Sirius — synthèse locale ou Google Cloud TTS avec basculement
// automatique sur la synthèse du navigateur si la clé est absente ou l'API indisponible.
import { Capacitor } from "@capacitor/core";
import { applyFrenchPhonetics, normalizeFrenchElisions } from "./phoneticFr";
import { connectVoiceEqualizer } from "./voiceEqualizer";
import { speakNative, stopNativeSpeech } from "./nativeVoice";
import { API_BASE_URL } from "./lib/api";
import { KEY_STORAGE_EVENT, loadApiKeys } from "./apiKeyStorage";
import { formatSpeechDate } from "./dateTime";
import { selectFrenchVoice } from "./frenchVoiceSelection";
import { stripSpokenSources } from "./spokenSources";

const API = API_BASE_URL;
const TTS_REQUEST_TIMEOUT_MS = 8000;
const FEMALE = /(female|femme|amelie|audrey|marie|julie|celine|hortense|denise|eloise|charline|virginie|chantal|neural2-f|neural2-a|neural2-c|neural2-e|wavenet-a|wavenet-c|wavenet-e)/i;

// Triche phonétique : lexique français intégré (sigles, anglicismes, noms propres)
// + dictionnaire vocal personnalisé (écran Profil, localStorage "sirius_phonetic").
const phonetic = (text) => applyFrenchPhonetics(text);

// Nettoyage du texte avant synthèse vocale : retire l'habillage Markdown (astérisques,
// tirets de liste, titres #, `code`, liens…) et les symboles pour que le moteur TTS lise
// uniquement le texte. La ponctuation de phrase (. , ; : ! ?) est CONSERVÉE : le moteur
// ne la prononce pas, il respire dessus — la retirer accélère artificiellement la voix.
// Nettoyage du texte pour l'affichage ΣIRIUS DISPLAY : retire l'habillage Markdown
// (titres #, gras/italique, puces) que le LLM ajoute parfois, tout en gardant les
// retours à la ligne et la ponctuation — contrairement à cleanTextForSpeech, on ne
// touche pas aux parenthèses/barres qui ont un sens visuel à l'écrit.
export function cleanTextForDisplay(t) {
  return String(t || "")
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ""))  // garde le contenu des blocs de code
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")        // titres # ## ###
    .replace(/^[ \t]*>[ \t]?/gm, "")             // citations >
    .replace(/^[ \t]*[*+•▪◦][ \t]+/gm, "— ")     // puces * + • → tiret simple
    .replace(/^[ \t]*-[ \t]+/gm, "— ")           // puces - → tiret simple
    .replace(/(\*\*|__)(.*?)\1/g, "$2")          // **gras** __gras__
    .replace(/(?<!\w)(\*|_)([^*_\n]+)\1(?!\w)/g, "$2") // *italique* _italique_
    .replace(/[*_`~]/g, "")                      // symboles Markdown restants
    .replace(/\n{3,}/g, "\n\n")                  // pas plus de 2 retours à la ligne d'affilée
    .trim();
}

function cleanTextForSpeech(t) {
  return normalizeFrenchElisions(normalizeFrenchElisions(stripSpokenSources(t))
    // « ΣIRIUS » : la synthèse lit le sigma grec (« sigma irius ») ; le nom se prononce « Sirius ».
    .replace(/Σ\s?IRIUS/gi, "Sirius")
    .replace(/\bCEST\b/g, "heure d'été d'Europe centrale")
    .replace(/\bCET\b/g, "heure d'Europe centrale")
    .replace(/\b(?:versus|vs\.?)(?!\s+Code\b)(?=\s|$|[,:;!?])/gi, "contre")
    .replace(/```[\s\S]*?```/g, " ")            // blocs de code entiers
    .replace(/`([^`]*)`/g, "$1")                 // `code` en ligne → contenu
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")  // liens/images Markdown → texte du lien
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")        // titres # ## ###
    .replace(/^[ \t]*>[ \t]?/gm, "")             // citations >
    .replace(/^[ \t]*[-*+•▪◦][ \t]+/gm, "")      // puces de liste - * + •
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, "")       // listes numérotées 1. 2)
    .replace(/(\*\*|__)(.*?)\1/g, "$2")          // **gras** __gras__
    .replace(/(\*|_)(.*?)\1/g, "$2")             // *italique* _italique_
    .replace(/[*_#`~|]/g, " ")                   // symboles Markdown restants
    .replace(/[•▪◦‣·→←↔⇒➜]/gu, ", ")
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}★☆✓✔✗✘\uFE0F\u200D]/gu, " ")
    .replace(/(\d)\s*€/g, "$1 euros")
    .replace(/(\d)\s*%/g, "$1 pour cent")
    .replace(/(\d)\s*°\s*C\b/gi, "$1 degrés Celsius")
    .replace(/\b(?:ton|le)\s+((?:sirius|zirius)\s+display)\b/gi, "mon $1")
    .replace(/[\u2010\u2011\u2012]/g, "-")       // tirets Unicode (insécables) → tiret simple
    // Élision mal orthographiée par le LLM : « dites-m-en » → « dites-m'en » (sinon « m » se lit « meu »).
    .replace(/-([mtl])-(en|y)\b/gi, "-$1'$2")
    .replace(/[—–]/g, ", ")                      // tirets longs → pause naturelle
    .replace(/\s-{2,}\s/g, ", ")                 // -- ou --- entre mots
    .replace(/(?<![\p{L}\p{N}_-])\d{4}-\d{2}-\d{2}(?![\p{L}\p{N}_-])/gu, (date) => formatSpeechDate(date))
    .replace(/(\d)\s*-\s*(\d)/g, "$1 à $2")       // plage numérique 10-15 → « 10 à 15 » (pas « moins »)
    // Seuls les tirets ISOLÉS deviennent des espaces. Un tiret entre deux lettres soude un mot
    // (« dites-m'en », « peut-être », « e-mail ») : le couper fait lire « m » comme « meu ».
    .replace(/(?<!\p{L})-|-(?!\p{L})/gu, " ")
    .replace(/[()\[\]{}<>]/g, "")    // supprime parenthèses / crochets / accolades / chevrons
    .replace(/\/+/g, " ")            // supprime barres
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/,\s*(?=[.!?])/g, "")
    .replace(/[ \t]+/g, " ")         // normalise espaces (garde les fins de phrase)
    .trim()).replace(/\bL'(?=\p{L})/gu, "l'");
}

// Ton adapté à l'urgence : plus rapide et tendu si le message est urgent
const isUrgent = (text) => /!|\b(urgent|vite|attention|alerte|imm[ée]diatement|danger|grave)\b/i.test(text);

// ---- Google Cloud TTS (via backend, clé jamais exposée) ----
let currentAudio = null;
let cancelVoiceDiscovery = null;
let finishCurrentAudio = null;
let currentRequest = null;
let activeSequence = null; // lecture en série (bulletin) qui possède la parole
let googleDownUntil = 0; // clé absente / API en panne → on évite de retenter pendant 10 min
let geminiDownUntil = 0;
window.addEventListener(KEY_STORAGE_EVENT, () => {
  googleDownUntil = 0;
  geminiDownUntil = 0;
});
let speakSeq = 0; // n° de la dernière prise de parole — garantit UNE SEULE voix à la fois
let utterances = 0; // nombre de prises de parole lancées (l'annulation ne compte pas)
let lastUtteranceAt = 0;
export const spokenCount = () => utterances;
export const lastSpokenAt = () => lastUtteranceAt;

// Coupe TOUS les canaux audio (synthèse navigateur + audio Google) avant chaque nouvelle voix
function stopChannels() {
  if (cancelVoiceDiscovery) {
    cancelVoiceDiscovery();
    cancelVoiceDiscovery = null;
  }
  if (currentRequest) {
    currentRequest.abort();
    currentRequest = null;
  }
  if (Capacitor.getPlatform() === "android") stopNativeSpeech();
  try { window.speechSynthesis.cancel(); } catch (e) {}
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.src = ""; } catch (e) {}
    currentAudio = null;
  }
  if (finishCurrentAudio) {
    finishCurrentAudio(true);
    finishCurrentAudio = null;
  }
}

function reportGeminiFailure(reason) {
  console.warn("Gemini TTS indisponible :", reason);
  window.dispatchEvent(new CustomEvent("sirius-voice-degraded", {
    detail: "Voix Gemini indisponible ; utilisation de la voix locale de secours.",
  }));
}

// Préférences de voix (écran Profil) : voix, débit, gravité
export const DEFAULT_VOICE = { name: "browser-female", rate: 1.0, pitch: 1.08 };
export const AEDES_VOICE = { name: "browser-aedes", rate: 0.9, pitch: 0.94 };
export const GEMINI_VOICE = { name: "gemini", rate: 1, pitch: 0 };
export const GEMINI_TIMBRES = [
  { id: "Aoede", label: "Aoede — féminine chaleureuse", gender: "female" },
  { id: "Kore", label: "Kore — féminine assurée", gender: "female" },
  { id: "Leda", label: "Leda — féminine jeune", gender: "female" },
  { id: "Charon", label: "Charon — masculine posée", gender: "male" },
  { id: "Orus", label: "Orus — masculine ferme", gender: "male" },
  { id: "Puck", label: "Puck — masculine enjouée", gender: "male" },
];
const DEFAULT_GEMINI_TIMBRE = { female: "Aoede", male: "Charon" };
// Le timbre Gemini suit le genre de la voix choisie, sinon toutes les voix sortaient en Aoede (féminine).
export const geminiTimbreFor = (cfg, gender) => {
  if (!gender && cfg?.name === GEMINI_VOICE.name) {
    return GEMINI_TIMBRES.some((item) => item.id === cfg.geminiVoice) ? cfg.geminiVoice : DEFAULT_GEMINI_TIMBRE.female;
  }
  const resolved = gender || (isBrowserVoice(cfg?.name) ? getBrowserGender(cfg.name) : FEMALE.test(cfg?.name || "") ? "female" : "male");
  return DEFAULT_GEMINI_TIMBRE[resolved];
};
const LEGACY_DEFAULT_VOICE = { name: "fr-FR-Neural2-G", rate: 1.05, pitch: -2 };
const isBrowserVoice = (name) => name === "browser" || name === "browser-female" || name === AEDES_VOICE.name;
const getBrowserGender = (name) => name === "browser-female" ? "female" : "male";

export const loadVoiceConfig = () => {
  try {
    const saved = JSON.parse(localStorage.getItem("sirius_voice")) || null;
    const isLegacyDefault = saved
      && saved.name === LEGACY_DEFAULT_VOICE.name
      && saved.rate === LEGACY_DEFAULT_VOICE.rate
      && saved.pitch === LEGACY_DEFAULT_VOICE.pitch;
    if (!saved || isLegacyDefault) {
      localStorage.setItem("sirius_voice", JSON.stringify(DEFAULT_VOICE));
      return { ...DEFAULT_VOICE };
    }
    return { ...DEFAULT_VOICE, ...saved };
  }
  catch (e) { return { ...DEFAULT_VOICE }; }
};

export async function playAudio(base64, { volume = 1, onstart, onend } = {}) {
  if (!base64) return false;
  try {
    const audio = new Audio("data:audio/mp3;base64," + base64);
    const disconnect = await connectVoiceEqualizer(audio);
    audio.volume = Math.max(0.2, Math.min(1, volume));
    if (onstart) audio.onplay = onstart;
    audio.onended = () => { disconnect(); if (onend) onend(); };
    audio.onerror = () => {
      disconnect();
      if (onend) onend();
      return false;
    };
    try { await audio.play(); } catch (error) { disconnect(); throw error; }
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

export const GEMINI_TTS_TIMEOUT_MS = 28000;
const isGeminiRoute = (voice) => voice === GEMINI_VOICE.name || Capacitor.getPlatform() === "android";
const remoteTimeoutMs = (gemini) => (gemini ? GEMINI_TTS_TIMEOUT_MS : TTS_REQUEST_TIMEOUT_MS);
const remoteDown = (gemini) => Date.now() < (gemini ? geminiDownUntil : googleDownUntil);
const remoteError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// Requête unique de synthèse distante : rend l'audio ou lève une erreur typée (http, empty, réseau/abandon).
async function requestRemoteAudio(message, { gemini, voice, geminiVoice, rate, pitch }, signal) {
  const keys = loadApiKeys();
  const voiceKeys = gemini ? { gemini_tts: keys.gemini_tts || "", google_tts: keys.google_tts || "" }
    : { google_tts: keys.google_tts || "" };
  const personalKeys = Object.fromEntries(Object.entries(voiceKeys).filter(([, value]) => value));
  const r = await fetch(`${API}/tts/${gemini ? "gemini" : "google"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(gemini
      ? { text: phonetic(message), keys: personalKeys, ...(geminiVoice ? { voice: geminiVoice } : {}) }
      : { text: phonetic(message), voice, rate, pitch, keys: personalKeys }),
    credentials: "include",
    signal,
  });
  if (!r.ok) {
    if (r.status === 503) {
      if (gemini) geminiDownUntil = Date.now() + 60000;
      else googleDownUntil = Date.now() + 600000;
    }
    throw remoteError("http", `Synthèse distante indisponible (HTTP ${r.status}).`, { status: r.status });
  }
  const d = await r.json();
  const base64 = d.audio_base64 || d.audio;
  if (!base64) throw remoteError("empty", gemini ? "Réponse Gemini sans audio" : "Réponse vocale sans audio");
  return { base64, mime: gemini ? "audio/wav" : "audio/mp3" };
}

// Lecture d'un audio distant déjà reçu. Résultat : ended, failed (avant le son), cut (coupé après
// le début), stopped (une autre voix a coupé les canaux) ou stale (voix périmée avant lecture).
async function playRemoteAudio({ base64, mime }, {
  volume = 1, playbackRate = 1, onstart, onend, onprogress, gemini, endOnCut = true, report = true,
}, seq) {
  const audio = new Audio(`data:${mime};base64,` + base64);
  const disconnect = await connectVoiceEqualizer(audio);
  if (seq !== speakSeq) { disconnect(); return "stale"; }
  return new Promise((resolve) => {
    stopChannels();
    audio.volume = Math.max(0.2, Math.min(1, volume));
    audio.playbackRate = playbackRate;
    audio.preservesPitch = true;
    currentAudio = audio;
    let started = false;
    let finished = false;
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      disconnect();
      audio.onplay = null;
      audio.onended = null;
      audio.onerror = null;
      audio.ontimeupdate = null;
      if (currentAudio === audio) currentAudio = null;
      if (finishCurrentAudio === stop) finishCurrentAudio = null;
      resolve(outcome);
    };
    const stop = () => finish("stopped");
    finishCurrentAudio = stop;
    audio.onplay = () => {
      started = true;
      if (seq !== speakSeq) return;
      if (onstart) onstart();
      if (onprogress) onprogress(0);
    };
    audio.ontimeupdate = () => {
      if (started && seq === speakSeq && onprogress && Number.isFinite(audio.duration) && audio.duration > 0) {
        onprogress(Math.min(1, audio.currentTime / audio.duration));
      }
    };
    audio.onended = () => {
      finish("ended");
      if (seq === speakSeq && onend) onend();
    };
    audio.onerror = () => {
      if (gemini && report && seq === speakSeq) reportGeminiFailure("lecture audio");
      finish(started ? "cut" : "failed");
      if (endOnCut && started && seq === speakSeq && onend) onend();
    };
    audio.play().catch((error) => {
      if (finished) return;
      if (gemini && report && seq === speakSeq) reportGeminiFailure(error.name);
      finish("failed");
    });
  });
}

async function speakRemote(message, { voice, geminiVoice, rate, pitch, volume = 1, onstart, onend, onprogress, timeoutMs, playbackRate = 1 }, seq) {
  const gemini = isGeminiRoute(voice);
  if (remoteDown(gemini)) return false;
  const controller = new AbortController();
  currentRequest = controller;
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs ?? remoteTimeoutMs(gemini));
  let data;
  try {
    data = await requestRemoteAudio(message, { gemini, voice, geminiVoice, rate, pitch }, controller.signal);
  } catch (e) {
    if (seq !== speakSeq) return true;
    if (e.code === "http") {
      if (gemini) reportGeminiFailure(e.status);
      return false;
    }
    if (e.code === "empty" && !gemini) return false;
    console.warn("Synthèse vocale distante : lecture indisponible.", e);
    if (gemini) reportGeminiFailure(e.name);
    return false;
  } finally {
    window.clearTimeout(timeout);
    if (currentRequest === controller) currentRequest = null;
  }
  // Une voix plus récente a pris la parole pendant le chargement → on se tait (pas d'écho)
  if (seq !== speakSeq) return true;
  try {
    const outcome = await playRemoteAudio(data, { volume, playbackRate, onstart, onend, onprogress, gemini }, seq);
    return outcome !== "failed";
  } catch (e) {
    if (seq !== speakSeq) return true;
    console.warn("Synthèse vocale distante : lecture indisponible.", e);
    if (gemini) reportGeminiFailure(e.name);
    return false;
  }
}

// ---- Synthèse du navigateur (fallback gratuit) ----
function speakBrowser(message, { rate = 1.0, pitch = 1.08, volume = 1, gender = "female", onstart, onend, onerror, onprogress } = {}) {
  const seq = speakSeq;
  if (Capacitor.getPlatform() === "android") {
    stopChannels();
    void speakNative(phonetic(message), { rate, pitch, volume, gender, onstart, onend, onerror, onprogress });
    return;
  }
  const synth = window.speechSynthesis;
  const end = onend || (() => {});
  // onerror distingue un échec d'une fin normale ; onend reste appelé pour les appelants historiques.
  const fail = (error) => { if (onerror) onerror(error); end(); };
  if (!synth || !message) { fail(new Error("Synthèse locale indisponible.")); return; }
  const doSpeak = () => {
    if (seq !== speakSeq) return;
    try {
      stopChannels();
      synth.resume();
      const voices = synth.getVoices() || [];
      const chosen = selectFrenchVoice(voices, { gender, localOnly: true });
      if (!chosen) {
        window.dispatchEvent(new CustomEvent("sirius-voice-error", {
          detail: "Voix française locale indisponible. Installez une voix française dans les paramètres de synthèse vocale.",
        }));
        fail(new Error("Voix française locale indisponible."));
        return;
      }
      const u = new SpeechSynthesisUtterance(phonetic(message));
      u.lang = chosen.lang;
      u.rate = rate;
      u.pitch = pitch;
      u.volume = Math.max(0.2, Math.min(1, volume));
      u.voice = chosen;
      // Contournement bug Chrome : la synthèse se coupe après ~15 s sans resume()
      let keepAlive = null;
      const clearKA = () => { if (keepAlive) { clearInterval(keepAlive); keepAlive = null; } };
      u.onstart = () => {
        if (seq !== speakSeq) return;
        keepAlive = setInterval(() => { try { synth.resume(); } catch (e) {} }, 10000);
        if (onstart) onstart();
      };
      u.onend = () => { clearKA(); if (seq === speakSeq) end(); };
      u.onboundary = (event) => {
        if (seq === speakSeq && onprogress && u.text.length > 0) {
          onprogress(Math.min(1, (event.charIndex + (event.charLength || 0)) / u.text.length));
        }
      };
      u.onerror = (event) => { clearKA(); if (seq === speakSeq) fail(event); };
      synth.speak(u);
    } catch (e) { fail(e); }
  };
  if (selectFrenchVoice(synth.getVoices(), { gender, localOnly: true })) {
    doSpeak();
    return;
  }
  let timer;
  const cleanup = () => {
    clearTimeout(timer);
    synth.removeEventListener?.("voiceschanged", ready);
    if (cancelVoiceDiscovery === cleanup) cancelVoiceDiscovery = null;
  };
  const ready = () => {
    if (!selectFrenchVoice(synth.getVoices(), { gender, localOnly: true })) return;
    cleanup();
    doSpeak();
  };
  cancelVoiceDiscovery = cleanup;
  synth.addEventListener?.("voiceschanged", ready);
  timer = setTimeout(() => { cleanup(); doSpeak(); }, 1500);
  ready();
}

// Voix feutrée nocturne : entre 22 h et 5 h, ΣIRIUS parle plus lentement, plus grave et plus doucement
const isNight = () => { const h = new Date().getHours(); return h >= 22 || h < 5; };

function speechCallbacks(seq, onstart, onend) {
  const publish = publishPhase;
  publish("preparing");
  return {
    onstart: () => {
      if (seq !== speakSeq) return;
      publish("speaking");
      if (onstart) onstart();
    },
    onend: () => {
      if (seq !== speakSeq) return;
      publish("idle");
      if (onend) onend();
    },
  };
}

// Réglages d'une prise de parole « assistant » : partagés par speakFr et la lecture en série du bulletin,
// pour que la voix, le genre et le débit choisis restent identiques quel que soit le chemin.
function speechParams(raw, cfg) {
  const urgent = isUrgent(raw); // détecté avant nettoyage (les « ! » comptent)
  const message = cleanTextForSpeech(raw);
  const night = isNight();
  let rate = Math.max(0.5, Math.min(2, urgent ? cfg.rate + 0.13 : cfg.rate));
  if (night) rate = Math.max(0.5, rate * 0.87);
  const volume = night ? 0.72 : 1;
  const browserVoice = isBrowserVoice(cfg.name);
  const fem = FEMALE.test(cfg.name);
  const browserPitch = (browserVoice ? cfg.pitch : (fem ? 1.12 : (urgent ? 0.92 : 0.85))) * (night ? 0.95 : 1);
  const gender = browserVoice ? getBrowserGender(cfg.name) : (fem ? "female" : "male");
  let remote = null;
  if (!browserVoice && (Capacitor.getPlatform() === "android" || cfg.name === GEMINI_VOICE.name)) {
    remote = {
      voice: cfg.name === GEMINI_VOICE.name ? GEMINI_VOICE.name : "fr-FR-Neural2-G",
      geminiVoice: geminiTimbreFor(cfg),
      rate,
      pitch: night ? -4.5 : -3,
    };
  } else if (!browserVoice) {
    remote = { voice: cfg.name, rate, pitch: night ? cfg.pitch - 1.5 : cfg.pitch };
  }
  return { message, rate, volume, browserPitch, gender, remote };
}

// Nouvelle prise de parole : invalide les voix en cours et interrompt une lecture en série active.
// replaced=false signale un simple arrêt (cancelSpeech) plutôt qu'une nouvelle voix.
function claimSpeech(replaced = true) {
  speakSeq += 1;
  if (activeSequence && activeSequence.seq !== speakSeq) activeSequence.interrupt(replaced);
  return speakSeq;
}
const publishPhase = (phase) => window.dispatchEvent(new CustomEvent("sirius-voice-phase", { detail: phase }));

export function speakFr(message, { onpending, onstart, onend } = {}) {
  if (!message) { (onend || (() => {}))(); return; }
  const cfg = loadVoiceConfig();
  const params = speechParams(message, cfg);
  if (!params.message) { (onend || (() => {}))(); return; }
  const { rate, volume, browserPitch, gender, remote } = params;
  message = params.message;
  const seq = claimSpeech(); utterances += 1; lastUtteranceAt = Date.now();
  stopChannels();
  ({ onstart, onend } = speechCallbacks(seq, onstart, onend));
  if (onpending) onpending();
  if (!remote) {
    speakBrowser(message, { rate, pitch: browserPitch, volume, gender, onstart, onend });
    return;
  }
  speakRemote(message, { ...remote, volume, onstart, onend }, seq).then((ok) => {
    if (!ok && seq === speakSeq) speakBrowser(message, { rate, pitch: browserPitch, volume, gender, onstart, onend });
  });
}

// Coupe immédiatement la voix de Sirius (interruption naturelle)
export function cancelSpeech() {
  claimSpeech(false); // invalide aussi les voix distantes en chargement et la lecture en série active
  seriesId += 1; // interrompt la file de lecture progressive
  seriesChain = Promise.resolve();
  stopChannels();
  publishPhase("idle");
}

// ---- Lecture progressive : les phrases s'enchaînent dans l'ordre, sans se couper ----
// Contrat historique (réponses en flux, lecture du Display) : la promesse se résout toujours,
// y compris après le garde de 30 s. Le bulletin, qui doit savoir ce qui a vraiment été lu,
// utilise speakSequence, qui rejette au lieu de simuler une fin.
export const SERIES_START_GUARD_MS = 30000;
export const playbackBudgetMs = (text) => Math.max(10000, (String(text || "").length / 8) * 1000 + 5000);
let seriesChain = Promise.resolve();
let seriesId = 0;

export function speakSeries(sentence, opts = {}) {
  const phrase = (sentence || "").trim();
  if (!phrase) return seriesChain;
  const id = seriesId;
  seriesChain = seriesChain.then(() => {
    if (id !== seriesId) return undefined; // série interrompue entre-temps
    return new Promise((resolve) => {
      let ended = false;
      let seq;
      const finish = () => {
        if (ended) return;
        ended = true;
        clearTimeout(guard);
        if (opts.onend) opts.onend();
        resolve();
      };
      const expire = () => {
        if (seq === speakSeq) cancelSpeech();
        finish();
      };
      let guard = setTimeout(expire, SERIES_START_GUARD_MS);
      speakFr(phrase, {
        onstart: () => {
          clearTimeout(guard);
          guard = setTimeout(expire, playbackBudgetMs(phrase));
          if (opts.onstart) opts.onstart();
        },
        onend: finish,
      });
      seq = speakSeq;
    });
  });
  return seriesChain;
}

// ---- Lecture en série fiable (bulletin d'actualités) ----
// Une seule prise de parole pour toute la série :
// - fournisseur stable : voix distante tant qu'elle répond, puis voix locale jusqu'à la fin de la série
//   dès le premier échec (délai, réseau, HTTP, audio vide, lecture), sans nouvelle tentative distante ;
// - préchargement borné : l'audio de la phrase suivante est demandé pendant la lecture de la phrase
//   en cours (une seule requête en vol) et annulé en cas d'arrêt ou de bascule ;
// - aucune fin simulée : onitemend n'est appelé qu'après une lecture réellement terminée ; un échec
//   de la voix locale ou un dépassement de délai rejette `done` avec une SpeechSequenceError ;
// - toute nouvelle voix (speakFr, cancelSpeech, autre série…) interrompt la série (code « cancelled »).
export const SEQUENCE_START_TIMEOUT_MS = 10000;

export class SpeechSequenceError extends Error {
  constructor(code, index, message, cause) {
    super(message);
    this.name = "SpeechSequenceError";
    this.code = code;
    this.index = index;
    if (cause !== undefined) this.cause = cause;
  }
}

export function speakSequence(phrases, { onitemstart, onitemend, onprovider } = {}) {
  const texts = Array.from(phrases || [], (phrase) => String(phrase ?? ""));
  const cfg = loadVoiceConfig();
  const cache = [];
  const paramsAt = (index) => {
    if (!cache[index]) cache[index] = speechParams(texts[index], cfg);
    return cache[index];
  };
  const routed = !isBrowserVoice(cfg.name);
  const gemini = routed && (Capacitor.getPlatform() === "android" || cfg.name === GEMINI_VOICE.name);
  let provider = routed && !remoteDown(gemini) ? "remote" : "local";

  seriesId += 1; // une série plus ancienne ne doit pas reprendre la parole ensuite
  seriesChain = Promise.resolve();
  const seq = claimSpeech(); utterances += 1; lastUtteranceAt = Date.now();
  stopChannels();
  publishPhase("preparing");

  let closed = false;
  let currentIndex = 0;
  let interruptReject;
  const interrupted = new Promise((_, reject) => { interruptReject = reject; });
  interrupted.catch(() => {});
  const controllers = new Set();
  const prefetched = new Map();
  const abortRequests = () => {
    for (const controller of controllers) controller.abort();
    controllers.clear();
    prefetched.clear();
  };
  const close = () => {
    closed = true;
    abortRequests();
    if (activeSequence === session) activeSequence = null;
  };
  const session = {
    seq,
    interrupt: (replaced = true) => {
      if (closed) return;
      close();
      const error = new SpeechSequenceError("cancelled", currentIndex, "Lecture interrompue.");
      error.replaced = replaced;
      interruptReject(error);
    },
  };
  activeSequence = session;
  const guard = (promise) => Promise.race([promise, interrupted]);
  const itemStarted = (index) => {
    if (closed) return;
    publishPhase("speaking");
    if (onitemstart) onitemstart(index);
  };

  const requestItem = (index) => {
    const params = paramsAt(index);
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, remoteTimeoutMs(gemini));
    const request = requestRemoteAudio(params.message, { gemini, ...params.remote }, controller.signal)
      .catch((error) => {
        if (timedOut) throw new SpeechSequenceError("timeout", index, "Synthèse distante trop lente.", error);
        if (error?.code) throw new SpeechSequenceError(error.code, index, error.message, error);
        throw new SpeechSequenceError("transport", index, "Synthèse distante injoignable.", error);
      })
      .finally(() => {
        window.clearTimeout(timer);
        controllers.delete(controller);
      });
    request.catch(() => {});
    return request;
  };
  const audioFor = (index) => {
    const request = prefetched.get(index) || requestItem(index);
    prefetched.delete(index);
    return request;
  };
  const prefetch = (index) => {
    if (closed || provider !== "remote" || index >= texts.length || prefetched.has(index)) return;
    if (!paramsAt(index).message) return;
    prefetched.set(index, requestItem(index));
  };
  const degrade = (reason) => {
    provider = "local";
    abortRequests();
    console.warn("Lecture en série : bascule sur la voix locale jusqu'à la fin.", reason);
    if (gemini) reportGeminiFailure(reason.code || reason.name);
    if (onprovider) onprovider("local", reason);
  };

  // Rend null si la phrase a été entièrement lue, sinon l'erreur qui impose la voix locale.
  const playRemoteItem = async (index) => {
    const params = paramsAt(index);
    let data;
    try {
      data = await guard(audioFor(index));
    } catch (error) {
      if (closed) throw error;
      return error;
    }
    prefetch(index + 1);
    let stalled = null;
    let watchdog = null;
    const arm = (ms, code) => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        stalled = code;
        if (seq === speakSeq) stopChannels();
      }, ms);
    };
    arm(SEQUENCE_START_TIMEOUT_MS, "start-timeout");
    let outcome;
    try {
      outcome = await guard(playRemoteAudio(data, {
        volume: params.volume,
        gemini,
        report: false,
        endOnCut: false,
        onstart: () => {
          if (closed || stalled) return;
          arm(playbackBudgetMs(params.message), "playback-timeout");
          itemStarted(index);
        },
      }, seq));
    } catch (error) {
      if (closed) throw error;
      return new SpeechSequenceError("playback", index, "Lecture audio impossible.", error);
    } finally {
      window.clearTimeout(watchdog);
    }
    if (outcome === "ended") return null;
    if (stalled) return new SpeechSequenceError(stalled, index, "Lecture audio bloquée.");
    if (closed || outcome === "stopped" || outcome === "stale") {
      session.interrupt();
      throw new SpeechSequenceError("cancelled", index, "Lecture interrompue.");
    }
    return new SpeechSequenceError(outcome === "cut" ? "playback-cut" : "playback", index, "Lecture audio interrompue.");
  };

  const playLocalItem = (index) => new Promise((resolve, reject) => {
    const params = paramsAt(index);
    let started = false;
    let settled = false;
    let timer = null;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const expire = (code) => () => {
      if (seq === speakSeq) stopChannels();
      settle(new SpeechSequenceError(code, index, "La voix locale ne répond pas."));
    };
    timer = window.setTimeout(expire("local-timeout"), SEQUENCE_START_TIMEOUT_MS);
    speakBrowser(params.message, {
      rate: params.rate,
      pitch: params.browserPitch,
      volume: params.volume,
      gender: params.gender,
      onstart: () => {
        if (closed || settled) return;
        started = true;
        window.clearTimeout(timer);
        timer = window.setTimeout(expire("local-timeout"), playbackBudgetMs(params.message));
        itemStarted(index);
      },
      onerror: (cause) => settle(new SpeechSequenceError("local-error", index, "Voix locale indisponible.", cause)),
      onend: () => settle(started ? null : new SpeechSequenceError("local-error", index, "Voix locale indisponible.")),
    });
  });

  const run = async () => {
    if (onprovider) onprovider(provider);
    for (let index = 0; index < texts.length; index += 1) {
      currentIndex = index;
      if (closed) throw new SpeechSequenceError("cancelled", index, "Lecture interrompue.");
      if (!paramsAt(index).message) {
        itemStarted(index);
        if (!closed && onitemend) onitemend(index);
        continue;
      }
      if (provider === "remote") {
        const failure = await playRemoteItem(index);
        if (!failure) {
          if (!closed && onitemend) onitemend(index);
          continue;
        }
        degrade(failure);
      }
      await guard(playLocalItem(index));
      if (!closed && onitemend) onitemend(index);
    }
  };

  const done = run().then(() => {
    const owned = !closed && seq === speakSeq;
    close();
    if (owned) publishPhase("idle");
  }, (error) => {
    const owned = !closed && seq === speakSeq;
    close();
    if (owned) {
      stopChannels();
      publishPhase("idle");
    }
    throw error instanceof SpeechSequenceError ? error
      : new SpeechSequenceError("internal", currentIndex, "Lecture en série interrompue.", error);
  });
  return {
    done,
    get provider() { return provider; },
    cancel: () => {
      if (closed) return;
      if (seq === speakSeq) cancelSpeech();
      else session.interrupt();
    },
  };
}

// Le boot peut conserver un timbre naturel sans changer les autres présentations.
export function speakCinematic(message, { onstart, onend, onprogress, natural = false } = {}) {
  if (!message) { (onend || (() => {}))(); return; }
  message = cleanTextForSpeech(message);
  if (!message) { (onend || (() => {}))(); return; }
  const cfg = loadVoiceConfig();
  const rate = natural ? 0.96 : 0.85;
  const browserPitch = natural ? 1 : 0.95;
  const seq = claimSpeech(); utterances += 1; lastUtteranceAt = Date.now();
  stopChannels();
  ({ onstart, onend } = speechCallbacks(seq, onstart, onend));
  if (isBrowserVoice(cfg.name)) {
    speakBrowser(message, { rate, pitch: browserPitch, gender: getBrowserGender(cfg.name), onstart, onend, onprogress });
    return;
  }
  if (Capacitor.getPlatform() === "android" || cfg.name === GEMINI_VOICE.name) {
    speakRemote(message, {
      voice: cfg.name === GEMINI_VOICE.name ? GEMINI_VOICE.name : "fr-FR-Neural2-G",
      geminiVoice: geminiTimbreFor(cfg),
      rate,
      pitch: natural ? 0 : -3,
      playbackRate: natural ? 1.06 : 1,
      onstart,
      onend,
      onprogress,
      timeoutMs: 6000,
    }, seq).then((ok) => {
      if (!ok && seq === speakSeq) {
        speakBrowser(message, { rate, pitch: browserPitch, gender: FEMALE.test(cfg.name) ? "female" : "male", onstart, onend, onprogress });
      }
    });
    return;
  }
  speakRemote(message, { voice: cfg.name, rate, pitch: natural ? cfg.pitch : Math.max(-10, cfg.pitch - 3), onstart, onend, onprogress }, seq).then((ok) => {
    if (!ok && seq === speakSeq) speakBrowser(message, { rate, pitch: natural ? 1 : 0.62, onstart, onend, onprogress });
  });
}

// Profils de voix Mythos — masculins graves (M1/M2), féminins clairs (F1/F2)
// M = formant bas + gravité positive ; F = formant haut + gravité négative. Jamais de mélange.
export const MYTHOS_VOICES = {
  M1: { gender: "male", google: "fr-FR-Neural2-G", gPitch: -6, bPitch: 0.6, rate: 0.9 },   // masculine profonde — narration, autorité
  M2: { gender: "male", google: "fr-FR-Neural2-G", gPitch: -2, bPitch: 0.78, rate: 1.0 },  // masculine naturelle — dialogues
  F1: { gender: "female", google: "fr-FR-Neural2-F", gPitch: 2, bPitch: 1.15, rate: 1.05 }, // féminine premium — précise
  F2: { gender: "female", google: "fr-FR-Neural2-F", gPitch: -1, bPitch: 1.3, rate: 0.95 },  // féminine douce — posée
};

// Profils par défaut des personnages du Panthéon (modifiables par personnage dans la configuration VOIX)
export const CHAR_PROFILES = {
  "ARGUS#": "M1", "LOCUS#": "M2", "ORACLE#": "F2", "PANTHÉON#": "M1", "HERACLES#": "M1",
  "ΣIRIUS CORTEX#": "F1", "HÉPHAÏSTOS#": "M1", "ATLAS#": "M1", "ΣIRIUS DISPLAY#": "F1",
  "THÉMIS#": "F1", "SOLON#": "M2", "PROMÉTHÉE#": "M2", "HERMÈS AGORA#": "M2", "CALLIOPE#": "F2",
  "PYTHAGORE#": "M1", "ASCLÉPIOS#": "M2",
};

export function loadCharOverrides() {
  try { return JSON.parse(localStorage.getItem("sirius_char_voices")) || {}; } catch (e) { return {}; }
}

const _gToB = (g) => Math.max(0.4, Math.min(1.8, 1 + g / 15));

// Voix distincte par personnage du Panthéon : profil Mythos (M1/M2/F1/F2) ou hauteur/débit hérités
export function speakAsCharacter(message, { profile, module, pitch = 1, rate = 1, onstart, onend } = {}) {
  if (!message) { (onend || (() => {}))(); return; }
  const safeText = cleanTextForSpeech(message);
  if (!safeText) { (onend || (() => {}))(); return; }
  const cfg = loadVoiceConfig();
  const prof = profile || (module && CHAR_PROFILES[module]);
  const p = prof && MYTHOS_VOICES[prof];
  const seq = claimSpeech(); utterances += 1; lastUtteranceAt = Date.now();
  stopChannels();
  ({ onstart, onend } = speechCallbacks(seq, onstart, onend));
  if (isBrowserVoice(cfg.name)) {
    const ov = (module && loadCharOverrides()[module]) || {};
    speakBrowser(safeText, {
      rate: p ? (ov.rate ?? p.rate) : Math.max(0.55, Math.min(1.6, rate)),
      pitch: p ? (ov.gPitch != null ? _gToB(ov.gPitch) : p.bPitch) : Math.max(0.4, Math.min(1.8, pitch)),
      gender: p?.gender || getBrowserGender(cfg.name), onstart, onend,
    });
    return;
  }
  if (Capacitor.getPlatform() === "android") {
    speakRemote(safeText, { geminiVoice: geminiTimbreFor(cfg, p?.gender), rate: 1.05, pitch: 0, onstart, onend }, seq).then((ok) => {
      if (!ok && seq === speakSeq) {
        const ov = (module && loadCharOverrides()[module]) || {};
        speakBrowser(safeText, {
          rate: p ? (ov.rate ?? p.rate) : Math.max(0.55, Math.min(1.6, rate)),
          pitch: p ? (ov.gPitch != null ? _gToB(ov.gPitch) : p.bPitch) : Math.max(0.4, Math.min(1.8, pitch)),
          gender: p?.gender || (FEMALE.test(cfg.name) ? "female" : "male"), onstart, onend,
        });
      }
    });
    return;
  }
  if (p) {
    const ov = (module && loadCharOverrides()[module]) || {};
    const gPitch = ov.gPitch ?? p.gPitch;
    const vRate = ov.rate ?? p.rate;
    const bPitch = ov.gPitch != null ? _gToB(ov.gPitch) : p.bPitch;
    speakRemote(safeText, { voice: p.google, rate: vRate, pitch: gPitch, onstart, onend }, seq).then((ok) => {
      if (!ok && seq === speakSeq) speakBrowser(safeText, { rate: vRate, pitch: bPitch, gender: p.gender, onstart, onend });
    });
    return;
  }
  const bp = Math.max(0.4, Math.min(1.8, pitch));
  const br = Math.max(0.55, Math.min(1.6, rate));
  const gPitch = Math.max(-14, Math.min(14, Math.round((pitch - 0.9) * 13)));
  speakRemote(safeText, { voice: cfg.name, rate: br, pitch: gPitch, onstart, onend }, seq).then((ok) => {
    if (!ok && seq === speakSeq) speakBrowser(safeText, { rate: br, pitch: bp, onstart, onend });
  });
}
// Alias d'exportation pour assurer la compatibilité avec App.js
export const speakOut = speakFr;