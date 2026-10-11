import { voiceProfileAccount } from "./voiceProfileStore";

export const VOICE_VOCABULARY_EVENT = "sirius-voice-vocabulary-changed";
const key = (account) => `sirius-voice-vocabulary-v1:${account}`;

export function validateVoiceVocabulary(input) {
  if (!Array.isArray(input) || input.length > 32) throw new Error("32 expressions maximum.");
  const terms = [];
  for (const value of input) {
    if (typeof value !== "string" || /[\r\n\t\p{Cc}\p{Cf}]/u.test(value)) throw new Error("Expression invalide.");
    const text = value.normalize("NFC").trim();
    if (!text || text.length > 80 || !/^[\p{L}\p{N} '’.-]+$/u.test(text)) {
      throw new Error("Chaque expression : 1 à 80 caractères, lettres, chiffres, espaces, apostrophes, points ou tirets uniquement.");
    }
    if (!terms.some((term) => term.toLowerCase() === text.toLowerCase())) terms.push(text);
  }
  if (terms.reduce((total, term) => total + term.length, 0) > 1600) throw new Error("1 600 caractères maximum au total.");
  return terms;
}

export function readVoiceVocabulary(account) {
  if (!account) return { enabled: false, terms: [] };
  try {
    const value = JSON.parse(localStorage.getItem(key(account)));
    return { enabled: value?.enabled === true, terms: validateVoiceVocabulary(value?.terms || []) };
  } catch { return { enabled: false, terms: [] }; }
}

export function saveVoiceVocabulary(account, value) {
  if (!account) throw new Error("Compte vocal non défini.");
  const next = { enabled: value.enabled === true, terms: validateVoiceVocabulary(value.terms) };
  localStorage.setItem(key(account), JSON.stringify(next));
  window.dispatchEvent(new Event(VOICE_VOCABULARY_EVENT));
  return next;
}

export function clearVoiceVocabulary(account) {
  localStorage.removeItem(key(account));
  window.dispatchEvent(new Event(VOICE_VOCABULARY_EVENT));
}

export function enabledVoiceVocabulary(user) {
  let account;
  try { account = voiceProfileAccount(user); } catch { return []; }
  const profile = readVoiceVocabulary(account);
  return profile.enabled ? profile.terms : [];
}
