// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).

export const isVoiceYes = (text) =>
  /\b(oui|ouais|vas[- ]y|envoie|envoi|ok|d'accord|confirme|je confirme|bien s[ûu]r)\b/i.test(text || "");

export const isVoiceNo = (text) =>
  /\b(non|annule|laisse|pas maintenant|surtout pas|stop)\b/i.test(text || "");

const SEND_VERB = "(?:envoie|envoi|envoies|envoyer|adresse|[ée]cris|[ée]crire|r[ée]dige|r[ée]diger|transmets|transmettre|fais\\s+parvenir)";
const MAIL_NOUN = "(?:e-?mails?|mails?|courriels?|messages?|courriers?)";
const PROVIDER_PART = "(?:\\s+(?:avec|via|par|depuis|sur)\\s+(?:outlook|gmail|hotmail|microsoft|google))?";
// `\b` ne fonctionne pas devant « écris » (é n'est pas un caractère de mot) : on exige
// explicitement un début de phrase ou un caractère non alphabétique.
const VERB_START = "(?:^|[^\\p{L}])";
const SEND_EMAIL = new RegExp(
  `${VERB_START}${SEND_VERB}(?:[- ](?:moi|lui|leur))?\\s+(?:un |une |le |la |ce |cet |mon )?${MAIL_NOUN}\\b`,
  "iu",
);
const SEND_EMAIL_TO = new RegExp(
  `${VERB_START}${SEND_VERB}(?:[- ](?:moi|lui|leur))?\\s+(?:un |une |le |la |ce |cet |mon )?${MAIL_NOUN}\\b${PROVIDER_PART}\\s*(?:[àa]|pour|au|aux)\\s+(.+)`,
  "iu",
);

/** Vrai dès que la phrase exprime l'envoi d'un e-mail, même sans destinataire nommé. */
export function isSendEmailCommand(text) {
  return SEND_EMAIL.test(String(text || ""));
}

export function extractEmailRecipientQuery(text) {
  const match = String(text || "").match(SEND_EMAIL_TO);
  if (!match) return "";
  return match[1]
    .replace(/\s+(?:avec|via|par|depuis|sur)\s+(?:outlook|gmail|hotmail|microsoft|google)\b.*$/i, "")
    .replace(/\s*(?:,|:)?\s*(?:objet|sujet|message|corps|texte)\s*[:\-]?.*$/i, "")
    .replace(/[?!.]+$/, "")
    .trim();
}

export function voiceNumberChoice(text, max) {
  const low = String(text || "").toLowerCase();
  const words = { un: 1, une: 1, premier: 1, première: 1, deux: 2, second: 2, deuxième: 2, trois: 3, quatre: 4, cinq: 5 };
  const digit = low.match(/\b([1-5])\b/);
  const value = digit ? Number(digit[1]) : Object.entries(words).find(([word]) => new RegExp(`\\b${word}\\b`).test(low))?.[1];
  return value && value >= 1 && value <= max ? value - 1 : -1;
}

export function detectMailProvider(text) {
  const low = String(text || "").toLowerCase();
  if (/\bgmail|google\b/.test(low)) return "gmail";
  if (/\boutlook|hotmail|microsoft\b/.test(low)) return "outlook";
  return "";
}

const CONTACT_COMMAND = /(?:cherche|recherche|trouve|affiche|montre|liste|ouvre)\w*(?:[- ]moi)?\s+(?:(?:le|un|une)\s+)?(?:dans\s+)?(?:mes\s+|les\s+)?contacts?\b(.*)$/i;

/** Vrai pour « montre mes contacts », faux pour « prends contact avec le fournisseur ». */
export function isContactCommand(text) {
  const low = String(text || "").toLowerCase();
  return CONTACT_COMMAND.test(low) || /\b(?:mes|les)\s+contacts?\b/.test(low);
}

/** Nom recherché dans « montre mes contacts Outlook de Daniel » — chaîne vide = tout lister.
 *  Le fournisseur et les mots de liaison ne doivent jamais être pris pour un nom de contact. */
export function extractContactQuery(text) {
  const match = String(text || "").match(CONTACT_COMMAND);
  if (!match) return "";
  return match[1]
    .replace(/\b(?:outlook|microsoft|hotmail|gmail|google)\b/gi, " ")
    .replace(/^[\s,;:.-]+/, "")
    .replace(/^(?:dans|de|du|des|d'|pour|nomm[ée]?e?s?|appel[ée]e?s?)\b\s*/i, "")
    .replace(/[?!.,;:]+$/, "")
    .trim();
}
