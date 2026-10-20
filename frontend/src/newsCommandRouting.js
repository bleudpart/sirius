const normalize = (command) => String(command || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const GENERAL_WORDS = new Set((
  "sirius syrius cirius sirus peux pourrais tu vous pouvez me moi nous donne donner donnez dis dire "
  + "montre montrer affiche afficher annonce annoncer anonce lis lire presente presenter resume resumer fais faire recherche cherche approfondie approfondis sur web internet "
  + "quelles quels sont les des le la l un une info infos information informations actu actus actualite actualites "
  + "news nouvelles bulletin bulletins panorama journal journaux titres breves general generale generales du jour aujourd hui d de ce matin "
  + "recentes derniers dernieres principales toutes tous complet completes en france francaise francaises "
  + "international internationale internationales monde dans a et stp s il te plait "
  + "bonjour salut hey euh bon alors allez vas y ok je j aimerais voudrais veux souhaites souhaite "
  + "pourrais pourriez peut on avoir savoir connaitre entendre ecouter raconte raconter parle parler "
  + "balance envoie lance lancer maintenant peu petit rapide rapidement point tour horizon fait faire "
  + "tenir tiens courant au quoi comme as avez bonjour merci plutot seulement juste uniquement"
).split(/\s+/));

const scopeOf = (words) => {
  const france = words.some((word) => ["france", "francaise", "francaises"].includes(word));
  const world = words.some((word) => ["monde", "international", "internationale", "internationales"].includes(word));
  return france && !world ? "france" : world && !france ? "international" : "all";
};

export function newsBulletinScope(command) {
  const normalized = normalize(command)
    .replace(/\b(?:qu est ce qui se passe|ce qui se passe|que se passe t il|qu est ce qu il se passe|quoi de neuf|quoi de nouveau|comment va le monde|on en est ou dans le monde)\b/g, "actualites");
  const words = normalized.split(/\s+/);
  if (!words.some((word) => /^(?:infos?|informations?|actualites?|actus?|news|nouvelles|bulletins?|panorama|journal|journaux|titres|breves)$/.test(word))) return null;
  if (words.some((word) => !GENERAL_WORDS.has(word))) return null;
  return scopeOf(words);
}

export function newsRetryScope(command, previousScope) {
  if (!["all", "france", "international"].includes(previousScope)) return null;
  const normalized = normalize(command).replace(/^(?:sirius|syrius|cirius|sirus)\s+/, "");
  if (/^(?:non\s+)?(?:(?:essaie|essaye|reessaie|reessaye|plutot|en|recommence|reprends)\s+)?(?:en\s+)?generale?$/.test(normalized)) return "all";
  if (/^(?:en france|france|international|internationale|a l international|dans le monde)$/.test(normalized)) {
    return scopeOf(normalized.split(/\s+/));
  }
  if (/^(?:et|mais|plutot|seulement|uniquement)(?: juste)? (?:en france|la france|dans le monde|a l international|l international|en france et dans le monde)$/.test(normalized)) {
    return scopeOf(normalized.split(/\s+/));
  }
  if (/^(?:non\s+)?(?:recommence|reessaie|reessaye|essaie|essaye|refais)(?: (?:encore|le bulletin|les infos|les actus))?(?: stp| s il te plait)?$/.test(normalized)) return previousScope;
  return null;
}
