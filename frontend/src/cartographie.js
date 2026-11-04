export const WORLD = "monde";
export const RAIN_WMS_URL = "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi";
export const RAIN_LEGEND_URL = "https://gibs.earthdata.nasa.gov/legends/GPM_Precipitation_Rate_H.png";

export const KIND_LABELS = { seisme: "Séismes", evenement: "Événements naturels" };
export const EXTRA_LAYER_LABELS = {
  avion: "Avions",
  satellite: "Satellites",
  conflit: "Zones de conflit",
  actualite: "Actualités internationales",
  maritime: "Ports et passages",
  camera: "Caméras publiques",
};

const LAYER_COLORS = {
  avion: "#69d8ff", satellite: "#c89cff", conflit: "#ff6d74", actualite: "#ffbf69", maritime: "#63e6be",
  camera: "#f28ed4",
};

const EVENT_TYPES_FR = {
  "flood": "Inondation",
  "flood advisory": "Avis d’inondation",
  "flood warning": "Alerte inondation",
  "sea and lake ice": "Glaces de mer et de lac",
  "severe storm": "Tempête violente",
  "storm": "Tempête",
};
const MARITIME_RISK_FR = {
  LOW: "faible", MODERATE: "modéré", MEDIUM: "moyen", ELEVATED: "élevé", HIGH: "fort", CRITICAL: "critique",
};
const MARITIME_CONGESTION_FR = {
  LOW: "faible", MODERATE: "modérée", MEDIUM: "moyenne", ELEVATED: "élevée", HIGH: "forte", CRITICAL: "critique",
};

function eventTypeInFrench(value) {
  if (typeof value !== "string") return value;
  const key = value.toLowerCase();
  return Object.prototype.hasOwnProperty.call(EVENT_TYPES_FR, key) ? EVENT_TYPES_FR[key] : value;
}

function maritimeTextInFrench(value) {
  return value
    .replace(/\bLIVE SHIPS:\s*/gi, "Navires en direct : ")
    .replace(/\bLIVE:\s*/gi, "En direct : ")
    .replace(/\bWAITING:\s*/gi, "En attente : ")
    .replace(/\b(\d+(?:\.\d+)?)M\b/g, (_, amount) => `${amount.replace(".", ",")} M`)
    .replace(/\bbpd oil\b/gi, "barils de pétrole/jour")
    .replace(/\bbpd\b/gi, "barils/jour")
    .replace(/\bTEU\b/gi, "EVP")
    .replace(/\bworld trade\b/gi, "du commerce mondial")
    .replace(/\blarge ships\b/gi, "des grands navires")
    .replace(/\bAlt route\b/gi, "Route alternative à")
    .replace(/\bAlt\b/gi, "Alternative à");
}

export function eventTitle(item) {
  return item.kind === "evenement" ? eventTypeInFrench(item.title) : item.title;
}

export function layerQuery(bounds, origin, radiusKm) {
  if (!bounds || ![bounds.south, bounds.west, bounds.north, bounds.east].every(Number.isFinite)) return null;
  const width = bounds.east - bounds.west;
  if (bounds.north <= bounds.south || width <= 0) return null;
  const south = Math.max(-90, Math.floor(bounds.south * 1000) / 1000);
  const north = Math.min(90, Math.ceil(bounds.north * 1000) / 1000);
  let west = ((bounds.west + 180) % 360 + 360) % 360 - 180;
  let east = west + width;
  west = Math.floor(west * 1000) / 1000;
  east = Math.ceil(east * 1000) / 1000;
  if (east - west >= 360) { west = -180; east = 180; }
  const query = new URLSearchParams({ south, west, north, east });
  if (origin && radiusKm !== WORLD) query.set("radius_km", String(radiusKm));
  return query.toString();
}

export function leafletBounds(bounds) {
  return { south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() };
}

// La longitude ouest de Leaflet peut sortir de [-180, 180] quand la carte est décalée d'un tour.
export function inBounds(bounds, latitude, longitude) {
  if (!bounds) return true;
  if (latitude < bounds.south || latitude > bounds.north) return false;
  if (bounds.east - bounds.west >= 360) return true;
  let x = longitude;
  while (x < bounds.west) x += 360;
  while (x >= bounds.west + 360) x -= 360;
  return x <= bounds.east;
}

export function filterMapEvents(events, { origin, radiusKm, kinds }) {
  const limit = origin && radiusKm !== WORLD ? Number(radiusKm) : null;
  return (events || []).filter((item) => (
    kinds[item.kind] !== false
    && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
    && (limit === null || (item.distance_km !== null && item.distance_km <= limit))
  ));
}

export function nearbyList(events, { bounds, visibleOnly, limit = 30 }) {
  const shown = visibleOnly ? events.filter((item) => inBounds(bounds, item.latitude, item.longitude)) : events;
  const ordered = [...shown].sort((left, right) => (
    left.distance_km !== null && right.distance_km !== null
      ? left.distance_km - right.distance_km
      : String(right.date).localeCompare(String(left.date))
  ));
  return { total: shown.length, items: ordered.slice(0, limit) };
}

export function eventSubtitle(item) {
  const parts = [];
  if (item.kind === "seisme") parts.push(item.place);
  else if (item.kind === "avion") {
    if (Number.isFinite(item.altitude_m)) parts.push(`${Math.round(item.altitude_m)} m d’altitude`);
    if (Number.isFinite(item.speed_knots)) parts.push(`${Math.round(item.speed_knots)} nœuds`);
  } else if (item.kind === "satellite") {
    parts.push("Position calculée");
    if (Number.isFinite(item.altitude_km)) parts.push(`environ ${Math.round(item.altitude_km)} km d’altitude`);
  } else if (item.kind === "conflit") parts.push("Repère indicatif, pas une frontière");
  else if (item.kind === "actualite") {
    const precision = {
      settlement: "Lieu estimé", region: "Région approximative",
      "country-anchor": "Point indicatif du pays", unknown: "Localisation incertaine",
    };
    parts.push(precision[item.location_precision] || "Localisation incertaine");
  } else if (item.kind === "maritime") {
    const labels = { port: "Port", chokepoint: "Passage stratégique", ship: "Navire en direct" };
    parts.push(labels[item.subtype] || "Repère maritime");
    if (item.country) parts.push(item.country);
    if (item.fleet) parts.push(item.fleet);
    if (item.volume) parts.push(maritimeTextInFrench(item.volume));
    if (item.traffic) parts.push(maritimeTextInFrench(item.traffic));
    if (item.risk) parts.push(`Risque ${MARITIME_RISK_FR[item.risk.toUpperCase()] || item.risk.toLowerCase()}`);
    if (item.congestion && item.congestion.toUpperCase() !== "NORMAL") {
      parts.push(`Congestion ${MARITIME_CONGESTION_FR[item.congestion.toUpperCase()] || item.congestion.toLowerCase()}`);
    }
    if (Number.isFinite(item.speed_knots)) parts.push(`${Math.round(item.speed_knots)} nœuds`);
  } else if (item.kind === "camera") {
    if (item.city) parts.push(item.city);
    if (item.country) parts.push(item.country);
    parts.push(item.url ? "Flux public à vérifier" : "Lien du flux indisponible");
  } else if (item.type) parts.push(eventTypeInFrench(item.type));
  if (Number.isFinite(item.distance_km)) {
    const label = item.kind === "satellite" ? "Point au sol à "
      : item.kind === "conflit" || item.kind === "actualite" || item.kind === "maritime" || item.kind === "camera" ? "Repère à " : "";
    parts.push(`${label}${item.distance_km} km`);
  }
  const date = item.date ? new Date(item.date) : null;
  if (date && !Number.isNaN(date.getTime())) {
    const prefix = item.kind === "actualite" ? "Publication " : EXTRA_LAYER_LABELS[item.kind] ? "Flux " : "";
    parts.push(prefix + date.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }));
  }
  parts.push(item.provider);
  return parts.filter(Boolean).join(" · ");
}

export function markerStyle(item) {
  if (LAYER_COLORS[item.kind]) {
    const color = LAYER_COLORS[item.kind];
    return { radius: 5, color, fillColor: color, fillOpacity: 0.75, weight: 1 };
  }
  if (item.kind === "seisme") {
    const color = item.magnitude >= 5 ? "#ff5a5a" : item.magnitude >= 4 ? "#ffb347" : "#ffe066";
    return { radius: Math.min(14, 3 + item.magnitude * 1.5), color, fillColor: color, fillOpacity: 0.55, weight: 1 };
  }
  const strong = ["extreme", "severe", "high"].includes(item.severity);
  const color = strong ? "#ff7ad9" : "#91e6f2";
  return { radius: 7, color, fillColor: color, fillOpacity: 0.45, weight: 2 };
}
