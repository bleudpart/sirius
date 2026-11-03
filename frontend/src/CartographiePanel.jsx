// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { X, Radar, RefreshCw, Loader2, ExternalLink, ChevronDown, ChevronUp, Crosshair } from "lucide-react";
import "./Cartographie.css";
import { API_BASE_URL } from "./lib/api";
import { OSIRIS_MAP_URL } from "./domainOsint";
import useCartographieLayer from "./useCartographieLayer";
import {
  EXTRA_LAYER_LABELS, KIND_LABELS, WORLD, eventSubtitle, filterMapEvents, inBounds, layerQuery,
  leafletBounds, markerStyle, nearbyList,
} from "./cartographie";

const FRANCE = [46.6, 2.4];
const EMPTY_POINTS = [];
const REFRESH_INTERVAL_MS = 60_000;

function itemKey(item) {
  return item.id ? `${item.kind}:${item.id}` : `${item.kind}:${item.latitude}:${item.longitude}:${item.date}:${item.title}`;
}

function itemSignature(item) {
  return JSON.stringify([item.latitude, item.longitude, item.title, eventSubtitle(item), item.url, markerStyle(item)]);
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
      {result.truncated ? " · liste limitée, zoome pour plus de détails" : ""}
      {result.ignored ? ` · ${result.ignored} entrée(s) non exploitables ou non localisées` : ""}
    </span>
  );
}

function popupNode(item) {
  const box = document.createElement("div");
  box.className = "carto-popup";
  const title = document.createElement("strong");
  title.textContent = item.title;
  const detail = document.createElement("span");
  detail.textContent = eventSubtitle(item);
  box.append(title, detail);
  if (item.url) {
    const link = document.createElement("a");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Source officielle";
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
  });
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

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const map = L.map(mapNode.current, { worldCopyJump: true, minZoom: 2, preferCanvas: true }).setView(FRANCE, 5);
    const markers = markersRef.current;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    const track = () => {
      const next = leafletBounds(map.getBounds());
      setBounds((previous) => previous && ["south", "west", "north", "east"]
        .every((key) => Math.abs(previous[key] - next[key]) < 0.0000001) ? previous : next);
    };
    map.on("moveend", track);
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
  const layers = { avion: avionLayer, satellite: satelliteLayer, conflit: conflitLayer, actualite: actualiteLayer };
  const extraActive = Object.keys(EXTRA_LAYER_LABELS).some((kind) => kinds[kind]);
  const extraPoints = useMemo(() => [
    ...(avionLayer?.items || EMPTY_POINTS), ...(satelliteLayer?.items || EMPTY_POINTS),
    ...(conflitLayer?.items || EMPTY_POINTS), ...(actualiteLayer?.items || EMPTY_POINTS),
  ].filter((item) => inBounds(bounds, item.latitude, item.longitude)), [
    avionLayer?.items, satelliteLayer?.items, conflitLayer?.items, actualiteLayer?.items, bounds,
  ]);
  const shown = useMemo(
    () => filterMapEvents([...(data?.events || EMPTY_POINTS), ...extraPoints], { origin, radiusKm, kinds }),
    [data, extraPoints, origin, radiusKm, kinds],
  );
  const nearby = useMemo(() => nearbyList(shown, { bounds, visibleOnly }), [shown, bounds, visibleOnly]);

  useEffect(() => {
    if (!extraActive) return undefined;
    const refreshVisible = () => {
      if (document.visibilityState !== "hidden") setRefreshVersion((current) => current + 1);
    };
    const timer = setInterval(refreshVisible, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [extraActive]);

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
      || Object.keys(EXTRA_LAYER_LABELS).some((kind) => kinds[kind] && layers[kind]?.error);
    const warning = incomplete ? " Certaines sources sont indisponibles." : "";
    onSpeak && onSpeak(count
      ? `${count} ${noun}${count > 1 ? "s" : ""} ${zone}. ${origin ? "Le plus proche" : "Premier élément"} : ${nearby.items[0].title}.${warning}`
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
      </div>
      {extraActive && (
        <div className="carto-layer-status" aria-live="polite">
          {Object.entries(EXTRA_LAYER_LABELS).filter(([kind]) => kinds[kind]).map(([kind, label]) => (
            <LayerStatus key={kind} label={label} state={layers[kind]} />
          ))}
        </div>
      )}

      {error && <p className="her-error" role="alert" data-testid="cartographie-error">{error}</p>}
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
                      <span><b>{item.title}</b><small>{eventSubtitle(item)}</small></span>
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
          <> Les calques complémentaires sont limités à la zone visible et au rayon choisi ; la zone est envoyée à l’API ΣIRIUS, pas à OSIRIS.
            {" "}Les positions d’avions sont indicatives ; celles des satellites sont calculées et approximatives.
            {" "}Les conflits sont des repères éditoriaux, pas des frontières ; les actualités et leurs localisations restent à vérifier.
            {" "}Ne pas utiliser cette carte pour la navigation ou la sécurité.</>
        )}
      </p>
    </div>
  );
}
