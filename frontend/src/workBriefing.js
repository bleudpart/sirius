const normalize = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[’]/g, "'").toLowerCase().trim();

export function isResumeWorkCommand(command) {
  return /^(?:(?:on|nous)\s+)?(?:reprend|reprends|reprenons|reprendre|continue|continuer|continuons)(?:\s+(?:mon|le|notre))?\s+travail\s*[?.!]*$/.test(normalize(command));
}

export function isWorkBriefingCommand(command) {
  const text = normalize(command);
  return isResumeWorkCommand(text) || /^(?:(?:affiche(?:r)?|montre(?:r)?|lis|lire|lit|relis|donne|fais|refais|relance|redonne|repasse|refait)(?:[-\s]+moi)?(?:\s+et\s+(?:affiche(?:r)?|montre(?:r)?|lis|lire|lit|relis))?\s+)?(?:(?:mon|le|un)\s+)?(?:brieff?ing(?:\s+(?:de travail|professionnel|quotidien|du jour|matinal|du soir|de ce soir|soir))?|rapport de travail|point sur (?:mon|le) travail|resume(?:[-\s]+moi)?(?:\s+(?:la|ma|du|de ma|de la)\s+)?jour(?:nee)?|fais[-\s]+moi\s+le\s+point(?:\s+sur\s+(?:(?:ma\s+)?journee|mon travail))?|qu'est[-\s]ce\s+qui\s+m'attend(?:\s+aujourd'hui)?|(?:mes\s+)?priorites\s+du\s+jour)\s*[?.!]*$/.test(text);
}
