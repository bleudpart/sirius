// Reconnaît les demandes d'enregistrement en mémoire : « note ça dans ta mémoire : … »,
// « enregistre que … », « retiens … », « mon code est 4482, note-le ».
// Retourne { fact } (fact vide si l'utilisateur n'a rien précisé) ou null.
const OBJECT = "(?:\\s+(?:bien|[çc]a|cela|ceci|l['’]info(?:rmation)?|le fait|aussi))*";
const PLACE = "(?:\\s+(?:dans|en)\\s+(?:ta\\s+|ma\\s+|la\\s+|sa\\s+)?m[ée]moire)?";
const LEAD = new RegExp(
  "^(?:sirius[,\\s]+)?(?:(?:est[- ]ce que\\s+)?(?:tu\\s+peux|peux[- ]tu|pourrais[- ]tu)\\s+)?"
  + "(souviens[- ]?toi|rappelle[- ]?toi|retiens|m[ée]morise[sz]?|note[sz]?|enregistre[sz]?|garde[sz]?)"
  + "(-(?:le|la|moi))?(" + OBJECT + ")(" + PLACE + ")"
  + "\\s*(que\\s+|qu['’]|:|,|-)?\\s*(.*)$",
  "i",
);
const TRAIL = new RegExp(
  "^(.+?)[\\s,.;:!-]+(?:sirius[,\\s]+)?(?:retiens|m[ée]morise|note|enregistre|garde)"
  + "(?:[- ](?:le|la|bien))?(?:\\s+(?:bien|[çc]a|cela))?" + PLACE + "[\\s.!]*$",
  "i",
);
// Ces verbes servent aussi à d'autres commandes (« note la réunion… », « enregistre le fichier »).
const NEEDS_MARKER = /^(note|enregistre|garde)/i;

const clean = (fact) => fact
  .replace(/\s+(?:dans|en)\s+(?:ta\s+|ma\s+|la\s+)?m[ée]moire\s*$/i, "")
  .replace(/^[\s:,-]+|[\s.!?]+$/g, "")
  .trim();

export function parseMemorizeCommand(text) {
  const input = String(text || "").replace(/\s+/g, " ").trim();
  if (!input) return null;
  const lead = input.match(LEAD);
  if (lead) {
    const [, verb, pronoun, object, place, separator, rest] = lead;
    const marked = Boolean(pronoun || object.trim() || place || separator);
    if (!NEEDS_MARKER.test(verb) || marked) {
      return { fact: clean(rest) };
    }
  }
  const trail = input.match(TRAIL);
  if (trail && !/\?\s*$/.test(input) && !/\b(?:je|tu|il|elle|on|nous|vous|ils|elles)$/i.test(clean(trail[1]))
    && clean(trail[1]).length >= 3) return { fact: clean(trail[1]) };
  return null;
}
