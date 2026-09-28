// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Lexique phonétique français pour la synthèse vocale.
//
// Pourquoi pas CMUdict ni Lexique 3 : CMUdict est anglophone (ARPAbet) et Lexique 3 pèse
// plusieurs mégaoctets pour transcrire du français qu'un moteur TTS français lit déjà bien.
// Les seules erreurs réelles viennent des sigles, des anglicismes et des noms propres : on
// les corrige par une ré-écriture graphique, qui fonctionne aussi bien sur Google TTS que
// sur la synthèse du navigateur (laquelle n'accepte pas le SSML).

// Sigles à épeler : le moteur les lit comme un mot unique s'ils sont prononçables.
export const FR_ACRONYMS = {
  HACCP: "ache a cé cé pé",
  DLC: "dé èl cé",
  DLUO: "dé èl u o",
  RGPD: "èrre gé pé dé",
  PDF: "pé dé èf",
  API: "a pé i",
  URL: "u èrre èl",
  CRM: "cé èrre èm",
  ERP: "eu èrre pé",
  SAV: "èss a vé",
  PME: "pé èm eu",
  TVA: "té vé a",
  SIRET: "siret",
  OSINT: "o-ssinnte",
  MFA: "èm èf a",
  TOTP: "té o té pé",
};

// Anglicismes que la voix française lit à l'anglaise.
export const FR_ANGLICISMS = {
  scan: "skane",
  scans: "skane",
  scanne: "skane",
  scannes: "skane",
  backup: "bak-eupe",
  backups: "bak-eupe",
  dashboard: "dachbord",
  workflow: "work-flo",
  template: "tempss-plète",
  templates: "tempss-plète",
  login: "logg-ine",
  planning: "plani-ngue",
  meeting: "mi-tingue",
  reporting: "ripor-tingue",
};

// Noms propres et vocabulaire ΣIRIUS.
export const FR_NAMES = {
  Roger: "Rojé",
  Sirius: "Siriusse",
  cortex: "cortèxe",
  Keraunos: "Kéraunoss",
  Heracles: "Éraclèss",
  Hephaistos: "Éfaïstoss",
  Nummarius: "Noummariuss",
  Argus: "Argusse",
  Mythos: "Mitoss",
  Locus: "Locusse",
  Atlas: "Atlass",
  Solon: "Solone",
  Themis: "Témisse",
};

// Règles contextuelles qui ne se réduisent pas à un mot isolé.
const FR_RULES = [
  [/\bS\.I\.R\.I\.U\.S\b/gi, "Siriusse"],
  // « e-mail » devient « e mail » au nettoyage, que le TTS français lit « eu mail ».
  [/\be[- ]?mails\b/gi, "imèls"],
  [/\be[- ]?mail\b/gi, "imèl"],
  // Prénoms étrangers : le « ee » final se lit « é » en français alors qu'il se dit « i ».
  [/(\p{Lu}\p{L}*?)ee\b/gu, "$1i"],
];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Les bornes \b ignorent les lettres accentuées : on délimite sur les caractères de mot Unicode.
const wordBoundary = (word) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`, "giu");

const BUILTIN_ENTRIES = Object.entries({ ...FR_ACRONYMS, ...FR_ANGLICISMS, ...FR_NAMES })
  // Les entrées les plus longues d'abord : « scannes » ne doit pas être coupé par « scanne ».
  .sort((a, b) => b[0].length - a[0].length)
  .map(([mot, dit]) => [wordBoundary(mot), dit]);

export const readUserLexicon = () => {
  try {
    const dict = JSON.parse(localStorage.getItem("sirius_phonetic"));
    return Array.isArray(dict) ? dict.filter((e) => e && e.mot && e.dit) : [];
  } catch (e) {
    return [];
  }
};

// Le dictionnaire de l'utilisateur passe en premier : il doit pouvoir écraser le lexique intégré.
export const applyFrenchPhonetics = (input) => {
  let out = String(input ?? "");
  readUserLexicon().forEach(({ mot, dit }) => { out = out.replace(wordBoundary(mot), dit); });
  BUILTIN_ENTRIES.forEach(([re, dit]) => { out = out.replace(re, dit); });
  FR_RULES.forEach(([re, dit]) => { out = out.replace(re, dit); });
  return out;
};
