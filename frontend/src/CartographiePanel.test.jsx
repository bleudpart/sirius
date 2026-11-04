import { act } from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import CartographiePanel from "./CartographiePanel";

jest.mock("leaflet", () => {
  const tileLayer = jest.fn();
  tileLayer.wms = jest.fn();
  return {
    __esModule: true,
    default: {
      map: jest.fn(), tileLayer, layerGroup: jest.fn(), circleMarker: jest.fn(), circle: jest.fn(),
      polygon: jest.fn(), marker: jest.fn(), divIcon: jest.fn(), control: { zoom: jest.fn() },
    },
  };
});

// CRA active resetMocks : les implémentations Leaflet sont recréées avant chaque test.
function installLeafletMock() {
  const layer = () => {
    const item = {};
    Object.assign(item, {
      addTo: jest.fn(() => item), bindPopup: jest.fn(() => item), bindTooltip: jest.fn(() => item),
      on: jest.fn(() => item), off: jest.fn(() => item), openPopup: jest.fn(), clearLayers: jest.fn(), removeLayer: jest.fn(),
      setLatLng: jest.fn(() => item), setStyle: jest.fn(() => item), setPopupContent: jest.fn(() => item),
      setLatLngs: jest.fn(() => item), bringToBack: jest.fn(() => item), remove: jest.fn(() => item),
      getBounds: jest.fn(() => ({ circle: true })),
    });
    return item;
  };
  const map = {
    on: jest.fn(), off: jest.fn(), remove: jest.fn(), fitBounds: jest.fn(), getZoom: () => 5, invalidateSize: jest.fn(),
    createPane: jest.fn(() => ({ style: {} })),
    getBounds: () => ({ getSouth: () => 41, getWest: () => -5, getNorth: () => 51.5, getEast: () => 10 }),
  };
  map.setView = jest.fn(() => map);
  L.map.mockImplementation(() => map);
  ["tileLayer", "layerGroup", "circleMarker", "circle", "polygon", "marker"].forEach((name) => L[name].mockImplementation(layer));
  L.tileLayer.wms.mockImplementation(layer);
  L.control.zoom.mockImplementation(layer);
  L.divIcon.mockImplementation((options) => options);
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
    kind: options.kind || null, counts: options.counts,
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

test("displays and reads known event titles in French without changing the source", async () => {
  const onSpeak = jest.fn();
  const event = { ...EVENTS[2], type: "Flood Warning", distance_km: 10, latitude: 48.9, longitude: 2.4 };
  global.fetch.mockImplementation(async () => ({
    ok: true, status: 200, json: async () => ({ ...PAYLOAD, events: [event], sources: [] }),
  }));
  await act(async () => root.render(<CartographiePanel onClose={jest.fn()} onSpeak={onSpeak} />));
  expect(titles()).toEqual(["Alerte inondation"]);
  const popup = L.circleMarker.mock.results
    .map((result) => result.value.bindPopup.mock.calls[0]?.[0]).find(Boolean);
  expect(popup.querySelector("strong").textContent).toBe("Alerte inondation");
  await change(".carto-float-title", (button) => button.click());
  expect(onSpeak.mock.calls[0][0]).toContain("Alerte inondation");
  expect(event.title).toBe("Flood Warning");
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

test("labels map zoom controls and popup close buttons in French", async () => {
  await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
  const map = L.map.mock.results[0].value;
  expect(L.map).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ zoomControl: false }));
  expect(L.control.zoom).toHaveBeenCalledWith({ zoomInTitle: "Zoom avant", zoomOutTitle: "Zoom arrière" });
  expect(L.control.zoom.mock.results[0].value.addTo).toHaveBeenCalledWith(map);

  const labelPopup = map.on.mock.calls.find(([event]) => event === "popupopen")[1];
  const container = document.createElement("div");
  container.innerHTML = '<a class="leaflet-popup-close-button" aria-label="Close popup"></a>';
  labelPopup({ popup: { getElement: () => container } });
  expect(container.firstChild.getAttribute("aria-label")).toBe("Fermer la fiche");
  expect(() => labelPopup({ popup: { getElement: () => null } })).not.toThrow();

  await act(async () => root.unmount());
  expect(map.off).toHaveBeenCalledWith("popupopen", labelPopup);
  root = createRoot(host);
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
      json: async () => url.includes("/calques/maritime")
        ? layerPayload([], { ok: false, detail: "Flux OSIRIS trop ancien." })
        : url.includes("/calques/conflit")
        ? layerPayload([], { ok: false, detail: "Flux indisponible." })
        : url.includes("/calques/actualite") ? layerPayload([article], { ignored: 2 }) : PAYLOAD,
    }));
    await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
    await change('[data-testid="cartographie-kind-conflit"]', (box) => box.click());
    await change('[data-testid="cartographie-kind-actualite"]', (box) => box.click());
    await change('[data-testid="cartographie-kind-maritime"]', (box) => box.click());
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(host.textContent).toContain("Zones de conflit : Flux indisponible.");
    expect(host.textContent).toContain("Ports et passages : Flux OSIRIS trop ancien.");
    expect(host.textContent).toContain("2 entrée(s) non exploitables ou non localisées");
    expect(host.textContent).toContain("Point indicatif du pays");
    expect(host.querySelector('[data-testid="cartographie-nearby"] img')).toBeNull();
    expect(host.textContent).toContain("actualités et leurs localisations restent à vérifier");
  } finally {
    jest.useRealTimers();
  }
});

test("loads maritime ports and passages and reports live ships separately", async () => {
  jest.useFakeTimers();
  try {
    const port = {
      id: "port:Le Havre", kind: "maritime", subtype: "port", title: "Le Havre",
      latitude: 49.49, longitude: 0.1, distance_km: 180, date: "2026-05-02T05:00:00Z",
      country: "FR", volume: "14.5M TEU", provider: "OSIRIS — données maritimes",
    };
    const passage = {
      id: "chokepoint:Pas de Calais", kind: "maritime", subtype: "chokepoint",
      title: "Passage stratégique : Pas de Calais", latitude: 50.96, longitude: 1.85,
      distance_km: 240, date: "2026-05-02T05:00:00Z", traffic: "90M tonnes", risk: "LOW",
      provider: "OSIRIS — données maritimes",
    };
    global.fetch.mockImplementation(async (url) => ({
      ok: true, status: 200,
      json: async () => url.includes("/calques/maritime")
        ? layerPayload([port, passage], { kind: "maritime", counts: { port: 1, chokepoint: 1, ship: 0 } })
        : PAYLOAD,
    }));
    await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
    await change('[data-testid="cartographie-kind-maritime"]', (box) => box.click());
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(global.fetch.mock.calls.at(-1)[0]).toContain("/veille/carte/calques/maritime?");
    expect(titles()).toContain("Le Havre");
    expect(titles()).toContain("Passage stratégique : Pas de Calais");
    expect(host.textContent).toContain("1 port(s), 1 passage(s), 0 navire(s) en direct dans la zone");
    expect(host.textContent).toContain("90 M tonnes · Risque faible");
  } finally {
    jest.useRealTimers();
  }
});

test("opens camera previews only on request and reports unavailable images", async () => {
  jest.useFakeTimers();
  try {
    const camera = {
      id: "c1", kind: "camera", title: "Caméra : Paris", latitude: 48.9, longitude: 2.4,
      distance_km: 40, date: "2026-05-02T05:00:00Z", city: "Paris", country: "FR",
      provider: "OSIRIS — Source", url: "https://example.org/live", preview_url: "https://example.org/camera.jpg",
    };
    global.fetch.mockImplementation(async (url) => ({
      ok: true, status: 200,
      json: async () => url.includes("/calques/camera") ? layerPayload([camera]) : PAYLOAD,
    }));
    await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
    await change('[data-testid="cartographie-kind-camera"]', (box) => box.click());
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(titles()).toContain("Caméra : Paris");
    expect(host.querySelector('[data-testid="cartographie-camera-privacy"]').textContent).toContain("adresse IP");
    const marker = L.circleMarker.mock.results.map((result) => result.value)
      .find((item) => item.bindPopup.mock.calls[0]?.[0].textContent.startsWith("Caméra : Paris"));
    const popup = marker.bindPopup.mock.calls[0][0];
    expect(popup.querySelector("img")).toBeNull();
    expect(popup.querySelector("a").textContent).toBe("Ouvrir le flux");
    expect(popup.querySelector("a").rel).toBe("noopener noreferrer");
    popup.querySelector("button").click();
    const image = popup.querySelector("img");
    expect(image.src).toBe("https://example.org/camera.jpg");
    expect(image.referrerPolicy).toBe("no-referrer");
    image.dispatchEvent(new Event("error"));
    expect(popup.textContent).toContain("Aperçu indisponible");
    expect(popup.querySelector("img")).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test("adds, refreshes and removes the locally calculated night layer", async () => {
  jest.useFakeTimers();
  try {
    await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
    expect(L.polygon).not.toHaveBeenCalled();
    await change('[data-testid="cartographie-night"]', (box) => box.click());
    expect(L.polygon).toHaveBeenCalledTimes(1);
    const shade = L.polygon.mock.results[0].value;
    expect(shade.bringToBack).toHaveBeenCalled();
    expect(host.textContent).toContain("calculée localement");
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(shade.setLatLngs).toHaveBeenCalledTimes(1);
    await change('[data-testid="cartographie-night"]', (box) => box.click());
    expect(shade.remove).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(shade.setLatLngs).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test("loads wind vectors on demand, changes forecast time and removes the layer", async () => {
  jest.useFakeTimers();
  try {
    const times = ["2026-05-02T06:00:00+00:00", "2026-05-02T09:00:00+00:00"];
    global.fetch.mockImplementation(async (url) => {
      if (!url.includes("/carte/vent?")) return { ok: true, status: 200, json: async () => PAYLOAD };
      const selected = new URL(url, "https://sirius.test").searchParams.get("t") || times[0];
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: "vent", source: { ok: true }, run: "2026-05-02T00:00:00+00:00", times, time: selected, ignored: 0,
          points: [{ latitude: 48.9, longitude: 2.4, east_ms: 3, north_ms: 0, speed_kmh: 10.8 }],
        }),
      };
    });
    await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
    expect(global.fetch.mock.calls.some(([url]) => url.includes("/carte/vent?"))).toBe(false);
    await change('[data-testid="cartographie-wind"]', (box) => box.click());
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(L.marker).toHaveBeenCalledTimes(1);
    expect(L.divIcon.mock.calls[0][0].html).toContain("rotate(90.0deg)");
    expect(host.textContent).toContain("NOAA GFS");
    expect(host.textContent).toContain("pas une mesure en direct");
    expect(host.querySelector('[data-testid="cartographie-wind-time"]').value).toBe(times[0]);
    const firstWindGroup = L.layerGroup.mock.results[1].value;
    await change('[aria-label="Horaire suivant"]', (button) => button.click());
    expect(firstWindGroup.remove).toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(250); });
    const request = global.fetch.mock.calls.at(-1)[0];
    expect(new URL(request, "https://sirius.test").searchParams.get("t")).toBe(times[1]);
    expect(host.querySelector('[data-testid="cartographie-wind-time"]').value).toBe(times[1]);
    const secondWindGroup = L.layerGroup.mock.results[2].value;
    await change('[data-testid="cartographie-wind"]', (box) => box.click());
    expect(secondWindGroup.remove).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="cartographie-wind-time"]')).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test("reports a wind source failure and does not display invented vectors", async () => {
  jest.useFakeTimers();
  try {
    const onSpeak = jest.fn();
    global.fetch.mockImplementation(async (url) => ({
      ok: true, status: 200,
      json: async () => url.includes("/carte/vent?")
        ? { kind: "vent", source: { ok: false, detail: "Vent indisponible." }, times: [], points: [] }
        : { ...PAYLOAD, sources: [{ id: "evenements", ok: true }, { id: "seismes", ok: true }] },
    }));
    await act(async () => root.render(<CartographiePanel onClose={jest.fn()} onSpeak={onSpeak} />));
    await change('[data-testid="cartographie-wind"]', (box) => box.click());
    await act(async () => { jest.advanceTimersByTime(250); });
    expect(host.textContent).toContain("Vent : Vent indisponible.");
    expect(L.marker).not.toHaveBeenCalled();
    await change(".carto-float-title", (button) => button.click());
    expect(onSpeak.mock.calls[0][0]).toContain("Certaines sources sont indisponibles");
  } finally {
    jest.useRealTimers();
  }
});

test("loads delayed NASA rain only on demand and controls the actual image time", async () => {
  const times = ["2026-05-01T10:00:00Z", "2026-05-01T10:30:00Z"];
  global.fetch.mockImplementation(async (url) => ({
    ok: true, status: 200,
    json: async () => url.endsWith("/carte/pluie")
      ? { kind: "pluie", source: { ok: true }, latest: times[1], times }
      : PAYLOAD,
  }));
  await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
  expect(global.fetch.mock.calls.some(([url]) => url.endsWith("/carte/pluie"))).toBe(false);
  expect(L.tileLayer.wms).not.toHaveBeenCalled();
  expect(host.textContent).toContain("NASA reçoit l’adresse IP et la zone affichée");
  await change('[data-testid="cartographie-rain"]', (box) => box.click());
  expect(global.fetch.mock.calls.at(-1)[0]).toMatch(/\/veille\/carte\/pluie$/);
  expect(L.tileLayer.wms).toHaveBeenCalledTimes(1);
  const options = L.tileLayer.wms.mock.calls[0][1];
  expect(options).toEqual(expect.objectContaining({
    layers: "IMERG_Precipitation_Rate_30min", time: times[1], transparent: true, pane: "sirius-rain",
  }));
  expect(host.textContent).toContain("pas un radar en direct");
  expect(host.textContent).toContain("donnée absente");
  expect(host.textContent).toContain("Échelle du haut : pluie ; échelle du bas : neige.");
  const legend = host.querySelector(".carto-rain-legend img");
  expect(legend.getAttribute("referrerpolicy")).toBe("no-referrer");
  await act(async () => legend.dispatchEvent(new Event("error")));
  expect(host.textContent).toContain("Légende NASA indisponible.");
  const firstLayer = L.tileLayer.wms.mock.results[0].value;
  const tileError = firstLayer.on.mock.calls.find(([event]) => event === "tileerror")[1];
  await act(async () => tileError());
  expect(host.textContent).toContain("certaines tuiles sont indisponibles");
  await change('[aria-label="Image précédente"]', (button) => button.click());
  expect(firstLayer.remove).toHaveBeenCalled();
  expect(L.tileLayer.wms.mock.calls[1][1].time).toBe(times[0]);
  expect(host.querySelector('[data-testid="cartographie-rain-time"]').value).toBe(times[0]);
  expect(host.textContent).not.toContain("certaines tuiles sont indisponibles");
  expect(host.textContent).not.toContain("Légende NASA indisponible.");
  const latest = [...host.querySelectorAll("button")].find((button) => button.textContent === "Plus récente");
  await act(async () => latest.click());
  expect(L.tileLayer.wms.mock.calls[2][1].time).toBe(times[1]);
  const latestLayer = L.tileLayer.wms.mock.results[2].value;
  await change('[data-testid="cartographie-rain"]', (box) => box.click());
  expect(latestLayer.remove).toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Légende de pluie NASA"]')).toBeNull();
});

test("reports NASA metadata failure without showing a stale image", async () => {
  global.fetch.mockImplementation(async (url) => ({
    ok: true, status: 200,
    json: async () => url.endsWith("/carte/pluie")
      ? { kind: "pluie", source: { ok: false, detail: "NASA indisponible." }, latest: null, times: [] }
      : PAYLOAD,
  }));
  await act(async () => root.render(<CartographiePanel onClose={jest.fn()} />));
  await change('[data-testid="cartographie-rain"]', (box) => box.click());
  expect(host.textContent).toContain("Pluie NASA : NASA indisponible.");
  expect(L.tileLayer.wms).not.toHaveBeenCalled();
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
