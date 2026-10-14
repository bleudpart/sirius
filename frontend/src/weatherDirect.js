// Relais météo exécuté depuis l'appareil : utilisé quand le serveur est limité
// par Open-Meteo (IP partagée). Le texte final reste validé par weatherBulletinText.
const CURRENT_UNITS = {
  time: "iso8601", temperature_2m: "°C", apparent_temperature: "°C", weather_code: "wmo code", wind_speed_10m: "km/h",
};
const DAILY_UNITS = {
  time: "iso8601", weather_code: "wmo code", temperature_2m_min: "°C", temperature_2m_max: "°C",
  precipitation_probability_max: "%", wind_speed_10m_max: "km/h",
};
const TIMEOUT_MS = 8000;

export const cityKey = (value) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("fr").replace(/[^\p{L}\p{N}]/gu, "");

async function getJson(url, signal, fetchImpl) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener?.("abort", abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
}

function sameUnits(units, expected) {
  return Boolean(units) && Object.entries(expected).every(([field, unit]) => units[field] === unit);
}

export async function fetchWeatherDirect(city, { signal, fetchImpl = globalThis.fetch } = {}) {
  const query = String(city || "").trim();
  if (!query || !cityKey(query)) throw new Error("Ville météo invalide.");
  const geocode = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=fr&format=json`,
    signal, fetchImpl,
  );
  const location = Array.isArray(geocode?.results) ? geocode.results[0] : null;
  if (!location || cityKey(location.name) !== cityKey(query)) throw new Error("Ville introuvable.");
  const { latitude, longitude } = location;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error("Coordonnées météo invalides.");
  const params = new URLSearchParams({
    latitude, longitude, timezone: "auto", forecast_days: 2, temperature_unit: "celsius", wind_speed_unit: "kmh",
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max,wind_speed_10m_max",
  });
  const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`, signal, fetchImpl);
  if (!sameUnits(data?.current_units, CURRENT_UNITS) || !sameUnits(data?.daily_units, DAILY_UNITS)) {
    throw new Error("Unités météo incompatibles.");
  }
  const { daily, current } = data;
  if (!current || !daily || !Array.isArray(daily.time) || daily.time.length !== 2) {
    throw new Error("Prévisions météo incomplètes.");
  }
  const fields = Object.keys(DAILY_UNITS).filter((field) => field !== "time");
  if (fields.some((field) => !Array.isArray(daily[field]) || daily[field].length !== 2)) {
    throw new Error("Prévisions météo incomplètes.");
  }
  return {
    city: location.name,
    country: typeof location.country === "string" ? location.country : "",
    source: "Open-Meteo",
    url: "https://open-meteo.com/",
    timezone: data.timezone,
    current: {
      time: current.time,
      ...Object.fromEntries(Object.keys(CURRENT_UNITS).filter((field) => field !== "time").map((field) => [field, current[field]])),
    },
    current_units: { ...CURRENT_UNITS },
    daily_units: { ...DAILY_UNITS },
    days: daily.time.map((date, index) => ({
      date, ...Object.fromEntries(fields.map((field) => [field, daily[field][index]])),
    })),
  };
}
