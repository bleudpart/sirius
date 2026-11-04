import { useEffect, useState } from "react";
import { API_BASE_URL } from "./lib/api";

const EMPTY_POINTS = [];
const DEBOUNCE_MS = 250;

function validResult(body) {
  if (!body || body.kind !== "vent" || !body.source || typeof body.source.ok !== "boolean"
    || !Array.isArray(body.times) || !Array.isArray(body.points) || body.points.length > 384
    || !body.times.every((time) => typeof time === "string" && Number.isFinite(Date.parse(time)))) return false;
  if (!body.source.ok) return true;
  return typeof body.time === "string" && body.times.includes(body.time)
    && typeof body.run === "string" && Number.isFinite(Date.parse(body.run))
    && body.points.every((point) => point
      && Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90
      && Number.isFinite(point.longitude) && point.longitude >= -540 && point.longitude <= 540
      && Number.isFinite(point.east_ms) && Number.isFinite(point.north_ms)
      && Number.isFinite(point.speed_kmh) && point.speed_kmh >= 0);
}

export default function useCartographieVent(enabled, query, refreshVersion) {
  const [state, setState] = useState(null);
  const [selectedTime, setSelectedTime] = useState("");

  useEffect(() => {
    if (!enabled) {
      setState(null);
      setSelectedTime("");
      return undefined;
    }
    if (!query) {
      setState(null);
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setState((previous) => ({
      pending: true, error: "", points: EMPTY_POINTS, result: previous?.result || null,
    }));
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams(query);
        if (selectedTime) params.set("t", selectedTime);
        const response = await fetch(`${API_BASE_URL}/veille/carte/vent?${params}`, {
          credentials: "include", signal: controller.signal,
        });
        if (response.status === 401) throw new Error("Connecte-toi pour afficher le vent.");
        let body;
        try {
          body = await response.json();
        } catch {
          throw new Error("Réponse du serveur illisible.");
        }
        if (!response.ok) throw new Error(body && typeof body.detail === "string" ? body.detail : "Requête du vent refusée.");
        if (!validResult(body)) throw new Error("Réponse du vent invalide.");
        if (!active) return;
        if (!body.source.ok) {
          setState({
            pending: false, points: EMPTY_POINTS, result: body,
            error: typeof body.source.detail === "string" ? body.source.detail : "Source de vent indisponible.",
          });
        } else {
          setState({ pending: false, error: "", points: body.points, result: body });
        }
      } catch (failure) {
        if (!active || controller.signal.aborted) return;
        const message = failure instanceof Error ? failure.message : "Erreur de chargement du vent.";
        setState((previous) => ({
          pending: false, points: EMPTY_POINTS, result: previous?.result || null,
          error: message === "Failed to fetch" ? "Serveur ΣIRIUS injoignable." : message,
        }));
      }
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, query, refreshVersion, selectedTime]);

  return { state: enabled ? state : null, selectedTime, setSelectedTime };
}
