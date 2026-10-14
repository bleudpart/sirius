const WEATHER_CODES = {
  0: "ciel dégagé", 1: "ciel peu nuageux", 2: "ciel partiellement nuageux", 3: "ciel couvert",
  45: "brouillard", 48: "brouillard givrant",
  51: "bruine légère", 53: "bruine modérée", 55: "bruine dense", 56: "bruine verglaçante", 57: "bruine verglaçante dense",
  61: "pluie faible", 63: "pluie modérée", 65: "pluie forte", 66: "pluie verglaçante", 67: "pluie verglaçante forte",
  71: "neige faible", 73: "neige modérée", 75: "neige forte", 77: "grains de neige",
  80: "averses faibles", 81: "averses modérées", 82: "averses violentes", 85: "averses de neige", 86: "fortes averses de neige",
  95: "orages", 96: "orages avec grêle", 99: "orages avec forte grêle",
};

export const NEWS_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const WEATHER_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCOPE_SECTIONS = { france: ["france"], international: ["monde"] };
const SCOPE_TITLES = { france: "France", international: "internationales", all: "France et international" };

const numberFr = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const dayFr = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

const degrees = (value) => `${numberFr.format(value)} degré${Math.abs(value) >= 2 ? "s" : ""}`;
const clock = (hours, minutes) => `${Number(hours)} h${Number(minutes) ? ` ${String(minutes).padStart(2, "0")}` : ""}`;
const sentence = (text) => {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return !clean || /[.!?…]$/.test(clean) ? clean : `${clean}.`;
};
const isHttpUrl = (url) => /^https?:\/\/\S+$/i.test(String(url || ""));

function calendarDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) throw new Error("Date météo invalide.");
  const date = Date.UTC(+match[1], +match[2] - 1, +match[3]);
  if (new Date(date).getUTCDate() !== +match[3]) throw new Error("Date météo invalide.");
  return date;
}

function relativeDay(day, reference) {
  const label = dayFr.format(new Date(day));
  const offset = Math.round((day - reference) / DAY_MS);
  return offset === 0 ? `aujourd'hui, ${label}` : offset === 1 ? `demain, ${label}`
    : offset === -1 ? `hier, ${label}` : `le ${label}`;
}

// Heure « murale » d'un instant dans un fuseau, exprimée en millisecondes UTC comparables.
function wallClock(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
}

function checkRange(value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error("Mesures météo invalides.");
  return value;
}

function conditionLabel(code) {
  const label = Number.isInteger(code) ? WEATHER_CODES[code] : undefined;
  if (!label) throw new Error("Code météo inconnu.");
  return label;
}

export function weatherBulletinText(data, { now = Date.now() } = {}) {
  if (!data?.city || !data.source || !data.timezone || !data.current || !Array.isArray(data.days) || data.days.length !== 2) {
    throw new Error("Bulletin météo incomplet.");
  }
  const { current } = data;
  const time = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(String(current.time || ""));
  if (!time) throw new Error("Horodatage météo invalide.");
  const measuredDay = calendarDay(time[1]);
  let localNow;
  try {
    localNow = wallClock(now, data.timezone);
  } catch (_) {
    throw new Error("Fuseau horaire météo invalide.");
  }
  if (Math.abs(localNow - (measuredDay + (+time[2] * 60 + +time[3]) * 60000)) > WEATHER_MAX_AGE_MS) {
    throw new Error("Relevé météo périmé.");
  }
  // Les prévisions journalières commencent au jour local actuel, même si le relevé date d'avant minuit.
  const today = Math.floor(localNow / DAY_MS) * DAY_MS;
  checkRange(current.temperature_2m, -90, 60);
  checkRange(current.apparent_temperature, -100, 70);
  checkRange(current.wind_speed_10m, 0, 400);
  const days = data.days.map((day, index) => {
    const date = calendarDay(day?.date);
    if (date !== today + index * DAY_MS) throw new Error("Prévisions météo non consécutives.");
    const min = checkRange(day.temperature_2m_min, -90, 60);
    const max = checkRange(day.temperature_2m_max, -90, 60);
    if (min > max) throw new Error("Prévisions météo incohérentes.");
    checkRange(day.precipitation_probability_max, 0, 100);
    checkRange(day.wind_speed_10m_max, 0, 400);
    const when = relativeDay(date, today);
    return `${when.charAt(0).toUpperCase()}${when.slice(1)} : ${conditionLabel(day.weather_code)}, minimale ${degrees(min)}, maximale ${degrees(max)}, probabilité maximale de précipitations ${numberFr.format(day.precipitation_probability_max)} pour cent, vent jusqu'à ${numberFr.format(day.wind_speed_10m_max)} kilomètres heure.`;
  });
  const place = `${data.city}${data.country ? `, ${data.country}` : ""}`;
  return [
    `Météo à ${place}.`,
    `Conditions relevées ${relativeDay(measuredDay, today)} à ${clock(time[2], time[3])}, heure locale : ${conditionLabel(current.weather_code)}, ${degrees(current.temperature_2m)}, ressenti ${degrees(current.apparent_temperature)}, vent moyen ${numberFr.format(current.wind_speed_10m)} kilomètres heure.`,
    ...days,
    `Source : ${data.source}, prévisions modélisées et non alerte officielle.`,
  ].join(" ");
}

export function publishedWhen(date, now = Date.now()) {
  const published = new Date(date);
  const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(published).split(":");
  const startOf = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const offset = Math.round((startOf(new Date(now)) - startOf(published)) / DAY_MS);
  const day = offset === 0 ? "aujourd'hui" : offset === 1 ? "hier"
    : `le ${new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(published)}`;
  return `${day} à ${clock(time[0], time[1])}`;
}

function isRecent(article, now) {
  const published = Date.parse(article?.date);
  return Boolean(article?.titre && article.source && isHttpUrl(article.url))
    && Number.isFinite(published) && published <= now && now - published <= NEWS_MAX_AGE_MS;
}

export function buildNewsBulletin({ scope = "all", sections, weather, now = Date.now() }) {
  const selected = Array.isArray(sections)
    ? sections.filter((section) => scope === "all" || SCOPE_SECTIONS[scope]?.includes(section?.id)) : [];
  if (!selected.length || selected.some((section) => !section.label || !Array.isArray(section.articles))) {
    throw new Error("Bulletin d'actualités invalide.");
  }
  const segments = [{ kind: "intro", text: `Voici le bulletin d'actualités ${SCOPE_TITLES[scope] || SCOPE_TITLES.all}, avec des informations publiées dans les dernières 48 heures.` }];
  if (weather?.text) segments.push({ kind: "weather", text: weather.text });
  const articles = [];
  const seen = new Set();
  selected.forEach((section) => {
    const recent = section.articles.filter((article) => isRecent(article, now));
    const distinct = recent.filter((article) => {
      const keys = [article.url, String(article.titre).toLowerCase().replace(/\W+/g, " ").trim()];
      if (keys.some((key) => seen.has(key))) return false;
      keys.forEach((key) => seen.add(key));
      return true;
    });
    distinct.forEach((article) => {
      const title = sentence(article.titre);
      const lead = sentence((String(article.description || "").match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0]) || "");
      const description = lead && lead.toLowerCase() !== title.toLowerCase() ? ` ${lead}` : "";
      articles.push({ ...article, section: section.label });
      segments.push({
        kind: "news", section: section.label,
        article: { titre: article.titre, source: article.source, url: article.url, date: article.date },
        text: `${section.label} : ${title}${description} Publié ${publishedWhen(article.date, now)}. Source : ${article.source}.`,
      });
    });
    if (!distinct.length) {
      segments.push({ kind: "status", section: section.label, text: `${section.label} : ${recent.length ? "événements déjà cités dans une autre rubrique."
        : section.status === "unavailable" ? "source temporairement indisponible."
          : "aucune information datée des dernières 48 heures disponible."}` });
    }
  });
  const spokenText = segments.map((segment) => segment.text).join("\n\n");
  const links = articles.map((article) => `- ${article.section} — ${article.titre} (${article.source}) : ${article.url}`);
  if (weather?.text && weather.source && isHttpUrl(weather.url)) links.push(`- Météo (${weather.source}) : ${weather.url}`);
  return {
    segments, articles, spokenText,
    displayText: links.length ? `${spokenText}\n\nSources :\n${links.join("\n")}` : spokenText,
  };
}
