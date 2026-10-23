export const BULLETIN_CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;

const NO_RECENT = "Je n'ai pas de bulletin récent à rappeler. Demande-moi les infos du jour.";
const STOPWORDS = new Set([
  "pourquoi", "comment", "quelle", "quelles", "quels", "est-ce", "explique", "expliquer", "precise", "detaille",
  "details", "precisions", "developpe", "donne", "donner", "veut", "signifie", "temps", "cette", "depuis", "alors",
  "ensuite", "avait", "avoir", "etait", "faire", "parle", "parler", "aujourd", "contre", "autre", "autres",
]);

const normalize = (command) => String(command || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[’'`]/g, " ").replace(/-/g, " ").toLowerCase().replace(/\s+/g, " ").trim()
  .replace(/^(?:(?:dis |ok |euh |hey )?(?:sirius|syrius|cirius|sirus)\b[ ,]*)/, "").replace(/[ ?.!,;:]+$/, "");

const WEATHER_RECALL = /(?:quel(?:le)? temps|quelle meteo|la meteo|temperature|previsions?).*(?:tu (?:m )?(?:as|a|avais|viens de) (?:dit|dis|annonce)|t as (?:dit|dis|annonce)|annoncee?s?|de tout a l heure)|^c etait quoi (?:la meteo|le temps|les previsions)|^(?:repete|redis|rappelle|redonne)(?: moi)? (?:la meteo|le temps|la temperature|les previsions)/;
const NEWS_RECALL = /^(?:(?:repete|redis|rappelle|redonne)(?: moi)? )?qui a fait quoi$|^(?:repete|redis|rappelle|redonne)(?: moi)? (?:la derniere |cette |l |le dernier |ce )(?:info|information|actu|actualite|nouvelle|titre)$/;
const GENERIC_REPEAT = /^(?:tu peux (?:me )?(?:le )?repeter|peux tu (?:le )?repeter|(?:repete|redis)(?: moi)?(?: (?:ce que tu (?:as|a|viens de) dit|ca|encore|stp|s il te plait))*)$/;
const EXPLICIT_RESUME = /^(?:reprends|reprend|continue|poursuis|termine)(?: (?:le bulletin|les infos|les informations|les actualites|les actus|la lecture des infos))(?: (?:stp|s il te plait))?$/;
const GENERIC_RESUME = /^(?:(?:vas y )?(?:reprends|reprend|continue|poursuis)(?: (?:ou tu en etais|la lecture|stp|s il te plait))?|la suite|et ensuite|suite)$/;
const NEXT_ITEM = /^(?:(?:passe|passer|va)(?: au| a la| a l)? )?(?:(?:le |la |l )?(?:titre|info|information|actualite|article) suivant(?:e)?|suivant(?:e)?)(?: du bulletin)?$/;
const PREVIOUS_ITEM = /^(?:(?:reviens|revient|retourne|va)(?: au| a la| a l)? )?(?:(?:le |la |l )?(?:titre|info|information|actualite|article) precedent(?:e)?|precedent(?:e)?)(?: du bulletin)?$/;
const NUMBERED_ITEM = /^(?:(?:lis|relis|reprends|developpe|detaille|explique)(?: moi)? )?(?:le )?(?:titre|article|info|information)(?: numero)? (\d+)(?: du bulletin)?$/;
const QUESTION = /^(?:pourquoi|comment|qui|quoi|quel|quelle|quels|quelles|que|qu |est ce|c est|ca veut dire|explique|developpe|precise|detaille|donne(?: moi)? (?:plus de )?(?:details|precisions)|plus de (?:details|precisions)|et (?:pourquoi|alors|ensuite|qui|comment|apres)|il |elle |ils |elles |on )/;
const IMPERSONAL = /\b(?:est|fait|faut|reste|va|semble|pleut|y a t|a t) il\b/g;
const DEICTIC = /\b(?:il|elle|ils|elles|lui|ca|cela|ce|cet|cette|ces|celui|celle|la dessus|ce sujet|l article|le passage|tu (?:as|a|viens de) (?:dit|parle|annonce|evoque)|tu parlais)\b/;

export function createBulletinContext({ scope = "all", segments, now = Date.now() }) {
  return { savedAt: now, scope, segments, activeIndex: -1, completedIndex: -1, resumeIndex: 0, announcedIndices: [], focused: true, resumable: true };
}

export function prepareBulletinReading(bulletin, index) {
  bulletin.resumeIndex = index;
  bulletin.focused = true;
  bulletin.resumable = true;
}

export function markSegmentStarted(bulletin, index) {
  prepareBulletinReading(bulletin, index);
  bulletin.activeIndex = index;
  if (bulletin.announcedIndices && !bulletin.announcedIndices.includes(index)) bulletin.announcedIndices.push(index);
}

export function markSegmentCompleted(bulletin, index) {
  if (bulletin.activeIndex === index) {
    bulletin.completedIndex = Math.max(bulletin.completedIndex, index);
    bulletin.resumeIndex = index + 1;
  }
}

// Une autre conversation reprend la main : « répète » ou « continue » ne visent plus le bulletin.
export function releaseBulletinFocus(bulletin) {
  if (!bulletin) return;
  bulletin.focused = false;
  bulletin.resumable = false;
}

export function isBulletinFresh(bulletin, now = Date.now()) {
  return Boolean(bulletin?.segments?.length) && now - bulletin.savedAt <= BULLETIN_CONTEXT_TTL_MS;
}

const announced = (bulletin) => bulletin.announcedIndices
  ? bulletin.announcedIndices.map((index) => bulletin.segments[index])
  : bulletin.segments.slice(0, bulletin.activeIndex + 1);
const resumePosition = (bulletin) => bulletin.resumeIndex ?? bulletin.completedIndex + 1;
const unfinished = (bulletin) => resumePosition(bulletin) < bulletin.segments.length;

export function bulletinNavigation(bulletin, now = Date.now()) {
  if (!isBulletinFresh(bulletin, now)) return null;
  const newsIndices = bulletin.segments.flatMap((segment, index) => segment.kind === "news" ? [index] : []);
  const current = newsIndices.filter((index) => index <= bulletin.activeIndex).at(-1);
  const position = current === undefined ? -1 : newsIndices.indexOf(current);
  return {
    expiresAt: bulletin.savedAt + BULLETIN_CONTEXT_TTL_MS,
    count: newsIndices.length, position,
    title: current === undefined ? "" : bulletin.segments[current].article?.titre || bulletin.segments[current].text,
    previousAt: position > 0 ? newsIndices[position - 1] : null,
    nextAt: newsIndices[position + 1] ?? null,
    resumeAt: resumePosition(bulletin),
    finished: !unfinished(bulletin),
  };
}

function currentPassage(bulletin) {
  const active = bulletin.segments[bulletin.activeIndex];
  return active?.kind === "news" ? active : announced(bulletin).reverse().find((segment) => segment.kind === "news");
}

function recall(bulletin, segment, missing) {
  if (!segment) return { text: missing };
  const suffix = unfinished(bulletin) ? " Dis « reprends » pour poursuivre le bulletin." : "";
  return { text: `Voici ce que j'ai annoncé : ${segment.text}${suffix}` };
}

function significantWords(text) {
  return text.split(" ").filter((word) => word.length >= 5 && !STOPWORDS.has(word));
}

function analysisPrompt(command, bulletin, selectedPassage) {
  const passage = selectedPassage || currentPassage(bulletin);
  const others = announced(bulletin).filter((segment) => segment !== passage && ["news", "weather"].includes(segment.kind));
  const lines = [
    command,
    "",
    selectedPassage ? "CONTEXTE — TITRE SÉLECTIONNÉ DANS LE BULLETIN ΣIRIUS :" : "CONTEXTE — BULLETIN ΣIRIUS DÉJÀ ANNONCÉ À L'UTILISATEUR :",
    passage ? `${selectedPassage ? "Titre sélectionné" : "Passage en cours"} : ${passage.text}` : "Aucune actualité n'avait encore été annoncée.",
    ...(passage?.article?.url ? [`Source du passage : ${passage.article.source} — ${passage.article.url}`] : []),
    ...(others.length ? ["Autres éléments déjà annoncés :", ...others.map((segment) => `- ${segment.text}`)] : []),
    "",
    "CONSIGNES : réponds à la question à partir de ce passage, sans relire ni relancer le bulletin. "
      + "N'invente aucun fait, nom, chiffre ou date absent du passage ; si la réponse n'y figure pas, dis-le clairement "
      + "et ne la complète qu'avec une source récente vérifiée et citée. Si la question ne porte pas sur le bulletin, ignore ce contexte.",
  ];
  return lines.join("\n").slice(0, 6000);
}

export function bulletinFollowUp(command, bulletin, now = Date.now()) {
  const text = normalize(command);
  if (!text) return null;
  const fresh = isBulletinFresh(bulletin, now);
  const explicitWeather = WEATHER_RECALL.test(text);
  const explicitNews = NEWS_RECALL.test(text);
  const explicitResume = EXPLICIT_RESUME.test(text);
  const nextItem = NEXT_ITEM.test(text);
  const previousItem = PREVIOUS_ITEM.test(text);
  const numberedItem = NUMBERED_ITEM.exec(text);
  const explicitNavigation = (nextItem || previousItem || numberedItem) && /\bdu bulletin$/.test(text);
  if ((nextItem || previousItem || numberedItem) && (explicitNavigation || (fresh && bulletin.focused))) {
    if (!fresh) return { text: NO_RECENT };
    const navigation = bulletinNavigation(bulletin, now);
    if (!navigation.count) return { text: "Ce bulletin ne contient aucun titre vérifié à parcourir." };
    if (numberedItem) {
      const ordinal = Number(numberedItem[1]);
      const segment = bulletin.segments.filter((item) => item.kind === "news")[ordinal - 1];
      if (!segment) return { text: `Ce bulletin contient ${navigation.count} titre${navigation.count > 1 ? "s" : ""}. Choisissez un numéro de 1 à ${navigation.count}.` };
      if (/^(?:developpe|detaille|explique)/.test(text)) return { analysis: analysisPrompt(String(command).trim(), bulletin, segment) };
      return { navigateAt: bulletin.segments.indexOf(segment) };
    }
    const index = nextItem ? navigation.nextAt : navigation.previousAt;
    return index === null
      ? { text: nextItem ? "Vous êtes au dernier titre du bulletin." : "Aucun titre précédent dans ce bulletin." }
      : { navigateAt: index };
  }
  if (explicitWeather || explicitNews || explicitResume) {
    if (!fresh) return { text: NO_RECENT };
    if (explicitResume) return { resumeAt: resumePosition(bulletin) };
    if (explicitWeather) {
      return recall(bulletin, announced(bulletin).find((segment) => segment.kind === "weather"),
        "Je n'ai pas encore annoncé de météo dans ce bulletin.");
    }
    return recall(bulletin, currentPassage(bulletin), "Je n'ai pas encore annoncé d'actualité dans ce bulletin.");
  }
  if (!fresh) return null;
  const restartScope = bulletin.focused && !newsBulletinScope(command) ? newsRetryScope(command, bulletin.scope) : null;
  if (restartScope) return { restartScope };
  if (GENERIC_RESUME.test(text)) return bulletin.resumable ? { resumeAt: resumePosition(bulletin) } : null;
  if (!bulletin.focused) return null;
  if (GENERIC_REPEAT.test(text)) {
    return recall(bulletin, bulletin.segments[bulletin.activeIndex], "Je n'ai encore rien annoncé de ce bulletin.");
  }
  if (/\b(?:resultats?|scores?|matchs?|matches|classements?)\b/.test(text)
      && /\b(?:sports?|sportifs?|foot(?:ball)?|rugby|tennis|basket|nba|f1|motogp|grand prix)\b/.test(text)) {
    return null;
  }
  if (text.length > 200 || !(QUESTION.test(text) || /\?\s*$/.test(String(command)))) return null;
  const spoken = normalize(announced(bulletin).map((segment) => segment.text).join(" "));
  const referential = DEICTIC.test(text.replace(IMPERSONAL, " "))
    || significantWords(text).some((word) => spoken.includes(word));
  return referential && announced(bulletin).length ? { analysis: analysisPrompt(String(command).trim(), bulletin) } : null;
}
import { newsBulletinScope, newsRetryScope } from "./newsCommandRouting";
