export const WORLD = "monde";

export const KIND_LABELS = { seisme: "Séismes", evenement: "Événements naturels" };

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
  else if (item.type) parts.push(item.type);
  if (item.distance_km !== null && item.distance_km !== undefined) parts.push(`${item.distance_km} km`);
  const date = new Date(item.date);
  if (!Number.isNaN(date.getTime())) {
    parts.push(date.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }));
  }
  parts.push(item.provider);
  return parts.filter(Boolean).join(" · ");
}

export function markerStyle(item) {
  if (item.kind === "seisme") {
    const color = item.magnitude >= 5 ? "#ff5a5a" : item.magnitude >= 4 ? "#ffb347" : "#ffe066";
    return { radius: Math.min(14, 3 + item.magnitude * 1.5), color, fillColor: color, fillOpacity: 0.55, weight: 1 };
  }
  const strong = ["extreme", "severe", "high"].includes(item.severity);
  const color = strong ? "#ff7ad9" : "#91e6f2";
  return { radius: 7, color, fillColor: color, fillOpacity: 0.45, weight: 2 };
}
