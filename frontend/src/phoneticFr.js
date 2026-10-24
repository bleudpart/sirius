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
  DLC: "dé elle cé",
  DLUO: "dé elle u o",
  RGPD: "erre gé pé dé",
  PDF: "pé dé effe",
  API: "a pé i",
  HUD: "ache u dé",
  URL: "u erre elle",
  CRM: "cé erre emme",
  ERP: "eu erre pé",
  SAV: "esse a vé",
  PME: "pé emme eu",
  TVA: "té vé a",
  SIRET: "siret",
  OSINT: "o-ssinnte",
  MFA: "emme effe a",
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
  planning: "planigne",
  meeting: "mi-tingue",
  reporting: "ripor-tingue",
};

// Noms propres et vocabulaire ΣIRIUS.
export const FR_NAMES = {
  "Sirius Display": "Siriusse displé",
  "Zirius Display": "Siriusse displé",
  Roger: "Rojé",
  Sirius: "Siriusse",
  "Panthéon": "pantéon",
  Pantheon: "pantéon",
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
  Plutos: "Ploutoss",
  "Face ID": "feïss aï di",
  FaceID: "feïss aï di",
  "Face-ID": "feïss aï di",
  // Sans entrée, le moteur lit le X final comme « exe ».
  SpaceX: "Spéïss-ex",
  "Space X": "Spéïss-ex",
  "Space-X": "Spéïss-ex",
};

// Noms hispaniques en -ez : sans entrée, « Marquez » est lu comme le verbe (« marqué »).
// Sensibles à la casse pour ne pas toucher « vous marquez des points ».
export const FR_CASED_NAMES = {
  Marquez: "Markèss",
  Márquez: "Markèss",
  Fernandez: "Fernandèss",
  Fernández: "Fernandèss",
  Perez: "Pérèss",
  Pérez: "Pérèss",
  Hernandez: "Ernandèss",
  Hernández: "Ernandèss",
  Rodriguez: "Rodriguèss",
  Rodríguez: "Rodriguèss",
  Lopez: "Lopèss",
  López: "Lopèss",
  Gonzalez: "Gonnzalèss",
  González: "Gonnzalèss",
  Sanchez: "Sanntchèss",
  Sánchez: "Sanntchèss",
  Martinez: "Martinèss",
  Martínez: "Martinèss",
  Alvarez: "Alvarèss",
  Álvarez: "Alvarèss",
  Gutierrez: "Goutiérèss",
  Gutiérrez: "Goutiérèss",
  Dominguez: "Dominguèss",
  Domínguez: "Dominguèss",
};

// Règles contextuelles qui ne se réduisent pas à un mot isolé.
const FR_RULES = [
  [/(?<![\p{L}\p{N}_])jusqu[\s\u200b\u200c\u200d\u2060\ufeff]*['’‘ʼ＇][\s\u200b\u200c\u200d\u2060\ufeff]*à(?![\p{L}\p{N}_])/giu, "juska"],
  [/\bS\.I\.R\.I\.U\.S\b/gi, "Siriusse"],
  // Le mot français évite l'épellation de l'anglicisme par certains moteurs.
  [/(?<![\p{L}\p{N}_@.+-])(?:e[-\u2010\u2011 ]?)?mails(?![\p{L}\p{N}_@+-]|\.\p{L})/giu, "courriels"],
  [/(?<![\p{L}\p{N}_@.+-])(?:e[-\u2010\u2011 ]?)?mail(?![\p{L}\p{N}_@+-]|\.\p{L})/giu, "courriel"],
  // Prénoms étrangers : le « ee » final se lit « é » en français alors qu'il se dit « i ».
  [/(\p{Lu}\p{L}*?)ee\b/gu, "$1i"],
  // Adjectif « content » : les moteurs le lisent comme le verbe « ils content » (« conte »).
  // Le verbe est conservé après ils/elles/qui, avec un éventuel pronom complément.
  [/(?<!(?:^|[^\p{L}])(?:ils|elles|qui)\s+(?:(?:leur|lui|nous|vous|en|y|me|te|se|le|la|les)\s+)?)(?<![\p{L}\p{N}_])(m[ée]c|C|c)ontent(s?)(?![\p{L}\p{N}_])/giu,
    (_, start, plural) => `${start}ontant${plural}`],
];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Les bornes \b ignorent les lettres accentuées : on délimite sur les caractères de mot Unicode.
const wordBoundary = (word) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`, "giu");

const BUILTIN_ENTRIES = Object.entries({ ...FR_ACRONYMS, ...FR_ANGLICISMS, ...FR_NAMES })
  // Les entrées les plus longues d'abord : « scannes » ne doit pas être coupé par « scanne ».
  .sort((a, b) => b[0].length - a[0].length)
  .map(([mot, dit]) => [wordBoundary(mot), dit])
  .concat(Object.entries(FR_CASED_NAMES).map(([mot, dit]) => [
    new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(mot)}(?![\\p{L}\\p{N}_])`, "gu"), dit,
  ]));

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

export const normalizeFrenchElisions = (input) => String(input ?? "")
  .replace(/[\u2010\u2011\u2012]/g, "-")
  .replace(/[\u200b\u200c\u200d\u2060\ufeff]*-[\u200b\u200c\u200d\u2060\ufeff]*/g, "-")
  .replace(/\b(jusqu|qu|[cdjlmnst])[\s\u200b\u200c\u200d\u2060\ufeff]*['’‘ʼ＇][\s\u200b\u200c\u200d\u2060\ufeff]*(?=\p{L})/giu, "$1'")
  .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, " ");
