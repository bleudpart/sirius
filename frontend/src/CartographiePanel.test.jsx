import { act } from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import CartographiePanel from "./CartographiePanel";

jest.mock("leaflet", () => ({
  __esModule: true,
  default: { map: jest.fn(), tileLayer: jest.fn(), layerGroup: jest.fn(), circleMarker: jest.fn(), circle: jest.fn() },
}));

// CRA active resetMocks : les implémentations Leaflet sont recréées avant chaque test.
function installLeafletMock() {
  const layer = () => {
    const item = {};
    Object.assign(item, {
      addTo: jest.fn(() => item), bindPopup: jest.fn(() => item), bindTooltip: jest.fn(() => item),
      on: jest.fn(() => item), openPopup: jest.fn(), clearLayers: jest.fn(), removeLayer: jest.fn(),
      setLatLng: jest.fn(() => item), setStyle: jest.fn(() => item), setPopupContent: jest.fn(() => item),
      getBounds: jest.fn(() => ({ circle: true })),
    });
    return item;
  };
  const map = {
    on: jest.fn(), off: jest.fn(), remove: jest.fn(), fitBounds: jest.fn(), getZoom: () => 5, invalidateSize: jest.fn(),
    getBounds: () => ({ getSouth: () => 41, getWest: () => -5, getNorth: () => 51.5, getEast: () => 10 }),
  };
  map.setView = jest.fn(() => map);
  L.map.mockImplementation(() => map);
  ["tileLayer", "layerGroup", "circleMarker", "circle"].forEach((name) => L[name].mockImplementation(layer));
}

global.IS_REACT_ACT_ENVIRONMENT = true;
const ORIGIN = { name: "Paris", country: "France", latitude: 48.86, longitude: 2.35 };
const EVENTS = [
  { kind: "evenement", title: "Orage <img src=x onerror=alert(1)>", type: "Storm", severity: "high", distance_km: 111,
    latitude: 47.9, longitude: 1.9, date: "2026-05-02T05:00:00+00:00", provider: "NASA EONET", url: null },
  { kind: "seisme", title: "Séisme de magnitude 4,1", place: "Près de Reims", magnitude: 4.1, distance_km: 130,
    latitude: 49.25, longitude: 4.03, date: "2026-05-02T04:00:00+00:00", provider: "USGS", url: "https://earthquake.usgs.gov/q2" },
  { kind: "evenement", title: "Flood Warning", distance_km: 8900, latitude: 32.2, longitude: -110.9,
    date: "2026-05-02T06:00:00+00:00", provider: "NOAA/NWS", url: null },
];
const PAYLOAD = {
  read_only: true, origin: ORIGIN, default_radius_km: 300, radii_km: [50, 100, 300, 1000], min_magnitude: 3,
  events: EVENTS, truncated: 0,
  sources: [{ id: "evenements", ok: true }, { id: "seismes", ok: false, label: "Séismes", provider: "OSIRIS — USGS", detail: "OSIRIS ne répond pas pour le moment." }],
};
const FLIGHT = {
  id: "abc123", kind: "avion", title: "Avion AF123", latitude: 48.9, longitude: 2.4, distance_km: 40,
  date: "2026-05-02T05:00:00Z", altitude_m: 9000, speed_knots: 420, provider: "OSIRIS — OpenSky / ADS-B",
};

function layerPayload(items, options = {}) {
  return {
    items, total: options.total ?? items.length, truncated: options.truncated ?? 0, ignored: options.ignored ?? 0,
    source: { ok: options.ok ?? true, detail: options.detail ?? null, updated_at: "2026-05-02T05:00:00Z" },
  };
}

let host;
let root;
let oldFetch;

beforeEach(() => {
  installLeafletMock();
  oldFetch = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => PAYLOAD }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = oldFetch;
  jest.clearAllMocks();
});

const titles = () => [...host.querySelectorAll('[data-testid="cartographie-nearby"] li b')].map((node) => node.textContent);

async function change(selector, apply) {
  await act(async () => {
    const element = host.querySelector(selector);
    apply(element);
  });
}

test("loads the caller's map with credentials and lists nearby events within the default radius", async () => {
  await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/veille\/carte$/);
  expect(options.credentials).toBe("include");
  expect(host.querySelector('[data-testid="cartographie-radius"]').value).toBe("300");
  expect(titles()).toEqual(["Orage <img src=x onerror=alert(1)>", "Séisme de magnitude 4,1"]);
  expect(L.circle).toHaveBeenCalledWith([48.86, 2.35], expect.objectContaining({ radius: 300000 }));
  expect(host.textContent).toContain("Source indisponible : Séismes (OSIRIS — USGS) — OSIRIS ne répond pas pour le moment.");

  const popups = L.circleMarker.mock.results.map((result) => result.value.bindPopup.mock.calls[0]?.[0]).filter(Boolean);
  const storm = popups.find((node) => node.textContent.startsWith("Orage"));
  expect(storm.querySelector("img")).toBeNull();
  const quake = popups.find((node) => node.textContent.startsWith("Séisme"));
  expect(quake.querySelector("a").getAttribute("rel")).toBe("noopener noreferrer");
});

test("world radius and visible-area filter update the floating list", async () => {
  await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
  await change('[data-testid="cartographie-radius"]', (select) => {
    select.value = "monde";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(titles()).toHaveLength(3);
  await change('[data-testid="cartographie-visible"]', (box) => box.click());
  expect(titles()).toHaveLength(2);
  await change('[data-testid="cartographie-kind-seisme"]', (box) => box.click());
  expect(titles()).toEqual(["Orage <img src=x onerror=alert(1)>"]);
});

test("without an establishment city the radius filter is disabled and explained", async () => {
  global.fetch.mockImplementation(async () => ({
    ok: true, status: 200,
    json: async () => ({ ...PAYLOAD, origin: null, events: EVENTS.map((item) => ({ ...item, distance_km: null })) }),
  }));
  await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
  expect(host.querySelector('[data-testid="cartographie-radius"]').disabled).toBe(true);
  expect(host.querySelector('[data-testid="cartographie-no-origin"]')).not.toBeNull();
  expect(titles()).toHaveLength(3);
});

test("re-measures the map when its window is resized", async () => {
  const observers = [];
  const original = global.ResizeObserver;
  global.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.disconnect = jest.fn(); observers.push(this); }
    observe(node) { this.node = node; }
  };
  try {
    await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
    const map = L.map.mock.results[0].value;
    expect(observers[0].node).toBe(host.querySelector('[data-testid="cartographie-map"]'));
    await act(async () => observers[0].callback());
    expect(map.invalidateSize).toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(observers[0].disconnect).toHaveBeenCalled();
    root = createRoot(host);
  } finally {
    global.ResizeObserver = original;
  }
});

test("asks to log in when the session is missing", async () => {
  global.fetch.mockImplementation(async () => ({ ok: false, status: 401, json: async () => ({ detail: "Non authentifié" }) }));
  await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
  expect(host.querySelector('[data-testid="cartographie-error"]').textContent).toBe("Connecte-toi pour afficher la carte des événements.");
});

test("loads optional aircraft only when selected and keeps an open popup during refresh", async () => {
  jest.useFakeTimers();
  try {
    let flight = FLIGHT;
    global.fetch.mockImplementation(async (url) => ({
      ok: true, status: 200,
      json: async () => url.includes("/calques/avion")
        ? layerPayload([{ ...flight }], { total: 700, truncated: 699 }) : PAYLOAD,
    }));
    await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await change('[data-testid="cartographie-kind-avion"]', (box) => box.click());
    await act(async () => { jest.advanceTimersByTime(250); });
    const [url, options] = global.fetch.mock.calls[1];
    expect(url).toContain("/veille/carte/calques/avion?");
    expect(url).toContain("south=41&west=-5&north=51.5&east=10&radius_km=300");
    expect(options.credentials).toBe("include");
    expect(titles()).toContain("Avion AF123");
    expect(host.textContent).toContain("1 affiché(s) sur 700 dans la zone");
    expect(host.textContent).toContain("liste limitée, zoome");

    await act(async () => {
      [...host.querySelectorAll('[data-testid="cartographie-nearby"] li button')]
        .find((button) => button.textContent.includes("Avion AF123")).click();
    });
    const marker = L.circleMarker.mock.results.map((result) => result.value)
      .find((item) => item.bindPopup.mock.calls[0]?.[0].textContent.startsWith("Avion AF123"));
    expect(marker.openPopup).toHaveBeenCalledTimes(1);
    const track = L.map.mock.results[0].value.on.mock.calls.find(([event]) => event === "moveend")[1];
    const requestsBeforeMove = global.fetch.mock.calls.length;
    await act(async () => { track(); track(); jest.advanceTimersByTime(1000); });
    expect(global.fetch).toHaveBeenCalledTimes(requestsBeforeMove);
    expect(marker.openPopup).toHaveBeenCalledTimes(1);
    await change('[data-testid="cartographie-refresh"]', (button) => button.click());
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(marker.openPopup).toHaveBeenCalledTimes(1);
    expect(L.layerGroup.mock.results[0].value.removeLayer).not.toHaveBeenCalledWith(marker);

    flight = { ...FLIGHT, latitude: 48.91, title: "Avion AF123 actualisé" };
    await change('[data-testid="cartographie-refresh"]', (button) => button.click());
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(marker.setLatLng).toHaveBeenCalledWith([48.91, 2.4]);
    expect(marker.setPopupContent).toHaveBeenCalled();

    await change('[data-testid="cartographie-radius"]', (select) => {
      select.value = "50";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(global.fetch.mock.calls.at(-1)[0]).toContain("radius_km=50");
    await change('[data-testid="cartographie-kind-avion"]', (box) => box.click());
    expect(titles()).not.toContain("Avion AF123 actualisé");
  } finally {
    jest.useRealTimers();
  }
});

test("shows geopolitical source failures and treats article text as text with approximate locations", async () => {
  jest.useFakeTimers();
  try {
    const article = {
      id: "n1", kind: "actualite", title: "<img src=x onerror=alert(1)>", latitude: 48.9, longitude: 2.4,
      distance_km: 30, date: "2026-05-02T05:00:00Z", location_precision: "country-anchor",
      provider: "Agence", url: "https://example.org/article",
    };
    global.fetch.mockImplementation(async (url) => ({
      ok: true, status: 200,
      json: async () => url.includes("/calques/conflit")
        ? layerPayload([], { ok: false, detail: "Flux indisponible." })
        : url.includes("/calques/actualite") ? layerPayload([article], { ignored: 2 }) : PAYLOAD,
    }));
    await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
    await change('[data-testid="cartographie-kind-conflit"]', (box) => box.click());
    await change('[data-testid="cartographie-kind-actualite"]', (box) => box.click());
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(host.textContent).toContain("Zones de conflit : Flux indisponible.");
    expect(host.textContent).toContain("2 entrée(s) non exploitables ou non localisées");
    expect(host.textContent).toContain("Point indicatif du pays");
    expect(host.querySelector('[data-testid="cartographie-nearby"] img')).toBeNull();
    expect(host.textContent).toContain("actualités et leurs localisations restent à vérifier");
  } finally {
    jest.useRealTimers();
  }
});

test("refreshes enabled layers while visible but not while the page is hidden", async () => {
  jest.useFakeTimers();
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    global.fetch.mockImplementation(async (url) => ({
      ok: true, status: 200,
      json: async () => url.includes("/calques/satellite") ? layerPayload([]) : PAYLOAD,
    }));
    await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
    await change('[data-testid="cartographie-kind-satellite"]', (box) => box.click());
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  } finally {
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else delete document.visibilityState;
    jest.useRealTimers();
  }
});

test("ignores an older layer response after the radius changes", async () => {
  jest.useFakeTimers();
  try {
    const requests = [];
    global.fetch.mockImplementation((url, options) => {
      if (!url.includes("/calques/avion")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => PAYLOAD });
      }
      return new Promise((resolve) => requests.push({ resolve, signal: options.signal }));
    });
    await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
    await change('[data-testid="cartographie-kind-avion"]', (box) => box.click());
    await act(async () => { jest.advanceTimersByTime(250); });
    await change('[data-testid="cartographie-radius"]', (select) => {
      select.value = "50";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(requests[0].signal.aborted).toBe(true);
    await act(async () => { jest.advanceTimersByTime(250); });
    await act(async () => requests[1].resolve({
      ok: true, status: 200, json: async () => layerPayload([{ ...FLIGHT, title: "Position récente" }]),
    }));
    await act(async () => requests[0].resolve({
      ok: true, status: 200, json: async () => layerPayload([{ ...FLIGHT, title: "Position périmée" }]),
    }));
    expect(titles()).toContain("Position récente");
    expect(titles()).not.toContain("Position périmée");
  } finally {
    jest.useRealTimers();
  }
});

test("reports an invalid layer response instead of showing empty success", async () => {
  jest.useFakeTimers();
  try {
    global.fetch.mockImplementation(async (url) => ({
      ok: true, status: 200, json: async () => url.includes("/calques/satellite") ? {} : PAYLOAD,
    }));
    await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
    await change('[data-testid="cartographie-kind-satellite"]', (box) => box.click());
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(host.textContent).toContain("Satellites : Réponse du calque invalide.");
  } finally {
    jest.useRealTimers();
  }
});
