// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import { APIProvider, Map, Marker, useMap } from "@vis.gl/react-google-maps";
import { Map as MapIcon, X, Search, Crosshair, Route as RouteIcon, Loader2, Settings2, KeyRound, CheckCircle2, AlertTriangle, ExternalLink, Navigation, TrafficCone, Sun, Cloud, CloudSun, CloudRain, CloudDrizzle, CloudSnow, CloudFog, CloudLightning, Wind, Droplets } from "lucide-react";
import "./Atlas.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const PARIS = { lat: 48.8566, lng: 2.3522 };

function wmoInfo(code) {
  if (code === 0) return { Icon: Sun, txt: "Ciel dégagé" };
  if (code <= 2) return { Icon: CloudSun, txt: "Partiellement nuageux" };
  if (code === 3) return { Icon: Cloud, txt: "Couvert" };
  if (code <= 48) return { Icon: CloudFog, txt: "Brouillard" };
  if (code <= 57) return { Icon: CloudDrizzle, txt: "Bruine" };
  if (code <= 67) return { Icon: CloudRain, txt: "Pluie" };
  if (code <= 77) return { Icon: CloudSnow, txt: "Neige" };
  if (code <= 82) return { Icon: CloudRain, txt: "Averses" };
  if (code <= 86) return { Icon: CloudSnow, txt: "Averses de neige" };
  return { Icon: CloudLightning, txt: "Orage" };
}

const HOLO_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#04121c" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#91e6f2" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#02090f" }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#155e75" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#d8b875" }] },
  { featureType: "administrative.country", elementType: "labels.text.fill", stylers: [{ color: "#d8b875" }] },
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#0b2a3a" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#083344" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#7dd3fc" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#164e63" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#d8b875" }, { weight: 0.4 }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#021019" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#0e7490" }] },
  { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#05141f" }] },
];

function MapController({ target }) {
  const map = useMap();
  useEffect(() => {
    if (!map || !target) return;
    map.panTo({ lat: target.lat, lng: target.lng });
    map.setZoom(target.zoom || 14);
  }, [map, target]);
  return null;
}

function TrafficOverlay({ enabled }) {
  const map = useMap();
  useEffect(() => {
    if (!map || !enabled || !window.google) return;
    const layer = new window.google.maps.TrafficLayer();
    layer.setMap(map);
    return () => layer.setMap(null);
  }, [map, enabled]);
  return null;
}

function RoutePath({ path }) {
  const map = useMap();
  useEffect(() => {
    if (!map || !path || !path.length || !window.google) return;
    const glow = new window.google.maps.Polyline({ path, strokeColor: "#d8b875", strokeOpacity: 0.3, strokeWeight: 10, map });
    const line = new window.google.maps.Polyline({ path, strokeColor: "#91e6f2", strokeOpacity: 0.95, strokeWeight: 4, map });
    const b = new window.google.maps.LatLngBounds();
    path.forEach((p) => b.extend(p));
    map.fitBounds(b, 70);
    return () => { line.setMap(null); glow.setMap(null); };
  }, [map, path]);
  return null;
}

function KeyScreen({ onSave, onBack, hasKey, authFail }) {
  const [val, setVal] = useState("");
  return (
    <div className="atlas-keyscreen" data-testid="atlas-key-screen">
      {authFail && (
        <div className="atlas-msg ko" data-testid="atlas-authfail-msg">
          <AlertTriangle size={12} /> Clé Google Maps refusée par Google. Vérifiez que l&apos;API « Maps JavaScript API » est bien activée et que la clé est valide.
        </div>
      )}
      <p className="atlas-help">
        ATLAS a besoin d&apos;une <b>clé API Google Maps</b> pour afficher la carte (un compte de facturation Google Cloud est requis, avec un quota d&apos;utilisation mensuel gratuit par API) :
      </p>
      <ol className="atlas-steps">
        <li>Ouvrez la <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console <ExternalLink size={10} /></a> et connectez-vous.</li>
        <li>Créez un projet (menu en haut → « Nouveau projet ») et associez un compte de facturation (« Facturation »).</li>
        <li>Menu « API et services » → « Bibliothèque » → recherchez et activez <b>Maps JavaScript API</b>.</li>
        <li>Menu « API et services » → « Identifiants » → « Créer des identifiants » → <b>Clé API</b>.</li>
        <li>Copiez la clé (commence par <i>AIza…</i>) et collez-la ci-dessous.</li>
      </ol>
      <label className="atlas-label"><KeyRound size={11} /> CLÉ API GOOGLE MAPS</label>
      <input className="atlas-input" type="password" placeholder="AIza..." value={val} onChange={(e) => setVal(e.target.value)} data-testid="atlas-key-input" />
      <div className="atlas-actions">
        <button className="atlas-btn gold" disabled={!val.trim()} onClick={() => onSave(val.trim())} data-testid="atlas-key-save-btn">
          <CheckCircle2 size={12} /> ACTIVER LA CARTE
        </button>
        {hasKey && <button className="atlas-btn" onClick={onBack} data-testid="atlas-key-back-btn">RETOUR</button>}
      </div>
    </div>
  );
}

export default function AtlasPanel({ onClose, onSpeak, keys, onSaveKeys, initialQuery, initialRoute }) {
  const [char, setChar] = useState(null);
  useEffect(() => {
    fetch((process.env.REACT_APP_BACKEND_URL || "") + "/api/mythos/characters")
      .then(r => r.json())
      .then(d => {
        const p = d.characters.find(c => c.module === "ATLAS#");
        setChar(p);
      });
  }, []);
  const gmapsKey = (keys && keys.gmaps) || "";
  const [showKey, setShowKey] = useState(!gmapsKey);
  const [authFail, setAuthFail] = useState(false);
  const [mode, setMode] = useState(initialRoute ? "route" : "search");
  const [traffic, setTraffic] = useState(true);
  const [q, setQ] = useState(initialQuery || "");
  const [fromA, setFromA] = useState((initialRoute && initialRoute.from) || "");
  const [toA, setToA] = useState((initialRoute && initialRoute.to) || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [marker, setMarker] = useState(null);
  const [userPos, setUserPos] = useState(null);
  const [target, setTarget] = useState(null);
  const [route, setRoute] = useState(null);
  const [weather, setWeather] = useState(null);
  const ranRef = useRef(false);
  const announcedRef = useRef(null);

  useEffect(() => {
    const pt = marker
      || (route && { lat: route.to_point.lat, lng: route.to_point.lng, label: route.to_point.formatted });
    if (!pt) { setWeather(null); return; }
    let stop = false;
    (async () => {
      try {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${pt.lat}&longitude=${pt.lng}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto`);
        const d = await r.json();
        if (stop || !d.current) return;
        setWeather({ ...d.current, daily: d.daily || null, label: pt.label });
        // Annonce vocale de la météo dès son affichage (lieu recherché)
        if (marker && onSpeak && announcedRef.current !== pt.label) {
          announcedRef.current = pt.label;
          const city = (pt.label || "").split(",")[0];
          const { txt } = wmoInfo(d.current.weather_code);
          let msg = `${city} affiché sur la carte. Météo actuelle : ${Math.round(d.current.temperature_2m)} degrés, ${txt.toLowerCase()}, vent ${Math.round(d.current.wind_speed_10m)} kilomètres heure.`;
          if (d.daily && d.daily.time && d.daily.time.length > 3) {
            const jour = (i) => new Date(d.daily.time[i]).toLocaleDateString("fr-FR", { weekday: "long" });
            msg += ` Prévisions : ${jour(1)} ${Math.round(d.daily.temperature_2m_max[1])} degrés, ${jour(2)} ${Math.round(d.daily.temperature_2m_max[2])}, et ${jour(3)} ${Math.round(d.daily.temperature_2m_max[3])} degrés.`;
          }
          onSpeak(msg);
        }
      } catch {
        if (!stop) {
          setWeather(null);
          if (marker && onSpeak && announcedRef.current !== pt.label) {
            announcedRef.current = pt.label;
            onSpeak(`${(pt.label || "").split(",")[0]} affiché sur la carte.`);
          }
        }
      }
    })();
    return () => { stop = true; };
  }, [marker, route, onSpeak]);

  useEffect(() => {
    window.gm_authFailure = () => setAuthFail(true);
    return () => { window.gm_authFailure = undefined; };
  }, []);

  const geocode = useCallback(async (addr) => {
    const a = (addr || "").trim();
    if (!a) { setError("Précisez un lieu à afficher."); return; }
    setBusy(true); setError(""); setRoute(null);
    try {
      const r = await fetch(`${API}/locus/geocode`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: a, keys: keys || {} }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.detail || "Lieu introuvable."); setBusy(false); return; }
      const res = d.result;
      setMarker({ lat: res.lat, lng: res.lng, label: res.formatted });
      setTarget({ lat: res.lat, lng: res.lng, zoom: 13 });
    } catch { setError("Backend injoignable."); }
    setBusy(false);
  }, [keys]);

  const getPosition = useCallback(() => new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("no geo")); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(new Error("denied")),
      { enableHighAccuracy: true, timeout: 12000 }
    );
  }), []);

  const locate = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const pos = await getPosition();
      setUserPos(pos);
      setTarget({ ...pos, zoom: 15 });
      onSpeak && onSpeak("Position acquise, monsieur. Vous êtes localisé sur la carte.");
    } catch { setError("Géolocalisation refusée ou indisponible."); }
    setBusy(false);
  }, [getPosition, onSpeak]);

  const computeRoute = useCallback(async (fa, ta) => {
    if (!(ta || "").trim()) { setError("Précisez la destination."); return; }
    setBusy(true); setError(""); setMarker(null);
    const payload = { to_address: ta.trim() };
    if ((fa || "").trim()) payload.from_address = fa.trim();
    else {
      try {
        const pos = userPos || await getPosition();
        setUserPos(pos);
        payload.from_lat = pos.lat; payload.from_lng = pos.lng;
      } catch { setError("Départ inconnu — précisez-le ou autorisez la géolocalisation."); setBusy(false); return; }
    }
    try {
      const r = await fetch(`${API}/atlas/route`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.detail || "Itinéraire impossible."); setBusy(false); return; }
      setRoute(d);
      onSpeak && onSpeak(`Itinéraire tracé : ${String(d.distance_km).replace(".", ",")} kilomètres, environ ${d.duration_text} de route.`);
    } catch { setError("Backend injoignable."); }
    setBusy(false);
  }, [userPos, getPosition, onSpeak]);

  useEffect(() => {
    if (ranRef.current || showKey) return;
    if (initialRoute && initialRoute.to) { ranRef.current = true; computeRoute(initialRoute.from || "", initialRoute.to); }
    else if (initialQuery) { ranRef.current = true; geocode(initialQuery); }
  }, [showKey, initialQuery, initialRoute, geocode, computeRoute]);

  const saveKey = (k) => {
    onSaveKeys && onSaveKeys(k);
    setAuthFail(false);
    setShowKey(false);
  };

  return (
    <div className="atlas-panel" data-testid="atlas-panel">
      <div className="atlas-bar">
        <MapIcon size={14} />
        <span className="atlas-title">ATLAS# — CARTE &amp; NAVIGATION</span>
        {route && !showKey && (
          <span className="atlas-chip" data-testid="atlas-route-stats">
            {String(route.distance_km).replace(".", ",")} km · {route.duration_text}
          </span>
        )}
        {gmapsKey && !showKey && (
          <button className={`atlas-icon-btn ${traffic ? "active" : ""}`} onClick={() => setTraffic((t) => !t)} title={traffic ? "Masquer le trafic" : "Afficher le trafic en direct"} data-testid="atlas-traffic-btn"><TrafficCone size={13} /></button>
        )}
        {gmapsKey && (
          <button className="atlas-icon-btn" onClick={() => setShowKey((s) => !s)} title="Clé API" data-testid="atlas-settings-btn"><Settings2 size={13} /></button>
        )}
        <button className="atlas-icon-btn" onClick={onClose} data-testid="atlas-close-btn"><X size={14} /></button>
      </div>

      {char && (
        <img
          src={char.image}
          alt={char.character}
          className="mythos-avatar"
        />
      )}

      {showKey ? (
        <KeyScreen onSave={saveKey} onBack={() => setShowKey(false)} hasKey={!!gmapsKey} authFail={authFail} />
      ) : (
        <>
          <div className="atlas-toolbar">
            <div className="atlas-tabs">
              <button className={`atlas-tab ${mode === "search" ? "active" : ""}`} onClick={() => setMode("search")} data-testid="atlas-tab-search"><Search size={12} /> LIEU</button>
              <button className={`atlas-tab ${mode === "route" ? "active" : ""}`} onClick={() => setMode("route")} data-testid="atlas-tab-route"><RouteIcon size={12} /> ITINÉRAIRE</button>
            </div>
            {mode === "search" ? (
              <div className="atlas-row">
                <input className="atlas-input" placeholder="Ex : Paris / Tour Eiffel / 10 rue de Rivoli…" value={q}
                  onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") geocode(q); }}
                  data-testid="atlas-search-input" />
                <button className="atlas-btn" onClick={() => geocode(q)} disabled={busy} data-testid="atlas-search-btn">
                  {busy ? <Loader2 size={13} className="atlas-spin" /> : <Search size={13} />} AFFICHER
                </button>
                <button className="atlas-btn gold" onClick={locate} disabled={busy} title="Ma position" data-testid="atlas-locate-btn">
                  <Crosshair size={13} /> MA POSITION
                </button>
              </div>
            ) : (
              <div className="atlas-row">
                <input className="atlas-input" placeholder="Départ (vide = ma position)" value={fromA}
                  onChange={(e) => setFromA(e.target.value)} data-testid="atlas-from-input" />
                <input className="atlas-input" placeholder="Destination — ex : Marseille" value={toA}
                  onChange={(e) => setToA(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") computeRoute(fromA, toA); }}
                  data-testid="atlas-to-input" />
                <button className="atlas-btn gold" onClick={() => computeRoute(fromA, toA)} disabled={busy} data-testid="atlas-route-btn">
                  {busy ? <Loader2 size={13} className="atlas-spin" /> : <Navigation size={13} />} TRACER
                </button>
              </div>
            )}
          </div>

          {error && <div className="atlas-msg ko" data-testid="atlas-error"><AlertTriangle size={12} /> {error}</div>}
          {authFail && (
            <div className="atlas-msg warn" data-testid="atlas-authfail-banner">
              <AlertTriangle size={12} /> Clé Google Maps refusée — le fond de carte ne peut pas s&apos;afficher, mais la recherche et les itinéraires restent actifs.
              <button className="atlas-linkbtn" onClick={() => setShowKey(true)} data-testid="atlas-fix-key-btn">CORRIGER LA CLÉ</button>
            </div>
          )}
          {marker && !error && <div className="atlas-msg ok" data-testid="atlas-info"><MapIcon size={12} /> {marker.label}</div>}
          {route && !error && (
            <div className="atlas-msg ok" data-testid="atlas-route-info">
              <RouteIcon size={12} /> {route.from_point.formatted.split(",").slice(0, 2).join(",")} → {route.to_point.formatted.split(",").slice(0, 2).join(",")}
            </div>
          )}

          <div className="atlas-map" data-testid="atlas-map">
            <APIProvider apiKey={gmapsKey} language="fr" region="FR">
              <Map
                defaultCenter={PARIS}
                defaultZoom={11}
                styles={HOLO_STYLE}
                gestureHandling="greedy"
                disableDefaultUI={true}
                zoomControl={true}
                backgroundColor="#04121c"
              >
                <MapController target={target} />
                <TrafficOverlay enabled={traffic} />
                {marker && <Marker position={{ lat: marker.lat, lng: marker.lng }} />}
                {userPos && (
                  <Marker position={userPos} icon={{ path: 0, scale: 8, fillColor: "#91e6f2", fillOpacity: 1, strokeColor: "#d8b875", strokeWeight: 2 }} />
                )}
                {route && (
                  <>
                    <Marker position={{ lat: route.from_point.lat, lng: route.from_point.lng }} label={{ text: "A", color: "#04121c", fontWeight: "700" }} />
                    <Marker position={{ lat: route.to_point.lat, lng: route.to_point.lng }} label={{ text: "B", color: "#04121c", fontWeight: "700" }} />
                    <RoutePath path={route.path} />
                  </>
                )}
              </Map>
            </APIProvider>
            <div className="atlas-scan" />
            {authFail && (
              <div className="atlas-map-fail" data-testid="atlas-map-fail-overlay">
                <div className="atlas-map-fail-card">
                  <AlertTriangle size={28} />
                  <h3>CARTE INDISPONIBLE</h3>
                  <p>Google refuse la clé API — le fond de carte ne peut pas s&apos;afficher.<br />La recherche de lieux et les itinéraires restent fonctionnels.</p>
                  <ol>
                    <li>Ouvrez la <a href="https://console.cloud.google.com/apis/library/maps-backend.googleapis.com" target="_blank" rel="noreferrer">Google Cloud Console <ExternalLink size={10} /></a> et activez <b>Maps JavaScript API</b>.</li>
                    <li>Dans « Identifiants », vérifiez les <b>restrictions de la clé</b> : supprimez les référents HTTP restrictifs ou ajoutez l&apos;URL de cette application.</li>
                    <li>Vérifiez que la <b>facturation</b> est activée sur le projet.</li>
                  </ol>
                  <button className="atlas-btn gold" onClick={() => setShowKey(true)} data-testid="atlas-map-fail-fix-btn">
                    <KeyRound size={12} /> MODIFIER LA CLÉ
                  </button>
                </div>
              </div>
            )}
            {weather && !showKey && (() => {
              const { Icon, txt } = wmoInfo(weather.weather_code);
              return (
                <div className="atlas-weather" data-testid="atlas-weather">
                  <div className="atlas-weather-head">
                    <Icon size={26} />
                    <span className="atlas-weather-temp">{Math.round(weather.temperature_2m)}°</span>
                  </div>
                  <div className="atlas-weather-desc">{txt}</div>
                  <div className="atlas-weather-city">{(weather.label || "").split(",").slice(0, 2).join(",")}</div>
                  <div className="atlas-weather-stats">
                    <span><Wind size={11} /> {Math.round(weather.wind_speed_10m)} km/h</span>
                    <span><Droplets size={11} /> {weather.relative_humidity_2m}%</span>
                  </div>
                  {weather.daily && weather.daily.time && weather.daily.time.length > 3 && (
                    <div className="atlas-weather-days" data-testid="atlas-weather-days">
                      {[1, 2, 3].map((i) => {
                        const { Icon: DIcon } = wmoInfo(weather.daily.weather_code[i]);
                        return (
                          <div className="atlas-weather-day" key={i}>
                            <span className="awd-name">{new Date(weather.daily.time[i]).toLocaleDateString("fr-FR", { weekday: "short" })}</span>
                            <DIcon size={14} />
                            <span className="awd-temps">
                              <b>{Math.round(weather.daily.temperature_2m_max[i])}°</b> {Math.round(weather.daily.temperature_2m_min[i])}°
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}
