// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).

export function normalizeVoiceTranscript(text) {
  if (!text) return "";
  return [
    [/\bdaniel\s*[,;:]?\s*pontel\b/gi, "Daniel Partel"],
    [/\bdaniel\s*[,;:]?\s*parti\b/gi, "Daniel Partel"],
    [/\bdaniel\s*[,;:]?\s*part\s+elle\b/gi, "Daniel Partel"],
    [/\bpontel\b/gi, "Partel"],
    [/\bpart\s+elle\b/gi, "Partel"],
    [/\bserious\b/gi, "SIRIUS"],
    [/\bsyrius\b/gi, "SIRIUS"],
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
