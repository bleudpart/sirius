import { cityKey, fetchWeatherDirect } from "./weatherDirect";
import { weatherBulletinText } from "./newsBulletin";

const NOW = Date.parse("2026-10-14T15:45:00Z");
const forecast = () => ({
  timezone: "Europe/Paris",
  current_units: { time: "iso8601", temperature_2m: "°C", apparent_temperature: "°C", weather_code: "wmo code", wind_speed_10m: "km/h" },
  daily_units: {
    time: "iso8601", weather_code: "wmo code", temperature_2m_min: "°C", temperature_2m_max: "°C",
    precipitation_probability_max: "%", wind_speed_10m_max: "km/h",
  },
  current: { time: "2026-10-14T17:45", temperature_2m: 16.8, apparent_temperature: 15.2, weather_code: 3, wind_speed_10m: 11.4 },
  daily: {
    time: ["2026-10-14", "2026-10-15"], weather_code: [3, 61], temperature_2m_min: [10.2, 9.5],
    temperature_2m_max: [17.1, 16.4], precipitation_probability_max: [20, 70], wind_speed_10m_max: [15, 21],
  },
});
const reply = (body, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
const fakeFetch = (data = forecast(), name = "Rosny-sous-Bois") => jest.fn((url) => (url.includes("geocoding")
  ? reply({ results: [{ name, country: "France", latitude: 48.87, longitude: 2.48 }] })
  : reply(data)));

test("cityKey ignore accents, casse et ponctuation", () => {
  expect(cityKey("Rosny-sous-Bois")).toBe(cityKey("rosny sous bois"));
  expect(cityKey("Évry")).toBe("evry");
});

test("le relais direct produit un bulletin validé identique au format serveur", async () => {
  const fetchImpl = fakeFetch();
  const data = await fetchWeatherDirect(" Rosny-sous-Bois ", { fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls[1][0]).toContain("temperature_unit=celsius");
  expect(data.days).toEqual([
    { date: "2026-10-14", weather_code: 3, temperature_2m_min: 10.2, temperature_2m_max: 17.1, precipitation_probability_max: 20, wind_speed_10m_max: 15 },
    { date: "2026-10-15", weather_code: 61, temperature_2m_min: 9.5, temperature_2m_max: 16.4, precipitation_probability_max: 70, wind_speed_10m_max: 21 },
  ]);
  const text = weatherBulletinText(data, { now: NOW });
  expect(text).toContain("Météo à Rosny-sous-Bois, France.");
  expect(text).toContain("16,8 degrés");
});

test("le relais refuse une ville géocodée différente", async () => {
  await expect(fetchWeatherDirect("Rosny", { fetchImpl: fakeFetch(forecast(), "Rosny-sur-Seine") })).rejects.toThrow("introuvable");
});

test("le relais refuse des unités non métriques", async () => {
  const data = forecast();
  data.current_units.temperature_2m = "°F";
  await expect(fetchWeatherDirect("Rosny-sous-Bois", { fetchImpl: fakeFetch(data) })).rejects.toThrow("Unités");
});

test("le relais propage une erreur HTTP Open-Meteo", async () => {
  const fetchImpl = jest.fn(() => reply({}, false, 429));
  await expect(fetchWeatherDirect("Paris", { fetchImpl })).rejects.toThrow("429");
});
