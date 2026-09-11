// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import { X, MapPin, Crosshair, Loader2, Copy, Check, Thermometer, Wind, Route as RouteIcon } from "lucide-react";
import "./Locus.css";
import MythosBackdrop from "@/MythosBackdrop";
import useDraggableCards from "@/useDraggableCards";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const WeatherChip = ({ w }) => w ? (
  <div className="locus-weather" data-testid="locus-weather">
    <Thermometer size={13} /> <b>{Math.round(w.temp)}°C</b>
    <span className="locus-wcond">{w.condition}</span>
    <Wind size={13} /> {Math.round(w.wind_kmh)} km/h
    <span className="locus-whum">humidité {w.humidity}%</span>
  </div>
) : null;

export default function LocusPanel({ onClose, onSpeak, keys, initialAddress, initialRoute }) {
  const [char, setChar] = useState(null);
  useEffect(() => {
    fetch((process.env.REACT_APP_BACKEND_URL || "") + "/api/mythos/characters")
      .then(r => r.json())
      .then(d => {
        const p = d.characters.find(c => c.module === "LOCUS#");
        setChar(p);
      });
  }, []);
  const [tab, setTab] = useState(initialRoute ? "route" : "geo");
  const dragRef = useDraggableCards([tab]);
  const [address, setAddress] = useState(initialAddress || "");
  const [fromA, setFromA] = useState((initialRoute && initialRoute.from) || "");
  const [toA, setToA] = useState((initialRoute && initialRoute.to) || "");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const [routeOut, setRouteOut] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const ranRef = useRef(false);

  const geocode = useCallback(async (addr) => {
    const a = (addr || "").trim();
    if (!a) { setError("Adresse vide — précisez une adresse à géocoder."); return; }
    setBusy(true); setError(""); setOut(null); setCopied(false);
    try {
      const r = await fetch(`${API}/locus/geocode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: a, keys: keys || {} }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.detail || "Géocodage impossible."); setBusy(false); return; }
      setOut(d);
      const res = d.result;
      let msg = `Localisation trouvée : ${res.formatted.split(",").slice(0, 3).join(",")}. Latitude ${res.lat.toFixed(4)}, longitude ${res.lng.toFixed(4)}.`;
      if (res.weather) msg += ` Météo sur place : ${res.weather.condition}, ${Math.round(res.weather.temp)} degrés.`;
      onSpeak && onSpeak(msg);
    } catch (_) { setError("Backend injoignable."); }
    setBusy(false);
  }, [keys, onSpeak]);

  const computeRoute = useCallback(async (fa, ta) => {
    if (!(fa || "").trim() || !(ta || "").trim()) { setError("Précisez le départ et l'arrivée."); return; }
    setBusy(true); setError(""); setRouteOut(null);
    try {
      const r = await fetch(`${API}/locus/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_address: fa.trim(), to_address: ta.trim(), keys: keys || {} }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.detail || "Itinéraire impossible."); setBusy(false); return; }
      setRouteOut(d);
      onSpeak && onSpeak(`Itinéraire trouvé : ${String(d.distance_km).replace(".", ",")} kilomètres, environ ${d.duration_text} en voiture.`);
    } catch (_) { setError("Backend injoignable."); }
    setBusy(false);
  }, [keys, onSpeak]);

  useEffect(() => {
    if (ranRef.current) return;
    if (initialRoute && initialRoute.from) { ranRef.current = true; computeRoute(initialRoute.from, initialRoute.to); }
    else if (initialAddress) { ranRef.current = true; geocode(initialAddress); }
  }, [initialAddress, initialRoute, geocode, computeRoute]);

  const copyCoords = () => {
    if (!out) return;
    navigator.clipboard.writeText(`${out.result.lat}, ${out.result.lng}`).then(() => setCopied(true)).catch(() => {});
  };

  const res = out && out.result;
  const mapSrc = res
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${res.lng - 0.012}%2C${res.lat - 0.006}%2C${res.lng + 0.012}%2C${res.lat + 0.006}&layer=mapnik&marker=${res.lat}%2C${res.lng}`
    : "";
  let routeMapSrc = "";
  if (routeOut) {
    const p1 = routeOut.from_point, p2 = routeOut.to_point;
    const padY = Math.max(0.02, Math.abs(p1.lat - p2.lat) * 0.25);
    const padX = Math.max(0.02, Math.abs(p1.lng - p2.lng) * 0.25);
    const bbox = `${Math.min(p1.lng, p2.lng) - padX}%2C${Math.min(p1.lat, p2.lat) - padY}%2C${Math.max(p1.lng, p2.lng) + padX}%2C${Math.max(p1.lat, p2.lat) + padY}`;
    routeMapSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${p2.lat}%2C${p2.lng}`;
  }

  return (
    <div className="prime-screen" data-testid="locus-panel" ref={dragRef}>
      <MythosBackdrop module="LOCUS#" state={busy ? "busy" : error ? "alert" : "idle"} />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><MapPin size={20} /> LOCUS# — GÉOLOCALISATION</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="locus-close-btn"><X size={18} /></button>
      </header>
      {char && (
        <img
          src={char.image}
          alt={char.character}
          className="mythos-avatar"
        />
      )}
      <div className="prime-sub">GÉOCODAGE · MÉTÉO LOCALE · ITINÉRAIRES · GOOGLE SI CLÉ, NOMINATIM/OSM EN SECOURS · RIEN N'EST STOCKÉ</div>

      <div className="argus-body">
        <div className="haccp-tabs">
          <button className={`haccp-tab ${tab === "geo" ? "active" : ""}`} onClick={() => setTab("geo")} data-testid="locus-tab-geo">
            <Crosshair size={13} /> LOCALISER
          </button>
          <button className={`haccp-tab ${tab === "route" ? "active" : ""}`} onClick={() => setTab("route")} data-testid="locus-tab-route">
            <RouteIcon size={13} /> ITINÉRAIRE
          </button>
        </div>

        {tab === "geo" && (
          <section className="prime-card argus-wide">
            <div className="locus-searchrow">
              <input
                className="vision-question locus-input"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") geocode(address); }}
                placeholder="Ex : 10 rue de Rivoli, Paris / Tour Eiffel / Kyoto, Japon"
                data-testid="locus-address-input"
              />
              <button className="locus-go" onClick={() => geocode(address)} disabled={busy} data-testid="locus-geocode-btn">
                {busy ? <Loader2 size={14} className="spin" /> : <Crosshair size={14} />} LOCALISER
              </button>
            </div>

            {error && <div className="locus-error" data-testid="locus-error">{error}</div>}

            {res && (
              <div className="locus-result" data-testid="locus-result">
                <div className="locus-formatted">{res.formatted}</div>
                <div className="locus-coords">
                  <span data-testid="locus-lat">LAT <b>{res.lat.toFixed(6)}</b></span>
                  <span data-testid="locus-lng">LNG <b>{res.lng.toFixed(6)}</b></span>
                  <span className={`locus-source ${res.source}`} data-testid="locus-source">
                    {res.source === "google" ? "GOOGLE GEOCODING" : "NOMINATIM · OSM"}
                  </span>
                  <button className="locus-copy" onClick={copyCoords} data-testid="locus-copy-btn" title="Copier les coordonnées">
                    {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "COPIÉ" : "COPIER"}
                  </button>
                </div>
                <WeatherChip w={res.weather} />
                <iframe title="Carte LOCUS" className="locus-map" src={mapSrc} data-testid="locus-map" />
                <details className="locus-intent">
                  <summary>INTENT JSON — locus.geocode</summary>
                  <pre data-testid="locus-intent-json">{JSON.stringify({
                    responseText: out.responseText,
                    intent: out.intent,
                    parameters: out.parameters,
                    requiresConfirmation: out.requiresConfirmation,
                  }, null, 2)}</pre>
                </details>
              </div>
            )}
          </section>
        )}

        {tab === "route" && (
          <section className="prime-card argus-wide">
            <div className="locus-searchrow locus-routerow">
              <input
                className="vision-question locus-input"
                value={fromA}
                onChange={(e) => setFromA(e.target.value)}
                placeholder="Départ — ex : Lyon"
                data-testid="locus-from-input"
              />
              <input
                className="vision-question locus-input"
                value={toA}
                onChange={(e) => setToA(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") computeRoute(fromA, toA); }}
                placeholder="Arrivée — ex : Marseille"
                data-testid="locus-to-input"
              />
              <button className="locus-go" onClick={() => computeRoute(fromA, toA)} disabled={busy} data-testid="locus-route-btn">
                {busy ? <Loader2 size={14} className="spin" /> : <RouteIcon size={14} />} CALCULER
              </button>
            </div>

            {error && <div className="locus-error" data-testid="locus-error-route">{error}</div>}

            {routeOut && (
              <div className="locus-result" data-testid="locus-route-result">
                <div className="locus-routestats">
                  <span data-testid="locus-distance">DISTANCE <b>{String(routeOut.distance_km).replace(".", ",")} km</b></span>
                  <span data-testid="locus-duration">DURÉE <b>{routeOut.duration_text}</b></span>
                  <span className="locus-source nominatim">VOITURE · OSRM</span>
                </div>
                <div className="locus-formatted">{routeOut.parameters.from}</div>
                <div className="locus-routearrow">→</div>
                <div className="locus-formatted">{routeOut.parameters.to}</div>
                <WeatherChip w={routeOut.to_point.weather} />
                <iframe title="Carte itinéraire" className="locus-map" src={routeMapSrc} data-testid="locus-route-map" />
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
