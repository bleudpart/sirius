import { nightPolygons, solarPosition } from "./cartographieSoleil";

function contains(ring, latitude, longitude) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lonI] = ring[i];
    const [latJ, lonJ] = ring[j];
    if ((latI > latitude) !== (latJ > latitude)
      && longitude < (lonJ - lonI) * (latitude - latI) / (latJ - latI) + lonI) {
      inside = !inside;
    }
  }
  return inside;
}

function isNight(instant, latitude, longitude) {
  return nightPolygons(new Date(instant)).some(([ring]) => contains(ring, latitude, longitude));
}

test("places the sun near Greenwich at noon on an equinox", () => {
  const { longitude, declination } = solarPosition(new Date("2026-03-20T12:00:00Z"));
  expect(Math.abs(longitude)).toBeLessThan(4);
  expect(Math.abs(declination * 180 / Math.PI)).toBeLessThan(1);
  expect(isNight("2026-03-20T12:00:00Z", 0, 0)).toBe(false);
  expect(isNight("2026-03-20T12:00:00Z", 0, 175)).toBe(true);
});

test("handles polar day and night at both solstices", () => {
  expect(isNight("2026-06-21T12:00:00Z", 85, 0)).toBe(false);
  expect(isNight("2026-06-21T12:00:00Z", -85, 0)).toBe(true);
  expect(isNight("2026-12-21T12:00:00Z", 85, 0)).toBe(true);
  expect(isNight("2026-12-21T12:00:00Z", -85, 0)).toBe(false);
});

test("covers both sides of the antimeridian and repeated map worlds", () => {
  for (const longitude of [-179, 179, 181, 539]) {
    expect(isNight("2026-03-20T12:00:00Z", 0, longitude)).toBe(true);
    expect(isNight("2026-03-20T00:00:00Z", 0, longitude)).toBe(false);
  }
  expect(() => solarPosition(new Date("invalid"))).toThrow("Date solaire invalide");
});
