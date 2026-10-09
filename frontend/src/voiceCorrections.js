// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).

export function normalizeVoiceTranscript(text) {
  if (!text) return "";
  return [
    [/\bbrieffing\b/gi, "briefing"],
    [/\bdaniel\s*[,;:]?\s*pontel\b/gi, "Daniel Partel"],
    [/\bdaniel\s*[,;:]?\s*parti\b/gi, "Daniel Partel"],
    [/\bdaniel\s*[,;:]?\s*part\s+elle\b/gi, "Daniel Partel"],
    [/\bpontel\b/gi, "Partel"],
    [/\bpart\s+elle\b/gi, "Partel"],
    [/\bserious\b/gi, "SIRIUS"],
    [/\bsyrius\b/gi, "SIRIUS"],
    [/\bzirius\b/gi, "SIRIUS"],
    [/\bzir[iy]us(?:se)?\b/gi, "SIRIUS"],
    [/\bcirius\b/gi, "SIRIUS"],
    [/\bsirus\b/gi, "SIRIUS"],
    [/\bcyrus\b/gi, "SIRIUS"],
    [/\bs[ée]rieux\b/gi, "SIRIUS"],
    [/\bargousse\b/gi, "ARGUS"],
    [/\bargus\b/gi, "ARGUS"],
    [/\bargue us\b/gi, "ARGUS"],
    [/\batlace\b/gi, "ATLAS"],
    [/\bathlas\b/gi, "ATLAS"],
    [/\boracle divin\b/gi, "Oracle Divin"],
    [/\bnummarius\b/gi, "Nummarius"],
    [/\bnumarius\b/gi, "Nummarius"],
    [/\bth[ée]mis\b/gi, "Thémis"],
    [/\bpant[ée]on\b/gi, "Panthéon"],
    [/\bh[ée]phaistos\b/gi, "Héphaïstos"],
    [/\bh[ée]racl[eè]s\b/gi, "Héraclès"],
    [/\bpythagor[eé]\b/gi, "Pythagore"],
    [/\bcaliop[eé]\b/gi, "Calliope"],
    [/\bprom[ée]th[ée]\b/gi, "Prométhée"],
    [/\bherm[èe]s\b/gi, "Hermès"],
    [/\bagora\b/gi, "Agora"],
    [/\bout look\b/gi, "Outlook"],
    [/\bhot mail\b/gi, "Hotmail"],
  ].reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), String(text));
}

export function chooseBestVoiceTranscript(alternatives) {
  const list = (alternatives || [])
    .map((item) => ({
      text: normalizeVoiceTranscript(item?.text || item?.transcript || ""),
      confidence: Number.isFinite(item?.confidence) ? item.confidence : 0,
    }))
    .filter((item) => item.text.trim());
  if (!list.length) return "";

  const score = (item) => {
    let value = item.confidence;
    if (/\b(SIRIUS|ARGUS|ATLAS|Outlook|Partel)\b/i.test(item.text)) value += 0.35;
    if (/\bdaniel\s+partel\b/i.test(item.text)) value += 0.5;
    return value;
  };

  return list.sort((a, b) => score(b) - score(a))[0].text.trim();
}

const WAKE_WORD = /\b(?:sirius|syrius|cirius|sirus|cyrus|serious|s[ée]rieux|cilius|syriusse|sirio)\b/gi;
const SHORT_COMMANDS = new Set(["stop", "silence", "pause", "briefing", "continue", "annule", "annuler"]);

export function hasVoiceWakeWord(text) {
  return new RegExp(WAKE_WORD.source, "i").test(normalizeVoiceTranscript(text));
}

export function startsWithVoiceWakeWord(text) {
  return new RegExp(`^\\s*${WAKE_WORD.source}`, "i").test(normalizeVoiceTranscript(text));
}

export function removeVoiceWakeWord(text) {
  return normalizeVoiceTranscript(text)
    .replace(new RegExp(`^\\s*${WAKE_WORD.source}[\\s,.:;!?-]*`, "i"), "")
    .trim();
}

export function extractVoiceCommand(text, { requireWakeWord = false } = {}) {
  const transcript = normalizeVoiceTranscript(text).trim();
  const hasWakeWord = new RegExp(WAKE_WORD.source, "i").test(transcript);
  if (requireWakeWord && (!hasWakeWord || !startsWithVoiceWakeWord(transcript))) return "";

  const command = transcript.replace(WAKE_WORD, " ").replace(/\s+/g, " ").trim().replace(/^[,.\s]+/, "");
  const words = command.match(/[\p{L}\p{N}]+/gu) || [];
  if (!command || (words.length < 2 && !SHORT_COMMANDS.has(words[0]?.toLowerCase()))) return "";
  return command;
}
