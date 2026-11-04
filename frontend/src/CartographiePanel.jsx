// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { X, Radar, RefreshCw, Loader2, ExternalLink, ChevronDown, ChevronUp, Crosshair } from "lucide-react";
import "./Cartographie.css";
import { API_BASE_URL } from "./lib/api";
import { OSIRIS_MAP_URL } from "./domainOsint";
import useCartographieLayer from "./useCartographieLayer";
import useCartographiePluie from "./useCartographiePluie";
import useCartographieVent from "./useCartographieVent";
import { nightPolygons } from "./cartographieSoleil";
import {
  EXTRA_LAYER_LABELS, KIND_LABELS, RAIN_LEGEND_URL, RAIN_WMS_URL, WORLD, eventSubtitle, eventTitle, filterMapEvents, inBounds, layerQuery,
  leafletBounds, markerStyle, nearbyList,
} from "./cartographie";

const FRANCE = [46.6, 2.4];
const EMPTY_POINTS = [];
const REFRESH_INTERVAL_MS = 60_000;

function itemKey(item) {
  return item.id ? `${item.kind}:${item.id}` : `${item.kind}:${item.latitude}:${item.longitude}:${item.date}:${item.title}`;
}

function itemSignature(item) {
  return JSON.stringify([item.latitude, item.longitude, item.title, eventSubtitle(item), item.url, item.preview_url, markerStyle(item)]);
}

function LayerStatus({ label, state }) {
  if (!state) return <span>{label} : en attente de la carte…</span>;
  if (state.pending) return <span>{label} : actualisation…</span>;
  if (state.error) return <span className="carto-layer-error" role="alert">{label} : {state.error}</span>;
  const { result } = state;
  const stamp = result.source.updated_at ? new Date(result.source.updated_at) : null;
  const updated = stamp && !Number.isNaN(stamp.getTime())
    ? ` · flux ${stamp.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" })}`
    : "";
  return (
    <span>
      {label} : {result.items.length} affiché(s) sur {result.total} dans la zone{updated}
      {result.kind === "maritime" && result.counts
        ? ` · ${result.counts.port} port(s), ${result.counts.chokepoint} passage(s), ${result.counts.ship} navire(s) en direct dans la zone`
        : ""}
      {result.truncated ? " · liste limitée, zoome pour plus de détails" : ""}
      {result.ignored ? ` · ${result.ignored} entrée(s) non exploitables ou non localisées` : ""}
    </span>
  );
}

function windTime(value) {
  return new Date(value).toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris",
  });
}

function WindStatus({ state }) {
  if (!state) return <span>Vent : en attente de la carte…</span>;
  if (state.pending) return <span>Vent : actualisation…</span>;
  if (state.error) return <span className="carto-layer-error" role="alert">Vent : {state.error}</span>;
  return (
    <span>
      Vent à 10 m : {state.points.length} repère(s) · NOAA GFS · échéance {windTime(state.result.time)}
      {" "}· cycle {windTime(state.result.run)}
      {state.result.ignored ? ` · ${state.result.ignored} vecteur(s) indisponible(s)` : ""}
    </span>
  );
}

function RainStatus({ state, selectedTime, tileError }) {
  if (!state || (state.pending && !state.result)) return <span>Pluie NASA : recherche des images…</span>;
  if (state.error) return <span className="carto-layer-error" role="alert">Pluie NASA : {state.error}</span>;
  if (!state.result.times.includes(selectedTime)) {
    return <span className="carto-layer-error" role="alert">Pluie NASA : cet horaire n’est plus disponible ; choisis-en un autre.</span>;
  }
  const delay = (Date.now() - Date.parse(selectedTime)) / 3_600_000;
  const age = delay >= 0 ? `image vieille d’environ ${delay.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} h`
    : "horaire futur : vérifie l’horloge";
  return (
    <span className={tileError ? "carto-layer-error" : ""} role={tileError ? "alert" : undefined}>
      Pluie satellite NASA : {windTime(selectedTime)} · {age}, pas un radar en direct
      {tileError ? " · certaines tuiles sont indisponibles" : ""}
    </span>
  );
}

function windIcon(point) {
  const angle = Math.atan2(point.east_ms, point.north_ms) * 180 / Math.PI;
  const color = point.speed_kmh < 20 ? "#b8f4fc" : point.speed_kmh < 50 ? "#80db8d"
    : point.speed_kmh < 90 ? "#ffcc70" : "#ff7878";
  const symbol = point.speed_kmh < 0.1 ? "•" : "↑";
  return L.divIcon({
    className: "carto-wind-icon", iconSize: [22, 22], iconAnchor: [11, 11],
    html: `<span class="carto-wind-arrow" style="color:${color};transform:rotate(${angle.toFixed(1)}deg)">${symbol}</span>`,
  });
}

function popupNode(item) {
  const box = document.createElement("div");
  box.className = "carto-popup";
  const title = document.createElement("strong");
  title.textContent = eventTitle(item);
  const detail = document.createElement("span");
  detail.textContent = eventSubtitle(item);
  box.append(title, detail);
  if (item.kind === "camera" && item.preview_url) {
    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.textContent = "Afficher l’aperçu";
    previewButton.addEventListener("click", () => {
      previewButton.disabled = true;
      const image = document.createElement("img");
      image.alt = `Aperçu : ${item.title}`;
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => {
        image.remove();
        const message = document.createElement("span");
        message.textContent = "Aperçu indisponible auprès de la source.";
        box.append(message);
      }, { once: true });
      image.src = item.preview_url;
      box.append(image);
    }, { once: true });
    box.append(previewButton);
  }
  if (item.url) {
    const link = document.createElement("a");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.kind === "camera" ? "Ouvrir le flux" : "Source officielle";
    box.append(link);
  }
  return box;
}

export default function CartographiePanel({ onClose, onSpeak }) {
  const mapNode = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const circleRef = useRef(null);
  const originMarkerRef = useRef(null);
  const markersRef = useRef(new Map());
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [radiusKm, setRadiusKm] = useState(300);
  const [visibleOnly, setVisibleOnly] = useState(false);
  const [kinds, setKinds] = useState({
    seisme: true, evenement: true, avion: false, satellite: false, conflit: false, actualite: false,
    maritime: false, camera: false,
  });
  const [nightEnabled, setNightEnabled] = useState(false);
  const [windEnabled, setWindEnabled] = useState(false);
  const [rainEnabled, setRainEnabled] = useState(false);
  const [rainTileError, setRainTileError] = useState(false);
  const [rainLegendError, setRainLegendError] = useState(false);
  const [bounds, setBounds] = useState(null);
  const [floatingOpen, setFloatingOpen] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const radiusInitialized = useRef(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/veille/carte`, { credentials: "include" });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) throw new Error("Connecte-toi pour afficher la carte des événements.");
      if (!response.ok) throw new Error(body.detail || "Carte des événements indisponible.");
      setData(body);
      if (!body.origin) setRadiusKm(WORLD);
      else if (!radiusInitialized.current) setRadiusKm(body.default_radius_km || 300);
      radiusInitialized.current = Boolean(body.origin);
    } catch (failure) {
      setError(failure.message === "Failed to fetch" ? "Serveur ΣIRIUS injoignable." : failure.message);
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!nightEnabled || !mapRef.current) return undefined;
    const shade = L.polygon(nightPolygons(new Date()), {
      interactive: false, stroke: false, fillColor: "#000929", fillOpacity: 0.35,
    }).addTo(mapRef.current);
    shade.bringToBack();
    const timer = setInterval(() => shade.setLatLngs(nightPolygons(new Date())), REFRESH_INTERVAL_MS);
    return () => { clearInterval(timer); shade.remove(); };
  }, [nightEnabled]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const map = L.map(mapNode.current, {
      worldCopyJump: true, minZoom: 2, preferCanvas: true, zoomControl: false,
    }).setView(FRANCE, 5);
    const markers = markersRef.current;
    L.control.zoom({ zoomInTitle: "Zoom avant", zoomOutTitle: "Zoom arrière" }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
    }).addTo(map);
    const rainPane = map.createPane("sirius-rain");
    rainPane.style.zIndex = "250";
    rainPane.style.pointerEvents = "none";
    layerRef.current = L.layerGroup().addTo(map);
    const track = () => {
      const next = leafletBounds(map.getBounds());
      setBounds((previous) => previous && ["south", "west", "north", "east"]
        .every((key) => Math.abs(previous[key] - next[key]) < 0.0000001) ? previous : next);
    };
    const labelPopup = ({ popup }) => {
      const closeButton = popup.getElement()?.querySelector(".leaflet-popup-close-button");
      if (closeButton) closeButton.setAttribute("aria-label", "Fermer la fiche");
    };
    map.on("moveend", track);
    map.on("popupopen", labelPopup);
    track();
    mapRef.current = map;
    // La fenêtre s'anime à l'ouverture et peut être agrandie : Leaflet doit relire la taille du conteneur.
    const resize = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => { map.invalidateSize(); track(); })
      : null;
    resize?.observe(mapNode.current);
    return () => {
      resize?.disconnect();
      map.off("moveend", track);
      map.off("popupopen", labelPopup);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      originMarkerRef.current = null;
      circleRef.current = null;
      markers.clear();
    };
  }, []);

  const origin = data?.origin || null;
  const originKey = origin ? `${origin.latitude},${origin.longitude}` : "";
  const query = useMemo(() => layerQuery(bounds, origin, radiusKm), [bounds, origin, radiusKm]);
  const avionLayer = useCartographieLayer("avion", kinds.avion, query, refreshVersion);
  const satelliteLayer = useCartographieLayer("satellite", kinds.satellite, query, refreshVersion);
  const conflitLayer = useCartographieLayer("conflit", kinds.conflit, query, refreshVersion);
  const actualiteLayer = useCartographieLayer("actualite", kinds.actualite, query, refreshVersion);
  const maritimeLayer = useCartographieLayer("maritime", kinds.maritime, query, refreshVersion);
  const cameraLayer = useCartographieLayer("camera", kinds.camera, query, refreshVersion);
  const wind = useCartographieVent(windEnabled, query, refreshVersion);
  const rain = useCartographiePluie(rainEnabled, refreshVersion);
  const windTimes = wind.state?.result?.times || EMPTY_POINTS;
  const windSelection = wind.selectedTime || wind.state?.result?.time || "";
  const windIndex = windTimes.indexOf(windSelection);
  const rainTimes = rain.state?.result?.times || EMPTY_POINTS;
  const rainSelection = rain.selectedTime || rain.state?.result?.latest || "";
  const rainIndex = rainTimes.indexOf(rainSelection);
  const layers = {
    avion: avionLayer, satellite: satelliteLayer, conflit: conflitLayer, actualite: actualiteLayer,
    maritime: maritimeLayer, camera: cameraLayer,
  };
  const extraActive = Object.keys(EXTRA_LAYER_LABELS).some((kind) => kinds[kind]);
  const extraPoints = useMemo(() => [
    ...(avionLayer?.items || EMPTY_POINTS), ...(satelliteLayer?.items || EMPTY_POINTS),
    ...(conflitLayer?.items || EMPTY_POINTS), ...(actualiteLayer?.items || EMPTY_POINTS),
    ...(maritimeLayer?.items || EMPTY_POINTS), ...(cameraLayer?.items || EMPTY_POINTS),
  ].filter((item) => inBounds(bounds, item.latitude, item.longitude)), [
    avionLayer?.items, satelliteLayer?.items, conflitLayer?.items, actualiteLayer?.items,
    maritimeLayer?.items, cameraLayer?.items, bounds,
  ]);
  const shown = useMemo(
    () => filterMapEvents([...(data?.events || EMPTY_POINTS), ...extraPoints], { origin, radiusKm, kinds }),
    [data, extraPoints, origin, radiusKm, kinds],
  );
  const nearby = useMemo(() => nearbyList(shown, { bounds, visibleOnly }), [shown, bounds, visibleOnly]);

  useEffect(() => {
    if (!extraActive && !windEnabled && !rainEnabled) return undefined;
    const refreshVisible = () => {
      if (document.visibilityState !== "hidden") setRefreshVersion((current) => current + 1);
    };
    const timer = setInterval(refreshVisible, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [extraActive, windEnabled, rainEnabled]);

  useEffect(() => {
    setRainTileError(false);
    setRainLegendError(false);
    if (!rainEnabled || !mapRef.current || rainIndex < 0) return undefined;
    let active = true;
    const layer = L.tileLayer.wms(RAIN_WMS_URL, {
      layers: "IMERG_Precipitation_Rate_30min", format: "image/png", transparent: true,
      version: "1.1.1", time: rainSelection, pane: "sirius-rain", opacity: 0.75,
      referrerPolicy: "no-referrer",
      attribution: 'Images NASA <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener noreferrer">GIBS / ESDIS</a>',
    });
    const onLoading = () => { if (active) setRainTileError(false); };
    const onError = () => { if (active) setRainTileError(true); };
    layer.on("loading", onLoading);
    layer.on("tileerror", onError);
    layer.addTo(mapRef.current);
    return () => {
      active = false;
      layer.off("loading", onLoading);
      layer.off("tileerror", onError);
      layer.remove();
    };
  }, [rainEnabled, rainSelection, rainIndex]);

  useEffect(() => {
    if (!windEnabled || !mapRef.current || !wind.state?.points?.length) return undefined;
    const group = L.layerGroup().addTo(mapRef.current);
    wind.state.points.forEach((point) => {
      L.marker([point.latitude, point.longitude], { icon: windIcon(point), keyboard: false })
        .bindTooltip(`Vent estimé : ${point.speed_kmh.toLocaleString("fr-FR")} km/h · direction de la flèche`)
        .addTo(group);
    });
    return () => group.remove();
  }, [windEnabled, wind.state?.points]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    if (originMarkerRef.current) layer.removeLayer(originMarkerRef.current);
    if (circleRef.current) layer.removeLayer(circleRef.current);
    originMarkerRef.current = null;
    circleRef.current = null;
    if (origin) {
      const center = [origin.latitude, origin.longitude];
      originMarkerRef.current = L.circleMarker(center, { radius: 6, color: "#ffffff", fillColor: "#ffffff", fillOpacity: 1, weight: 2 })
        .bindTooltip(`${origin.name} — établissement`).addTo(layer);
      if (radiusKm !== WORLD) {
        circleRef.current = L.circle(center, {
          radius: Number(radiusKm) * 1000, color: "#91e6f2", weight: 1, fillOpacity: 0.04, dashArray: "6 6",
        }).addTo(layer);
      }
    }
  }, [origin, radiusKm]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const markers = markersRef.current;
    const wanted = new Set(shown.map(itemKey));
    markers.forEach((entry, key) => {
      if (!wanted.has(key)) {
        layer.removeLayer(entry.marker);
        markers.delete(key);
      }
    });
    shown.forEach((item) => {
      const key = itemKey(item);
      const signature = itemSignature(item);
      const existing = markers.get(key);
      if (!existing) {
        const marker = L.circleMarker([item.latitude, item.longitude], markerStyle(item))
          .bindPopup(popupNode(item)).addTo(layer);
        markers.set(key, { marker, signature, latitude: item.latitude, longitude: item.longitude });
      } else if (existing.signature !== signature) {
        if (existing.latitude !== item.latitude || existing.longitude !== item.longitude) {
          existing.marker.setLatLng([item.latitude, item.longitude]);
        }
        existing.marker.setStyle(markerStyle(item));
        existing.marker.setPopupContent(popupNode(item));
        markers.set(key, { marker: existing.marker, signature, latitude: item.latitude, longitude: item.longitude });
      }
    });
  }, [shown]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !originKey) return;
    const [latitude, longitude] = originKey.split(",").map(Number);
    if (circleRef.current) map.fitBounds(circleRef.current.getBounds(), { padding: [20, 20] });
    else map.setView([latitude, longitude], 3);
  }, [originKey, radiusKm]);

  const focus = (item) => {
    const map = mapRef.current;
    const key = itemKey(item);
    const marker = markersRef.current.get(key)?.marker;
    if (!map || !marker) return;
    map.setView([item.latitude, item.longitude], Math.max(map.getZoom(), 7));
    marker.openPopup();
  };

  const recenter = () => {
    const map = mapRef.current;
    if (!map) return;
    if (circleRef.current) map.fitBounds(circleRef.current.getBounds(), { padding: [20, 20] });
    else if (origin) map.setView([origin.latitude, origin.longitude], 6);
    else map.setView(FRANCE, 5);
  };

  const announce = () => {
    const count = nearby.total;
    const noun = extraActive ? "élément" : "événement";
    const zone = extraActive ? "selon les filtres affichés"
      : visibleOnly ? "dans la zone affichée" : radiusKm === WORLD || !origin ? "dans le monde" : `à moins de ${radiusKm} km`;
    const incomplete = (data?.sources || []).some((source) => !source.ok)
      || Object.keys(EXTRA_LAYER_LABELS).some((kind) => kinds[kind] && layers[kind]?.error)
      || (windEnabled && wind.state?.error)
      || (rainEnabled && (rain.state?.error || rainTileError || rainLegendError || (rain.state?.result && rainIndex < 0)));
    const warning = incomplete ? " Certaines sources sont indisponibles." : "";
    onSpeak && onSpeak(count
      ? `${count} ${noun}${count > 1 ? "s" : ""} ${zone}. ${origin ? "Le plus proche" : "Premier élément"} : ${eventTitle(nearby.items[0])}.${warning}`
      : `Aucun ${noun} affiché ${zone} dans les données disponibles.${warning}`);
  };

  const failed = (data?.sources || []).filter((source) => !source.ok);
  const refresh = () => { load(); setRefreshVersion((current) => current + 1); };

  return (
    <div className="prime-screen carto-screen" data-testid="cartographie-panel">
      <header className="zeus-head">
        <div className="oracle-title font-divine" data-module-name="CARTOGRAPHIE">
          <Radar size={20} /> CARTOGRAPHIE <span className="module-function">— CARTE OSIRIS</span>
        </div>
        <button className="setup-close zeus-close" onClick={onClose} aria-label="Fermer la cartographie" data-testid="cartographie-close"><X size={18} /></button>
      </header>

      <div className="carto-toolbar" role="group" aria-label="Filtres de la carte">
        <label>
          RAYON
          <select value={String(radiusKm)} disabled={!origin} data-testid="cartographie-radius"
            onChange={(event) => setRadiusKm(event.target.value === WORLD ? WORLD : Number(event.target.value))}>
            {(data?.radii_km || [50, 100, 300, 1000]).map((km) => <option key={km} value={km}>{km} km</option>)}
            <option value={WORLD}>Monde entier</option>
          </select>
        </label>
        <label className="carto-check">
          <input type="checkbox" checked={visibleOnly} onChange={(event) => setVisibleOnly(event.target.checked)} data-testid="cartographie-visible" />
          Zone visible uniquement
        </label>
        {Object.entries(KIND_LABELS).map(([kind, label]) => (
          <label className="carto-check" key={kind}>
            <input type="checkbox" checked={kinds[kind]} data-testid={`cartographie-kind-${kind}`}
              onChange={(event) => setKinds((current) => ({ ...current, [kind]: event.target.checked }))} />
            {label}
          </label>
        ))}
        <button className="her-go" onClick={recenter} type="button"><Crosshair size={13} /> RECENTRER</button>
        <button className="her-go" onClick={refresh} disabled={busy} type="button" data-testid="cartographie-refresh">
          {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} ACTUALISER
        </button>
        <a className="carto-osiris" href={OSIRIS_MAP_URL} target="_blank" rel="noopener noreferrer">
          Carte OSIRIS complète <ExternalLink size={12} />
        </a>
      </div>

      <div className="carto-layer-toolbar" role="group" aria-label="Calques complémentaires">
        <span>CALQUES</span>
        {Object.entries(EXTRA_LAYER_LABELS).map(([kind, label]) => (
          <label className="carto-check" key={kind}>
            <input type="checkbox" checked={kinds[kind]} data-testid={`cartographie-kind-${kind}`}
              onChange={(event) => setKinds((current) => ({ ...current, [kind]: event.target.checked }))} />
            <span className={`carto-dot ${kind}`} aria-hidden="true" /> {label}
          </label>
        ))}
        <label className="carto-check">
          <input type="checkbox" checked={nightEnabled} data-testid="cartographie-night"
            onChange={(event) => setNightEnabled(event.target.checked)} />
          Jour / nuit
        </label>
        <label className="carto-check">
          <input type="checkbox" checked={windEnabled} data-testid="cartographie-wind"
            onChange={(event) => setWindEnabled(event.target.checked)} />
          Vent
        </label>
        {windEnabled && (
          <div className="carto-wind-controls">
            <label>
              Horaire
              <select aria-label="Horaire du vent" data-testid="cartographie-wind-time"
                value={windSelection} disabled={!windTimes.length}
                onChange={(event) => wind.setSelectedTime(event.target.value)}>
                {windIndex < 0 && <option value={windSelection}>Choisir un horaire</option>}
                {windTimes.map((time) => <option value={time} key={time}>{windTime(time)}</option>)}
              </select>
            </label>
            <button type="button" aria-label="Horaire précédent" disabled={windIndex <= 0}
              onClick={() => wind.setSelectedTime(windTimes[windIndex - 1])}>‹</button>
            <button type="button" aria-label="Horaire suivant" disabled={windIndex < 0 || windIndex >= windTimes.length - 1}
              onClick={() => wind.setSelectedTime(windTimes[windIndex + 1])}>›</button>
          </div>
        )}
        <label className="carto-check">
          <input type="checkbox" checked={rainEnabled} data-testid="cartographie-rain"
            onChange={(event) => setRainEnabled(event.target.checked)} />
          Pluie NASA (différée)
        </label>
        <small className="carto-rain-privacy">NASA reçoit l’adresse IP et la zone affichée si le calque est activé.</small>
        {rainEnabled && (
          <div className="carto-wind-controls">
            <label>
              Image
              <select aria-label="Horaire de la pluie" data-testid="cartographie-rain-time"
                value={rainSelection} disabled={!rainTimes.length}
                onChange={(event) => rain.setSelectedTime(event.target.value)}>
                {rainIndex < 0 && <option value={rainSelection}>Choisir un horaire</option>}
                {rainTimes.map((time) => <option value={time} key={time}>{windTime(time)}</option>)}
              </select>
            </label>
            <button type="button" aria-label="Image précédente" disabled={rainIndex <= 0}
              onClick={() => rain.setSelectedTime(rainTimes[rainIndex - 1])}>‹</button>
            <button type="button" aria-label="Image suivante" disabled={rainIndex < 0 || rainIndex >= rainTimes.length - 1}
              onClick={() => rain.setSelectedTime(rainTimes[rainIndex + 1])}>›</button>
            <button type="button" disabled={!rainTimes.length || !rain.selectedTime}
              onClick={() => rain.setSelectedTime("")}>Plus récente</button>
          </div>
        )}
      </div>
      {(extraActive || windEnabled || rainEnabled) && (
        <div className="carto-layer-status" aria-live="polite">
          {Object.entries(EXTRA_LAYER_LABELS).filter(([kind]) => kinds[kind]).map(([kind, label]) => (
            <LayerStatus key={kind} label={label} state={layers[kind]} />
          ))}
          {windEnabled && <WindStatus state={wind.state} />}
          {rainEnabled && <RainStatus state={rain.state} selectedTime={rainSelection} tileError={rainTileError} />}
        </div>
      )}

      {error && <p className="her-error" role="alert" data-testid="cartographie-error">{error}</p>}
      {kinds.camera && (
        <p className="carto-note" data-testid="cartographie-camera-privacy">
          Aperçu ou flux ouverts uniquement sur demande : le fournisseur reçoit ton adresse IP.
          La date affichée est celle du catalogue, pas nécessairement celle de l’image.
        </p>
      )}
      {data && !origin && (
        <p className="carto-note" data-testid="cartographie-no-origin">
          Aucune ville d’établissement : le filtre par rayon est désactivé. Renseigne-la dans Réveil matinal &gt; Veille locale.
        </p>
      )}
      {failed.map((source) => (
        <p className="carto-note" key={source.id}>Source indisponible : {source.label} ({source.provider}) — {source.detail}</p>
      ))}

      <div className="carto-stage">
        <div ref={mapNode} className="carto-map" data-testid="cartographie-map" />
        {rainEnabled && rainIndex >= 0 && (
          <aside className="carto-rain-legend" aria-label="Légende de pluie NASA">
            <strong>Intensité des précipitations (mm/h)</strong>
            {rainLegendError ? <span>Légende NASA indisponible.</span> : (
              <>
                <img src={RAIN_LEGEND_URL} alt="Échelle NASA de l’intensité des précipitations" referrerPolicy="no-referrer"
                  onError={() => setRainLegendError(true)} />
                <span>Échelle du haut : pluie ; échelle du bas : neige.</span>
              </>
            )}
            <span>Zone transparente : pluie très faible ou donnée absente.</span>
          </aside>
        )}
        <aside className={`carto-float ${floatingOpen ? "" : "collapsed"}`} aria-label={extraActive ? "Éléments proches" : "Événements proches"} data-testid="cartographie-nearby">
          <div className="carto-float-head">
            <button type="button" onClick={announce} className="carto-float-title" title="Lire le résumé">
              {extraActive ? "ÉLÉMENTS" : "ÉVÉNEMENTS"} {visibleOnly ? "VISIBLES" : "PROCHES"} · {nearby.total}
            </button>
            <button type="button" onClick={() => setFloatingOpen((open) => !open)}
              aria-label={floatingOpen ? "Réduire la liste" : "Afficher la liste"} aria-expanded={floatingOpen}>
              {floatingOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
          {floatingOpen && (
            nearby.items.length ? (
              <ol>
                {nearby.items.map((item) => (
                  <li key={itemKey(item)}>
                    <button type="button" onClick={() => focus(item)}>
                      <span className={`carto-dot ${item.kind}`} aria-hidden="true" />
                      <span><b>{eventTitle(item)}</b><small>{eventSubtitle(item)}</small></span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : <p className="carto-empty">{busy ? "Chargement…" : `Aucun ${extraActive ? "élément" : "événement"} avec ces filtres.`}</p>
          )}
          {floatingOpen && nearby.total > nearby.items.length && (
            <p className="carto-empty">{nearby.total - nearby.items.length} autre(s) sur la carte.</p>
          )}
        </aside>
      </div>

      <p className="carto-legal">
        Flux publics OSIRIS (NASA EONET, NOAA/NWS, USGS — séismes de magnitude {data?.min_magnitude ?? 3} et plus sur 7 jours), lus par ΣIRIUS sans envoyer ta position.
        {data?.truncated ? ` ${data.truncated} point(s) supplémentaire(s) non affiché(s).` : ""}
        {" "}Les alertes NOAA/NWS couvrent les États-Unis ; la vigilance Météo-France n’est pas incluse. Fond de carte © OpenStreetMap.
        {extraActive && (
          <> Les calques de repères sont limités à la zone visible et au rayon choisi ; la zone est envoyée à l’API ΣIRIUS, pas à OSIRIS.
            {" "}Les positions d’avions sont indicatives ; celles des satellites sont calculées et approximatives.
            {" "}Les conflits sont des repères éditoriaux, pas des frontières ; les actualités et leurs localisations restent à vérifier.
            {" "}Les caméras proviennent de sources publiques et leur disponibilité ou leur date ne sont pas garanties.
            {" "}Ne pas utiliser cette carte pour la navigation ou la sécurité.</>
        )}
        {nightEnabled && " La limite jour / nuit est calculée localement et reste approximative."}
        {windEnabled && " Vent : modèle NOAA GFS à 10 m via OSIRIS, grille de 1° ; les flèches indiquent la direction du déplacement, pas une mesure en direct."}
        {rainEnabled && " Pluie : estimation satellite NASA IMERG différée, couvrant la zone visible sans filtre par rayon ; une zone transparente peut aussi signifier une donnée absente."}
      </p>
    </div>
  );
}
