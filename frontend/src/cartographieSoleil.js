const RAD = Math.PI / 180;
const DAY_MS = 24 * 60 * 60 * 1000;

export function solarPosition(instant) {
  const timestamp = instant.getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Date solaire invalide.");
  const year = instant.getUTCFullYear();
  const day = Math.floor((timestamp - Date.UTC(year, 0, 0)) / DAY_MS);
  const daysInYear = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY_MS;
  const minutes = instant.getUTCHours() * 60 + instant.getUTCMinutes()
    + instant.getUTCSeconds() / 60 + instant.getUTCMilliseconds() / 60_000;
  const gamma = 2 * Math.PI / daysInYear * (day - 1 + (minutes / 60 - 12) / 24);
  const equation = 229.18 * (
    0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma)
  );
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const longitude = ((180 - (minutes + equation) / 4 + 540) % 360) - 180;
  return { longitude, declination };
}

export function nightPolygons(instant) {
  const { longitude, declination } = solarPosition(instant);
  const pole = declination >= 0 ? -90 : 90;
  const tangent = Math.abs(Math.tan(declination)) < 1e-10
    ? (declination >= 0 ? 1e-10 : -1e-10) : Math.tan(declination);
  const boundary = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const latitude = Math.atan(-Math.cos((lon - longitude) * RAD) / tangent) / RAD;
    boundary.push([latitude, lon]);
  }
  const ring = [[pole, -180], ...boundary, [pole, 180]];
  return [-360, 0, 360].map((offset) => [ring.map(([lat, lon]) => [lat, lon + offset])]);
}
