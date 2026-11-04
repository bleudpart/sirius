const STOP_WORDS = new Set([
  "dans", "sur", "avec", "pour", "ouvre", "ouvrir", "affiche", "afficher",
  "montre", "montrer", "lance", "lancer", "module", "modules", "fenetre",
  "panneau", "hud", "display", "ecran", "le", "la", "les", "l", "un", "une",
  "mon", "ma", "mes", "moi", "de", "du", "des", "m", "me",
]);

export const MODULE_ALIASES = {
  "workspace-search": "recherche transversale recherche universelle chercher partout",
  privacy: "confidentialite donnees personnelles vie privee",
  plans: "architecture interieur amenagement decoration habitat plan de maison",
  "voice-profile": "ma voix diction profil vocal ma prononciation mes extraits vocaux configurer ma voix enregistrer ma voix",
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
  haccp: "hygiene alimentaire securite sanitaire duerp document unique evaluation risques professionnels cahier personnel formations securite incendie exercices evacuation verifications",
  connections: "comptes connectes connexion",
  messaging: "messagerie boite reception courriels gmail outlook",
  mythos: "galerie personnages dieux pantheon",
  argus: "surveillance systeme moniteur",
  atlas: "cartes navigation itineraire",
  heracles: "enquete investigation osint domaine analyse ce domaine",
  cartographie: "osiris carte cartes carte des evenements evenements proches seismes catastrophes naturelles alertes",
  hephaistos: "diagnostic maintenance technique",
  locus: "localisation position geolocalisation",
  promethee: "projet taches planning",
  workflows: "ariane orchestration parcours etapes actions multi agent sous agents delegation equipe ia",
  "native-automation": "automatisation windows hooks natifs raccourci global dossier surveille",
  pricing: "plutos tarifs prix fournisseurs comparaison",
  dossiers: "mnemosyne dossiers archives clients",
  "dossiers-pro": "dossiers intelligents propositions priorites travail journee sirius",
  "sport-coach": "asclepios sport bien etre fitness entrainement musculation prise de masse coach sportif seance",
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
  reveil: "alarme reveil matin",
  packager: "installateur package livrable",
};

export const normalizeModuleText = (value) => String(value || "")
  .toLowerCase()
  .replace(/[σς]/g, "s")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const MODULE_OPEN_PREFIX = /^(?:ouvre|ouvrir|affiche|afficher|montre|montrer|lance|lancer|deploie|deployer|presente|presenter|restaure|restaurer|rouvre|rouvrir|voir|consulter)(?:\s+moi)?\s+/;
const MODULE_DETERMINERS = /^(?:(?:le|la|les|l|mon|ma|mes|ton|ta|tes|un|une)\s+)+/;
const MODULE_DESTINATION = /\s+(?:dans|sur)\s+(?:(?:le|la|l|mon|ton)\s+)?(?:(?:sirius|zirius)\s+)?(hud|display|ecran)$/;

function normalizeModuleRequest(raw) {
  return normalizeModuleText(raw)
    .replace(/^(?:sirius|zirius)\s+/, "")
    .replace(/^s il te plait\s+|\s+s il te plait$/g, "")
    .replace(/^(?:(?:est ce que\s+)?tu (?:peux|pourrais)|peux tu|pourrais tu|je veux|je voudrais|j aimerais|je souhaite|je te demande de)\s+(?:(?:m|me)\s+)?/, "");
}

export function moduleDisplayName(item) {
  const names = { plans: "PLANS", photo3d: "PHOTO3D" };
  return names[item.id] || String(item.label || item.id).split("—")[0].replace(/#/g, "").trim();
}

export function parseModuleOpenCommand(raw) {
  let query = normalizeModuleRequest(raw).replace(MODULE_OPEN_PREFIX, "")
    .replace(MODULE_DETERMINERS, "")
    .replace(/^(?:module|fenetre|panneau)\s+/, "")
    .replace(MODULE_DETERMINERS, "")
    .trim();
  const destination = query.match(MODULE_DESTINATION)?.[1];
  query = query.replace(MODULE_DESTINATION, "").trim();
  return { query, target: destination === "hud" ? "hud" : destination ? "display" : "auto" };
}

export function parseModuleOpenRequest(raw) {
  const normalized = normalizeModuleRequest(raw);
  if (!MODULE_OPEN_PREFIX.test(normalized)) return null;
  const subject = normalized.replace(MODULE_OPEN_PREFIX, "").replace(MODULE_DETERMINERS, "");
  return { ...parseModuleOpenCommand(raw), explicit: /^(?:module|fenetre|panneau)\b/.test(subject) };
}

export function isCartographieOpenCommand(raw) {
  const { query } = parseModuleOpenCommand(raw);
  return /^(?:osiris*(?:\s+(?:cartes?|cartographie))?|cartes?(?:\s+(?:de|d))?\s+osiris*|cartographie(?:\s+(?:(?:de|d)\s+)?osiris*)?|carte des evenements|evenements proches)$/.test(query);
}

export function findModuleForCommand(raw, items, aliases = {}) {
  const { query, target } = parseModuleOpenCommand(raw);
  if (!query) return { item: null, target };
  if (isCartographieOpenCommand(raw)) {
    const cartographie = (items || []).find((item) => item.id === "cartographie");
    if (cartographie) return { item: cartographie, target };
  }
  const exactItem = (items || []).find((item) => normalizeModuleText(item.id) === query);
  if (exactItem) return { item: exactItem, target };
  const singleTermPriority = { camera: "vision", webcam: "vision", photo: "photo3d", ecran: "display" };
  if (singleTermPriority[query]) {
    const preferred = (items || []).find((item) => item.id === singleTermPriority[query]);
    if (preferred) return { item: preferred, target };
  }
  const tokens = query.split(/\s+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  if (!tokens.length) return { item: null, target };

  const ranked = (items || []).map((item) => {
    const haystack = normalizeModuleText(`${item.label || ""} ${item.id || ""} ${aliases[item.id] || ""}`);
    const phraseMatch = haystack.includes(query);
    const matchedTokens = tokens.filter((token) => haystack.includes(token)).length;
    return { item, score: phraseMatch ? tokens.length + 2 : matchedTokens, complete: matchedTokens === tokens.length };
  }).filter((candidate) => candidate.complete)
    .sort((left, right) => right.score - left.score);

  return { item: ranked[0]?.item || null, target };
}

export function isNamedModuleOpenRequest(raw, items, aliases = {}) {
  const request = parseModuleOpenRequest(raw);
  if (!request) return false;
  if (request.explicit) return true;
  const { item } = findModuleForCommand(raw, items, aliases);
  if (!item) return false;
  const name = normalizeModuleText(moduleDisplayName(item));
  return isCartographieOpenCommand(raw) || name === request.query || name.split(/\s+/).includes(request.query);
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