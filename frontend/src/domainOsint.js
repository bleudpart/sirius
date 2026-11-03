export const OSIRIS_MAP_URL = "https://www.osirisai.live/?layers=maritime,satellites,cctv,cctv_previews,live_news,earthquakes,global_incidents,day_night,cables,sdk_sea,sdk_air,sdk_naval,wind_controls,rain_controls";

export function normalizeAuthorizedDomain(value) {
  const raw = String(value || "").trim().replace(/[.,!?;:]+$/, "");
  if (!raw) return null;

  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    const domain = url.hostname.toLowerCase();
    const labels = domain.split(".");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port
      || url.pathname !== "/" || url.search || url.hash
      || labels.length < 2 || labels.some((label) => !/^(?=.{1,63}$)[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(label))
      || /^\d+(?:\.\d+){3}$/.test(domain)
      || ["localhost", "local", "internal", "test", "invalid"].includes(labels[labels.length - 1])) {
      return null;
    }
    return domain;
  } catch {
    return null;
  }
}

export function parseDomainAnalysisCommand(command) {
  const normalized = String(command || "").toLowerCase().replace(/[σς]/g, "s")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\d./:_-]+/g, " ").trim()
    .replace(/^(?:sirius|zirius)\s+/, "");
  const match = normalized.match(/^(?:analyse|analyser|verifie|verifier)\s+(?:(?:ce|le|mon|un|une)\s+)?(?:domaine|site)\b(?:\s+(.*))?$/);
  if (!match) return null;
  return { domain: (match[1] || "").replace(/^de\s+/, "").replace(/[.,!?;:]+$/, "").trim() };
}

export function buildDomainSearches(domain) {
  const normalized = normalizeAuthorizedDomain(domain);
  if (!normalized) throw new Error("Indique un nom de domaine public valide, sans chemin ni adresse IP.");
  const query = encodeURIComponent(`hostname:${normalized}`);
  return [
    {
      id: "crtsh",
      label: "crt.sh — certificats publics",
      url: `https://crt.sh/?q=%25.${encodeURIComponent(normalized)}`,
      note: "Certificats et sous-domaines publiés dans les journaux de transparence.",
    },
    {
      id: "shodan",
      label: "Shodan — hôtes indexés",
      url: `https://www.shodan.io/search?query=${query}`,
      note: "La recherche peut nécessiter un compte Shodan.",
    },
    {
      id: "censys",
      label: "Censys — hôtes et certificats",
      url: `https://search.censys.io/search?resource=hosts&q=${encodeURIComponent(normalized)}`,
      note: "Résultats et détails selon le compte et l'offre Censys.",
    },
    {
      id: "hibp",
      label: "Have I Been Pwned — domaine vérifié",
      url: "https://haveibeenpwned.com/Dashboard#Domains",
      note: "Le domaine doit être vérifié par son propriétaire dans HIBP.",
    },
  ];
}
