// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).

export const isVoiceYes = (text) =>
  /\b(oui|ouais|vas[- ]y|envoie|envoi|ok|d'accord|confirme|je confirme|bien s[ûu]r)\b/i.test(text || "");

export const isVoiceNo = (text) =>
  /\b(non|annule|laisse|pas maintenant|surtout pas|stop)\b/i.test(text || "");

export function extractEmailRecipientQuery(text) {
  const match = String(text || "").match(/envoie (?:un )?(?:e-?mail|mail|courriel|message)(?:\s+(?:avec|via)\s+(?:outlook|gmail))?\s+[àa]\s+(.+)/i);
  if (!match) return "";
  return match[1]
    .replace(/\s+(?:avec|via)\s+(?:outlook|gmail)\b.*$/i, "")
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
