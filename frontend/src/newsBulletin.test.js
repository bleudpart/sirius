import { NEWS_MAX_AGE_MS, buildNewsBulletin, publishedWhen, weatherBulletinText } from "./newsBulletin";

const NOW = Date.parse("2026-10-14T15:05:00Z"); // 17 h 05 à Lyon

const weatherData = () => ({
  city: "Lyon", country: "France", source: "Open-Meteo", url: "https://open-meteo.com/", timezone: "Europe/Paris",
  current: { time: "2026-10-14T17:00", temperature_2m: 18.3, apparent_temperature: 17, weather_code: 61, wind_speed_10m: 12 },
  days: [
    { date: "2026-10-14", weather_code: 61, temperature_2m_min: 12, temperature_2m_max: 19, precipitation_probability_max: 80, wind_speed_10m_max: 22 },
    { date: "2026-10-15", weather_code: 0, temperature_2m_min: 1, temperature_2m_max: 20, precipitation_probability_max: 10, wind_speed_10m_max: 15 },
  ],
});

test("weather uses natural exact French dates, sourced values and probabilities", () => {
  const text = weatherBulletinText(weatherData(), { now: NOW });
  expect(text).toContain("Météo à Lyon, France.");
  expect(text).toContain("Conditions relevées aujourd'hui, mercredi 14 octobre à 17 h, heure locale : pluie faible, 18,3 degrés, ressenti 17 degrés");
  expect(text).toContain("Aujourd'hui, mercredi 14 octobre : pluie faible, minimale 12 degrés, maximale 19 degrés, probabilité maximale de précipitations 80 pour cent");
  expect(text).toContain("Demain, jeudi 15 octobre : ciel dégagé, minimale 1 degré, maximale 20 degrés");
  expect(text).toContain("Source : Open-Meteo, prévisions modélisées et non alerte officielle.");
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
});

test("a fresh observation from before local midnight is kept and daily forecasts start at the current local day", () => {
  const data = weatherData();
  Object.assign(data, { city: "Tokyo", country: "Japon", timezone: "Asia/Tokyo" });
  data.current.time = "2026-10-14T23:45";
  data.days[0].date = "2026-10-15";
  data.days[1].date = "2026-10-16";
  const text = weatherBulletinText(data, { now: Date.parse("2026-10-14T15:45:00Z") }); // 00 h 45 à Tokyo
  expect(text).toContain("Conditions relevées hier, mercredi 14 octobre à 23 h 45, heure locale");
  expect(text).toContain("Aujourd'hui, jeudi 15 octobre : pluie faible");
  expect(text).toContain("Demain, vendredi 16 octobre : ciel dégagé");
  data.days = [{ ...data.days[0], date: "2026-10-14" }, { ...data.days[1], date: "2026-10-15" }];
  expect(() => weatherBulletinText(data, { now: Date.parse("2026-10-14T15:45:00Z") })).toThrow("non consécutives");
});

test.each([
  ["missing fields", (data) => { data.current = {}; }],
  ["out-of-range probability", (data) => { data.days[0].precipitation_probability_max = 140; }],
  ["min above max", (data) => { data.days[1].temperature_2m_min = 25; }],
  ["unknown weather code", (data) => { data.current.weather_code = 42; }],
  ["non-consecutive days", (data) => { data.days[1].date = "2026-10-17"; }],
  ["impossible date", (data) => { data.days[1].date = "2026-02-30"; }],
  ["stale observation", (data) => { data.current.time = "2026-10-13T17:00"; }],
  ["invalid timezone", (data) => { data.timezone = "Mars/Olympus"; }],
  ["non-numeric temperature", (data) => { data.current.temperature_2m = "18"; }],
])("weather rejects %s", (_label, mutate) => {
  const data = weatherData();
  mutate(data);
  expect(() => weatherBulletinText(data, { now: NOW })).toThrow();
});

test("publication time is phrased relative to today", () => {
  const now = new Date(2026, 9, 14, 18, 0).getTime();
  expect(publishedWhen(new Date(2026, 9, 14, 9, 5).toISOString(), now)).toBe("aujourd'hui à 9 h 05");
  expect(publishedWhen(new Date(2026, 9, 13, 17, 0).toISOString(), now)).toBe("hier à 17 h");
  expect(publishedWhen(new Date(2026, 9, 12, 20, 30).toISOString(), now)).toBe("le lundi 12 octobre à 20 h 30");
});

const article = (titre, ageMs, extra = {}) => ({
  titre, source: "Franceinfo", url: `https://www.franceinfo.fr/${encodeURIComponent(titre)}`,
  date: new Date(NOW - ageMs).toISOString(), ...extra,
});

const sections = () => [
  { id: "france", label: "France", status: "ok", articles: [
    article("Décision du maire", 3600000, { description: "Le conseil a voté. Une phrase coup" }),
    article("Titre périmé", NEWS_MAX_AGE_MS + 60000),
    article("Titre futur", -3600000),
    article("Sans lien", 60000, { url: "javascript:alert(1)" }),
  ] },
  { id: "monde", label: "International", status: "ok", articles: [
    article("Vote du parlement", 7200000),
    article("Décision du maire", 3600000, { url: "https://autre.example/doublon" }),
  ] },
  { id: "sante", label: "Santé", status: "unavailable", articles: [] },
  { id: "sport", label: "Sport", status: "ok", articles: [article("Ancien match", NEWS_MAX_AGE_MS * 2)] },
];

test("the bulletin keeps only sourced items from the last 48 hours, with explicit sections and links", () => {
  const bulletin = buildNewsBulletin({ scope: "all", sections: sections(), weather: { text: "Météo à Lyon.", source: "Open-Meteo", url: "https://open-meteo.com/" }, now: NOW });
  expect(bulletin.segments.map((segment) => segment.kind)).toEqual(["intro", "weather", "news", "news", "status", "status"]);
  expect(bulletin.segments[2].text).toMatch(/^France : Décision du maire\. Le conseil a voté\. Source : Franceinfo, publié aujourd'hui à \d{1,2} h 05\.$/);
  expect(bulletin.segments[3].text).toContain("International : Vote du parlement.");
  expect(bulletin.spokenText).not.toMatch(/périmé|futur|Sans lien|Une phrase coup|Ancien match/);
  expect(bulletin.spokenText).toContain("Santé : source temporairement indisponible.");
  expect(bulletin.spokenText).toContain("Sport : aucune information datée des dernières 48 heures disponible.");
  expect(bulletin.displayText).toContain("Sources :\n- France — Décision du maire (Franceinfo) : https://www.franceinfo.fr/");
  expect(bulletin.displayText).toContain("- Météo (Open-Meteo) : https://open-meteo.com/");
  expect(bulletin.spokenText).not.toContain("https://");
});

test.each([["france", "France", "Vote du parlement"], ["international", "International", "Décision du maire. Le conseil"]])(
  "scope %s keeps its own section only", (scope, label, excluded) => {
    const bulletin = buildNewsBulletin({ scope, sections: sections(), now: NOW });
    expect(bulletin.segments.filter((segment) => segment.section).every((segment) => segment.section === label)).toBe(true);
    expect(bulletin.spokenText).not.toContain(excluded);
  },
);

test("invalid briefing payloads are rejected rather than read", () => {
  expect(() => buildNewsBulletin({ scope: "all", sections: null, now: NOW })).toThrow();
  expect(() => buildNewsBulletin({ scope: "france", sections: [{ id: "monde", label: "International", articles: [] }], now: NOW })).toThrow();
  expect(() => buildNewsBulletin({ scope: "all", sections: [{ id: "france", label: "France", articles: "x" }], now: NOW })).toThrow();
});
