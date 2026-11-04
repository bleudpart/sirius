import { WORLD, eventSubtitle, eventTitle, filterMapEvents, inBounds, layerQuery, markerStyle, nearbyList } from "./cartographie";

const ORIGIN = { name: "Paris", country: "France", latitude: 48.86, longitude: 2.35 };
const EVENTS = [
  { kind: "evenement", title: "Orage", type: "Storm", distance_km: 111, latitude: 47.9, longitude: 1.9, date: "2026-05-02T05:00:00+00:00", provider: "NASA EONET" },
  { kind: "seisme", title: "Séisme 4,1", place: "Près de Reims", magnitude: 4.1, distance_km: 130, latitude: 49.25, longitude: 4.03, date: "2026-05-02T04:00:00+00:00", provider: "USGS" },
  { kind: "evenement", title: "Flood Warning", distance_km: 8900, latitude: 32.2, longitude: -110.9, date: "2026-05-02T06:00:00+00:00", provider: "NOAA/NWS" },
  { kind: "seisme", title: "Fidji", place: "Fidji", magnitude: 5, distance_km: 16000, latitude: -17.8, longitude: 179.5, date: "2026-05-01T06:00:00+00:00", provider: "USGS" },
];
const ALL = { seisme: true, evenement: true };

test("filters by radius around the establishment and by kind", () => {
  expect(filterMapEvents(EVENTS, { origin: ORIGIN, radiusKm: 300, kinds: ALL }).map((e) => e.title)).toEqual(["Orage", "Séisme 4,1"]);
  expect(filterMapEvents(EVENTS, { origin: ORIGIN, radiusKm: 100, kinds: ALL })).toEqual([]);
  expect(filterMapEvents(EVENTS, { origin: ORIGIN, radiusKm: WORLD, kinds: { seisme: true, evenement: false } }).map((e) => e.title))
    .toEqual(["Séisme 4,1", "Fidji"]);
});

test("ignores the radius when no establishment city is configured", () => {
  const unknown = EVENTS.map((item) => ({ ...item, distance_km: null }));
  expect(filterMapEvents(unknown, { origin: null, radiusKm: 300, kinds: ALL })).toHaveLength(4);
});

test("visible area handles normal views, wrapped longitudes and the whole world", () => {
  const france = { south: 41, west: -5, north: 51.5, east: 10 };
  expect(inBounds(france, 48.86, 2.35)).toBe(true);
  expect(inBounds(france, 32.2, -110.9)).toBe(false);
  const pacific = { south: -30, west: 170, north: 0, east: 190 };
  expect(inBounds(pacific, -17.8, 179.5)).toBe(true);
  expect(inBounds(pacific, -17.8, -175)).toBe(true);
  expect(inBounds({ south: -90, west: -400, north: 90, east: 400 }, 0, 120)).toBe(true);
});

test("nearby list keeps only the visible area when requested and sorts by distance", () => {
  const france = { south: 41, west: -5, north: 51.5, east: 10 };
  const list = nearbyList(EVENTS, { bounds: france, visibleOnly: true });
  expect(list.total).toBe(2);
  expect(list.items.map((e) => e.title)).toEqual(["Orage", "Séisme 4,1"]);
  expect(nearbyList(EVENTS, { bounds: france, visibleOnly: false, limit: 1 })).toEqual({ total: 4, items: [EVENTS[0]] });
});

test("subtitle shows place, distance, Paris time and provider", () => {
  expect(eventSubtitle(EVENTS[1])).toBe("Près de Reims · 130 km · 02/05 06:00 · USGS");
});

test("layer queries round outward, handle the antimeridian and keep a world view bounded", () => {
  const pacific = new URLSearchParams(layerQuery({ south: -30.0002, west: 170, north: 0.0002, east: 190 }, ORIGIN, 300));
  expect(Object.fromEntries(pacific)).toEqual({ south: "-30.001", west: "170", north: "0.001", east: "190", radius_km: "300" });
  const world = new URLSearchParams(layerQuery({ south: -90, west: -400, north: 90, east: 400 }, null, WORLD));
  expect(Object.fromEntries(world)).toEqual({ south: "-90", west: "-180", north: "90", east: "180" });
});

test("transport and geopolitical details distinguish estimates from published reports", () => {
  expect(eventSubtitle({
    kind: "satellite", altitude_km: 550, distance_km: 30, date: "2026-05-02T05:00:00Z", provider: "OSIRIS",
  })).toContain("Position calculée · environ 550 km d’altitude · Point au sol à 30 km · Flux");
  expect(eventSubtitle({
    kind: "actualite", location_precision: "country-anchor", distance_km: 12,
    date: "2026-05-02T05:00:00Z", provider: "Agence",
  })).toContain("Point indicatif du pays · Repère à 12 km · Publication");
  expect(eventSubtitle({ kind: "conflit", date: null, provider: "OSIRIS" })).toBe("Repère indicatif, pas une frontière · OSIRIS");
  expect(eventSubtitle({
    kind: "maritime", subtype: "chokepoint", traffic: "21M bpd oil", risk: "HIGH",
    distance_km: 25, date: "2026-05-02T05:00:00Z", provider: "OSIRIS",
  })).toContain("Passage stratégique · 21 M barils de pétrole/jour · Risque fort · Repère à 25 km · Flux");
  expect(markerStyle({ kind: "avion" }).color).not.toBe(markerStyle({ kind: "satellite" }).color);
  expect(markerStyle({ kind: "maritime" }).color).toBe("#63e6be");
  expect(eventSubtitle({ kind: "camera", city: "Paris", country: "FR", url: null }))
    .toContain("Paris · FR · Lien du flux indisponible");
  expect(markerStyle({ kind: "camera" }).color).toBe("#f28ed4");
});

test("translates known source labels while preserving unknown titles", () => {
  expect(eventTitle({ kind: "evenement", title: "Flood Warning" })).toBe("Alerte inondation");
  expect(eventSubtitle({ kind: "evenement", type: "Flood Advisory" })).toBe("Avis d’inondation");
  expect(eventTitle({ kind: "evenement", title: "Un rapport spécifique" })).toBe("Un rapport spécifique");
  expect(eventTitle({ kind: "evenement", title: "constructor" })).toBe("constructor");
  expect(eventTitle({ kind: "actualite", title: "Flood Warning" })).toBe("Flood Warning");
  expect(eventSubtitle({
    kind: "maritime", subtype: "port", volume: "12.0M TEU | LIVE: 0 (WAITING: 0)", congestion: "HIGH",
  })).toBe("Port · 12,0 M EVP | En direct : 0 (En attente : 0) · Congestion forte");
  expect(eventSubtitle({
    kind: "maritime", subtype: "chokepoint", traffic: "12% world trade | LIVE SHIPS: 0", risk: "CRITICAL",
  })).toBe("Passage stratégique · 12% du commerce mondial | Navires en direct : 0 · Risque critique");
  expect(eventSubtitle({ kind: "maritime", subtype: "port", risk: "UNUSUAL" })).toBe("Port · Risque unusual");
});
