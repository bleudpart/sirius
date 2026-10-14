export function newsBulletinScope(command) {
  const normalized = String(command || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "'").toLowerCase().trim();
  const match = normalized.match(/^(?:(?:donne|donner|donnez|montre|affiche|lis|lire|presente|resume|dis|quelles sont)(?:[- ]moi)?(?:\s+et\s+(?:affiche|lis|lire|montre))?\s+)?(?:(?:toutes?\s+)?(?:les|des|l'|un|le)\s*)?(?:infos?|informations|actualites?|nouvelles|actus?|news|bulletin|panorama)(?:\s+(?:completes?|du jour|d'aujourd'hui|aujourd'hui|de ce jour))?(?:\s+(en france|de france|francaises?|internationales?|a l'international|dans le monde|du monde|en france et (?:dans le monde|a l'international)))?(?:\s+(?:du jour|d'aujourd'hui|aujourd'hui|completes?))?\s*[?.!]*$/i);
  if (!match) return null;
  if (/^(?:en france|de france|francaises?)$/.test(match[1] || "")) return "france";
  if (match[1] && !match[1].startsWith("en france et")) return "international";
  return "all";
}
