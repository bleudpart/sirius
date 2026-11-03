// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Veille locale du briefing : ville de l'établissement et sources publiques choisies.
import { useEffect, useState } from "react";
import { API_BASE_URL } from "./lib/api";

const SOURCES = [
  ["meteo_locale", "Météo locale (Open-Meteo)"],
  ["evenements", "Événements naturels et séismes à moins de 300 km (OSIRIS)"],
  ["marches", "Repères de marché : Brent, blé, euro/dollar (OSIRIS)"],
];
const EMPTY = { enabled: false, city: "", meteo_locale: true, evenements: true, marches: true };

async function veilleRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}/veille${path}`, {
    credentials: "include", ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    throw new Error(typeof data?.detail === "string" ? data.detail : `Réglages refusés (HTTP ${response.status}).`);
  }
  return data;
}

const pick = (data) => Object.fromEntries(Object.keys(EMPTY).map((key) => [key, data?.[key] ?? EMPTY[key]]));

export default function VeilleSettings() {
  const [form, setForm] = useState(EMPTY);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");

  useEffect(() => {
    let active = true;
    veilleRequest("/settings")
      .then((data) => { if (active) { setSaved(data); setForm(pick(data)); } })
      .catch((err) => { if (active) setError(err.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setBusy(true);
    setError("");
    setPreview("");
    try {
      const data = await veilleRequest("/settings", { method: "PUT", body: JSON.stringify({ ...form, city: form.city.trim() }) });
      setSaved(data);
      setForm(pick(data));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await veilleRequest("");
      setPreview(data?.text || "Veille désactivée : rien ne sera ajouté au briefing.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const place = saved?.location ? `${saved.location.name}${saved.location.country ? ` (${saved.location.country})` : ""}` : "";
  const status = !saved ? "" : saved.enabled && place ? `Veille active autour de ${place}.`
    : place ? `Veille désactivée — lieu enregistré : ${place}.` : "Veille non configurée.";

  return (
    <section className="reveil-veille" aria-label="Veille locale du briefing" data-testid="veille-settings">
      <h3>VEILLE LOCALE DU BRIEFING</h3>
      <p className="reveil-hint">
        Informations publiques uniquement, aucune action déclenchée. La ville est envoyée à Open-Meteo ;
        aucune position n'est envoyée à OSIRIS, le tri par distance est fait par ΣIRIUS. Les alertes météo
        OSIRIS (NOAA) couvrent les États-Unis : la vigilance Météo-France n'est pas incluse.
      </p>
      <div className="reveil-row">
        <label htmlFor="veille-city">VILLE DE L'ÉTABLISSEMENT</label>
        <input id="veille-city" type="text" maxLength={120} value={form.city} disabled={busy}
          onChange={(event) => update("city", event.target.value)} data-testid="veille-city-input" />
      </div>
      <label className="reveil-check">
        <input type="checkbox" checked={form.enabled} disabled={busy}
          onChange={(event) => update("enabled", event.target.checked)} data-testid="veille-enabled" />
        Ajouter la veille au briefing du jour
      </label>
      {SOURCES.map(([key, label]) => (
        <label key={key} className="reveil-check">
          <input type="checkbox" checked={form[key]} disabled={busy}
            onChange={(event) => update(key, event.target.checked)} data-testid={`veille-${key}`} />
          {label}
        </label>
      ))}
      <div className="reveil-veille-actions">
        <button className="cmd-send" onClick={save} disabled={busy} data-testid="veille-save-btn">ENREGISTRER</button>
        <button className="cmd-send reveil-toggle off" onClick={test} disabled={busy || !saved?.enabled}
          data-testid="veille-preview-btn">TESTER LA VEILLE</button>
      </div>
      {status && <p className="reveil-status" role="status" data-testid="veille-status">{status}</p>}
      {error && <p className="reveil-error" role="alert" data-testid="veille-error">{error}</p>}
      {preview && <pre className="reveil-preview" data-testid="veille-preview">{preview}</pre>}
    </section>
  );
}
