const STOP_WORDS = new Set([
  "dans", "sur", "avec", "pour", "ouvre", "ouvrir", "affiche", "afficher",
  "montre", "montrer", "lance", "lancer", "module", "modules", "fenetre",
  "panneau", "hud", "display", "ecran", "le", "la", "les", "l", "un", "une",
  "mon", "ma", "mes", "moi", "de", "du", "des", "m", "me",
]);

export const MODULE_ALIASES = {
  nummarius: "bourse marches finances actions cryptos portus",
  cortex: "zeus cerveau intelligence centrale",
  themis: "facturation factures devis clients stocks comptabilite",
  admin: "administration comptes utilisateurs",
  gcal: "calendrier agenda google rendez vous",
  display: "ecran display affichage",
  oracle: "oracle previsions",
  memorymgr: "souvenirs memoire",
  faceid: "visage reconnaissance faciale prise de vue faciale capture visage camera faciale webcam faciale photo faciale biometric biometrique",
  files: "fichiers documents mediathèque",
  haccp: "hygiene alimentaire securite sanitaire",
  connections: "comptes connectes connexion",
  mythos: "galerie personnages dieux pantheon",
  argus: "surveillance systeme moniteur",
  atlas: "cartes navigation itineraire",
  heracles: "enquete investigation osint",
  hephaistos: "diagnostic maintenance technique",
  locus: "localisation position geolocalisation",
  promethee: "projet taches planning",
  workflows: "ariane orchestration parcours etapes actions",
  pricing: "plutos tarifs prix fournisseurs comparaison",
  dossiers: "mnemosyne dossiers archives clients",
  audit: "nemesis tracabilite historique modifications",
  documents: "thot lecture classement documents texte",
  planning: "chronos echeances calendrier taches",
  calliope: "bibliotheque audio sons musique",
  pythagore: "mathematiques geometrie calcul",
  solon: "juridique droit conseil",
  agora: "vente commercial pipeline prospects",
  keraunos: "domotique maison objets connectes",
  europeana: "archives musees culture",
  analytics: "statistiques tableaux bord",
  productivity: "travail productivite documents code notes",
  photo3d: "photographie objet modele trois dimensions",
  reveil: "alarme briefing matin",
  packager: "installateur package livrable",
};

export const normalizeModuleText = (value) => String(value || "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

export function parseModuleOpenCommand(raw) {
  let query = normalizeModuleText(raw)
    .replace(/^(?:(?:ouvre|ouvrir|affiche|afficher|montre|montrer|lance|lancer|deploie|presenter|presente)(?:\s+moi)?\s+)+/, "")
    .replace(/^(?:(?:le|la|les|mon|ma|mes|un|une|module|fenetre|panneau)\s+)+/, "")
    .trim();
  const displayTarget = /\b(?:dans|sur)\s+(?:le\s+)?(?:display|ecran)\b/.test(query);
  const hudTarget = /\b(?:dans|sur)\s+(?:le\s+)?hud\b/.test(query);
  query = query.replace(/\b(?:dans|sur)\s+(?:le\s+)?(?:hud|display|ecran)\b/g, " ").trim();
  return { query, target: displayTarget ? "display" : hudTarget ? "hud" : "auto" };
}

export function findModuleForCommand(raw, items, aliases = {}) {
  const { query, target } = parseModuleOpenCommand(raw);
  if (!query) return { item: null, target };
  const tokens = query.split(/\s+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  if (!tokens.length) return { item: null, target };
  const singleTermPriority = { camera: "vision", webcam: "vision", photo: "photo3d" };
  if (tokens.length === 1 && singleTermPriority[query]) {
    const preferred = (items || []).find((item) => item.id === singleTermPriority[query]);
    if (preferred) return { item: preferred, target };
  }

  const ranked = (items || []).map((item) => {
    const haystack = normalizeModuleText(`${item.label || ""} ${item.id || ""} ${aliases[item.id] || ""}`);
    const phraseMatch = haystack.includes(query);
    const matchedTokens = tokens.filter((token) => haystack.includes(token)).length;
    return { item, score: phraseMatch ? tokens.length + 2 : matchedTokens, complete: matchedTokens === tokens.length };
  }).filter((candidate) => candidate.complete)
    .sort((left, right) => right.score - left.score);

  return { item: ranked[0]?.item || null, target };
}

export function dockTitleMatchesModule(title, item, aliases = {}) {
  const dockTokens = normalizeModuleText(title).split(/\s+/).filter((token) => token.length > 2);
  const moduleTokens = new Set(normalizeModuleText(`${item?.label || ""} ${item?.id || ""} ${aliases[item?.id] || ""}`).split(/\s+/));
  return dockTokens.length > 0 && dockTokens.every((token) => moduleTokens.has(token));
}

export function executeModuleOpen(raw, items, aliases, dockPills, runModule) {
  const { item } = findModuleForCommand(raw, items, aliases);
  if (!item) return null;
  const pill = [...(dockPills || [])].find((element) => (
    dockTitleMatchesModule(element.querySelector(".hdp-label")?.textContent || element.textContent, item, aliases)
  ));
  if (pill) pill.click();
  runModule(item);
  return item;
}