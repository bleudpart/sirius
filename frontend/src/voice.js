// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
// Voix de Sirius — synthèse locale ou Google Cloud TTS avec basculement
// automatique sur la synthèse du navigateur si la clé est absente ou l'API indisponible.
import { Capacitor } from "@capacitor/core";
import { applyFrenchPhonetics } from "./phoneticFr";
import { speakNative, stopNativeSpeech } from "./nativeVoice";
import { API_BASE_URL } from "./lib/api";

const API = API_BASE_URL;
const TTS_REQUEST_TIMEOUT_MS = 8000;
const MALE = /(paul|henri|thomas|nicolas|claude|mathieu|guillaume|daniel|jerome|male|homme|man|wavenet-d|wavenet-b|standard-b|standard-d)/i;
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
  return String(t || "")
    // « ΣIRIUS » : la synthèse lit le sigma grec (« sigma irius ») ; le nom se prononce « Sirius ».
    .replace(/Σ\s?IRIUS/gi, "Sirius")
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
    .replace(/[\u2010\u2011\u2012]/g, "-")       // tirets Unicode (insécables) → tiret simple
    // Élision mal orthographiée par le LLM : « dites-m-en » → « dites-m'en » (sinon « m » se lit « meu »).
    .replace(/-([mtl])-(en|y)\b/gi, "-$1'$2")
    .replace(/[—–]/g, ", ")                      // tirets longs → pause naturelle
    .replace(/\s-{2,}\s/g, ", ")                 // -- ou --- entre mots
    .replace(/(\d)\s*-\s*(\d)/g, "$1 à $2")       // plage numérique 10-15 → « 10 à 15 » (pas « moins »)
    .replace(/\b(qu|[cdjlmnst])\s*['’]\s*(?=[aeiouyàâäéèêëîïôöùûü])/giu, "$1'")
    // Seuls les tirets ISOLÉS deviennent des espaces. Un tiret entre deux lettres soude un mot
    // (« dites-m'en », « peut-être », « e-mail ») : le couper fait lire « m » comme « meu ».
    .replace(/(?<!\p{L})-|-(?!\p{L})/gu, " ")
    .replace(/[()\[\]{}<>]/g, "")    // supprime parenthèses / crochets / accolades / chevrons
    .replace(/\/+/g, " ")            // supprime barres
    .replace(/[ \t]+/g, " ")         // normalise espaces (garde les fins de phrase)
    .trim();
}

// Ton adapté à l'urgence : plus rapide et tendu si le message est urgent
const isUrgent = (text) => /!|\b(urgent|vite|attention|alerte|imm[ée]diatement|danger|grave)\b/i.test(text);

// ---- Google Cloud TTS (via backend, clé jamais exposée) ----
let currentAudio = null;
let finishCurrentAudio = null;
let currentRequest = null;
let googleDownUntil = 0; // clé absente / API en panne → on évite de retenter pendant 10 min
let geminiDownUntil = 0;
let speakSeq = 0; // n° de la dernière prise de parole — garantit UNE SEULE voix à la fois
let utterances = 0; // nombre de prises de parole lancées (l'annulation ne compte pas)
let lastUtteranceAt = 0;
export const spokenCount = () => utterances;
export const lastSpokenAt = () => lastUtteranceAt;

// Coupe TOUS les canaux audio (synthèse navigateur + audio Google) avant chaque nouvelle voix
function stopChannels() {
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
    detail: "Voix Gemini indisponible ; utilisation de la voix Android de secours.",
  }));
}

// Préférences de voix (écran Profil) : voix, débit, gravité
export const DEFAULT_VOICE = { name: "browser-female", rate: 1.0, pitch: 1.08 };
const LEGACY_DEFAULT_VOICE = { name: "fr-FR-Neural2-G", rate: 1.05, pitch: -2 };
const isBrowserVoice = (name) => name === "browser" || name === "browser-female";
const getBrowserGender = (name) => name === "browser" ? "male" : "female";

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
    audio.volume = Math.max(0.2, Math.min(1, volume));
    if (onstart) audio.onplay = onstart;
    if (onend) audio.onended = onend;
    audio.onerror = () => {
      if (onend) onend();
      return false;
    };
    await audio.play();
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

async function speakRemote(message, { voice, rate, pitch, volume = 1, onstart, onend, timeoutMs }, seq) {
  const gemini = Capacitor.getPlatform() === "android";
  if (Date.now() < (gemini ? geminiDownUntil : googleDownUntil)) return false;
  const controller = new AbortController();
  currentRequest = controller;
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs ?? (gemini ? 28000 : TTS_REQUEST_TIMEOUT_MS));
  try {
    const r = await fetch(`${API}/tts/${gemini ? "gemini" : "google"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gemini
        ? { text: phonetic(message) }
        : { text: phonetic(message), voice, rate, pitch }),
      credentials: "include",
      signal: controller.signal,
    });
    if (seq !== speakSeq) return true;
    if (!r.ok) {
      if (r.status === 503) {
        if (gemini) geminiDownUntil = Date.now() + 60000;
        else googleDownUntil = Date.now() + 600000;
      }
      if (gemini) {
        reportGeminiFailure(r.status);
      }
      return false;
    }
    const d = await r.json();
    window.clearTimeout(timeout);
    const audioBase64 = d.audio_base64 || d.audio;
    if (!audioBase64) {
      if (gemini) throw new Error("Réponse Gemini sans audio");
      return false;
    }
    // Une voix plus récente a pris la parole pendant le chargement → on se tait (pas d'écho)
    if (seq !== undefined && seq !== speakSeq) return true;
    if (currentRequest === controller) currentRequest = null;
    return await new Promise((resolve) => {
      stopChannels();
      const audio = new Audio(`data:${gemini ? "audio/wav" : "audio/mp3"};base64,` + audioBase64);
      audio.volume = Math.max(0.2, Math.min(1, volume));
      currentAudio = audio;
      let started = false;
      let finished = false;
      const finish = (ok) => {
        if (finished) return;
        finished = true;
        audio.onplay = null;
        audio.onended = null;
        audio.onerror = null;
        if (currentAudio === audio) currentAudio = null;
        if (finishCurrentAudio === finish) finishCurrentAudio = null;
        resolve(ok);
      };
      finishCurrentAudio = finish;
      audio.onplay = () => { started = true; if (seq === speakSeq && onstart) onstart(); };
      audio.onended = () => {
        finish(true);
        if (seq === speakSeq && onend) onend();
      };
      audio.onerror = () => {
        if (gemini && seq === speakSeq) reportGeminiFailure("lecture audio");
        finish(started);
        if (started && seq === speakSeq && onend) onend();
      };
      audio.play().catch((error) => {
        if (finished) return;
        if (gemini && seq === speakSeq) reportGeminiFailure(error.name);
        finish(false);
      });
    });
  } catch (e) {
    if (seq !== speakSeq) return true;
    if (gemini) reportGeminiFailure(e.name);
    return false;
  } finally {
    window.clearTimeout(timeout);
    if (currentRequest === controller) currentRequest = null;
  }
}

// ---- Synthèse du navigateur (fallback gratuit) ----
function speakBrowser(message, { rate = 1.0, pitch = 1.08, volume = 1, gender = "female", onstart, onend } = {}) {
  const seq = speakSeq;
  if (Capacitor.getPlatform() === "android") {
    stopChannels();
    void speakNative(phonetic(message), { rate, pitch, volume, onstart, onend });
    return;
  }
  const synth = window.speechSynthesis;
  const end = onend || (() => {});
  if (!synth || !message) { end(); return; }
  const doSpeak = () => {
    if (seq !== speakSeq) return;
    try {
      stopChannels();
      synth.resume();
      const u = new SpeechSynthesisUtterance(phonetic(message));
      u.lang = "fr-FR";
      u.rate = rate;
      u.pitch = pitch;
      u.volume = Math.max(0.2, Math.min(1, volume));
      const voices = synth.getVoices() || [];
      const fr = voices.filter((v) => /fr/i.test(v.lang));
      const chosen = gender === "female"
        ? (fr.find((v) => FEMALE.test(v.name)) || fr.find((v) => !MALE.test(v.name)) || fr[0] || voices[0] || null)
        : (fr.find((v) => MALE.test(v.name)) || fr.find((v) => !FEMALE.test(v.name)) || fr[0] || voices[0] || null);
      if (chosen) u.voice = chosen;
      // Contournement bug Chrome : la synthèse se coupe après ~15 s sans resume()
      let keepAlive = null;
      const clearKA = () => { if (keepAlive) { clearInterval(keepAlive); keepAlive = null; } };
      u.onstart = () => {
        if (seq !== speakSeq) return;
        keepAlive = setInterval(() => { try { synth.resume(); } catch (e) {} }, 10000);
        if (onstart) onstart();
      };
      u.onend = () => { clearKA(); if (seq === speakSeq) end(); };
      u.onerror = () => { clearKA(); if (seq === speakSeq) end(); };
      synth.speak(u);
    } catch (e) { end(); }
  };
  (synth.getVoices() || []).length === 0 ? setTimeout(doSpeak, 200) : doSpeak();
}

// Voix feutrée nocturne : entre 22 h et 5 h, ΣIRIUS parle plus lentement, plus grave et plus doucement
const isNight = () => { const h = new Date().getHours(); return h >= 22 || h < 5; };

function speechCallbacks(seq, onstart, onend) {
  const publish = (phase) => window.dispatchEvent(new CustomEvent("sirius-voice-phase", { detail: phase }));
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

export function speakFr(message, { onpending, onstart, onend } = {}) {
  if (!message) { (onend || (() => {}))(); return; }
  const urgent = isUrgent(message); // détecté avant nettoyage (les « ! » comptent)
  message = cleanTextForSpeech(message);
  if (!message) { (onend || (() => {}))(); return; }
  const cfg = loadVoiceConfig();
  const night = isNight();
  let rate = Math.max(0.5, Math.min(2, urgent ? cfg.rate + 0.13 : cfg.rate));
  if (night) rate = Math.max(0.5, rate * 0.87);
  const volume = night ? 0.72 : 1;
  const seq = ++speakSeq; utterances += 1; lastUtteranceAt = Date.now();
  stopChannels();
  ({ onstart, onend } = speechCallbacks(seq, onstart, onend));
  if (onpending) onpending();
  const fem = FEMALE.test(cfg.name);
  const bPitch = (fem ? 1.12 : (urgent ? 0.92 : 0.85)) * (night ? 0.95 : 1);
  if (Capacitor.getPlatform() === "android") {
    speakRemote(message, {
      voice: "fr-FR-Neural2-G",
      rate,
      pitch: night ? -4.5 : -3,
      volume,
      onstart,
      onend,
    }, seq).then((ok) => {
      if (!ok && seq === speakSeq) {
        speakBrowser(message, { rate: 1.05, pitch: 1, volume, gender: "female", onstart, onend });
      }
    });
    return;
  }
  if (isBrowserVoice(cfg.name)) {
    speakBrowser(message, { rate, pitch: bPitch, volume, gender: getBrowserGender(cfg.name), onstart, onend });
    return;
  }
  speakRemote(message, { voice: cfg.name, rate, pitch: night ? cfg.pitch - 1.5 : cfg.pitch, volume, onstart, onend }, seq).then((ok) => {
    if (!ok && seq === speakSeq) speakBrowser(message, { rate, pitch: bPitch, volume, gender: fem ? "female" : "male", onstart, onend });
  });
}

// Coupe immédiatement la voix de Sirius (interruption naturelle)
export function cancelSpeech() {
  speakSeq += 1; // invalide aussi les voix Google encore en chargement
  seriesId += 1; // interrompt la file de lecture progressive
  seriesChain = Promise.resolve();
  stopChannels();
}

// ---- Lecture progressive : les phrases s'enchaînent dans l'ordre, sans se couper ----
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
      let guard = setTimeout(expire, 30000);
      speakFr(phrase, {
        onstart: () => {
          clearTimeout(guard);
          guard = setTimeout(expire, Math.max(10000, (phrase.length / 8) * 1000 + 5000));
          if (opts.onstart) opts.onstart();
        },
        onend: finish,
      });
      seq = speakSeq;
    });
  });
  return seriesChain;
}

// Présentation au démarrage : voix grave et posée, style bande-annonce de film
export function speakCinematic(message, { onstart, onend } = {}) {
  if (!message) { (onend || (() => {}))(); return; }
  message = cleanTextForSpeech(message);
  if (!message) { (onend || (() => {}))(); return; }
  const cfg = loadVoiceConfig();
  const seq = ++speakSeq; utterances += 1; lastUtteranceAt = Date.now();
  stopChannels();
  ({ onstart, onend } = speechCallbacks(seq, onstart, onend));
  if (Capacitor.getPlatform() === "android") {
    speakRemote(message, {
      voice: "fr-FR-Neural2-G",
      rate: 0.85,
      pitch: -3,
      onstart,
      onend,
      timeoutMs: 6000,
    }, seq).then((ok) => {
      if (!ok && seq === speakSeq) {
        speakBrowser(message, { rate: 1.05, pitch: 1, gender: "female", onstart, onend });
      }
    });
    return;
  }
  if (isBrowserVoice(cfg.name)) {
    speakBrowser(message, { rate: 0.85, pitch: 0.95, gender: getBrowserGender(cfg.name), onstart, onend });
    return;
  }
  speakRemote(message, { voice: cfg.name, rate: 0.85, pitch: Math.max(-10, cfg.pitch - 3), onstart, onend }, seq).then((ok) => {
    if (!ok && seq === speakSeq) speakBrowser(message, { rate: 0.85, pitch: 0.62, onstart, onend });
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
  const seq = ++speakSeq; utterances += 1; lastUtteranceAt = Date.now();
  stopChannels();
  ({ onstart, onend } = speechCallbacks(seq, onstart, onend));
  if (Capacitor.getPlatform() === "android") {
    speakRemote(safeText, { rate: 1.05, pitch: 0, onstart, onend }, seq).then((ok) => {
      if (!ok && seq === speakSeq) {
        speakBrowser(safeText, { rate: 1.05, pitch: 1, onstart, onend });
      }
    });
    return;
  }
  if (p) {
    const ov = (module && loadCharOverrides()[module]) || {};
    const gPitch = ov.gPitch ?? p.gPitch;
    const vRate = ov.rate ?? p.rate;
    const bPitch = ov.gPitch != null ? _gToB(ov.gPitch) : p.bPitch;
    if (isBrowserVoice(cfg.name)) {
      speakBrowser(safeText, { rate: vRate, pitch: bPitch, gender: p.gender, onstart, onend });
      return;
    }
    speakRemote(safeText, { voice: p.google, rate: vRate, pitch: gPitch, onstart, onend }, seq).then((ok) => {
      if (!ok && seq === speakSeq) speakBrowser(safeText, { rate: vRate, pitch: bPitch, gender: p.gender, onstart, onend });
    });
    return;
  }
  const bp = Math.max(0.4, Math.min(1.8, pitch));
  const br = Math.max(0.55, Math.min(1.6, rate));
  if (isBrowserVoice(cfg.name)) {
    speakBrowser(safeText, { rate: br, pitch: bp, gender: getBrowserGender(cfg.name), onstart, onend });
    return;
  }
  const gPitch = Math.max(-14, Math.min(14, Math.round((pitch - 0.9) * 13)));
  speakRemote(safeText, { voice: cfg.name, rate: br, pitch: gPitch, onstart, onend }, seq).then((ok) => {
    if (!ok && seq === speakSeq) speakBrowser(safeText, { rate: br, pitch: bp, onstart, onend });
  });
}
// Alias d'exportation pour assurer la compatibilité avec App.js
export const speakOut = speakFr;