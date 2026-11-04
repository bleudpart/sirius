import { useEffect, useState } from "react";
import { API_BASE_URL } from "./lib/api";

function validResult(body) {
  if (!body || body.kind !== "pluie" || !body.source || typeof body.source.ok !== "boolean"
    || !Array.isArray(body.times) || body.times.length > 48
    || !body.times.every((time) => typeof time === "string" && Number.isFinite(Date.parse(time)))) return false;
  return !body.source.ok || (typeof body.latest === "string" && body.times.includes(body.latest));
}

export default function useCartographiePluie(enabled, refreshVersion) {
  const [state, setState] = useState(null);
  const [selectedTime, setSelectedTime] = useState("");

  useEffect(() => {
    if (!enabled) {
      setState(null);
      setSelectedTime("");
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setState((previous) => ({ pending: true, error: "", result: previous?.result || null }));
    const load = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/veille/carte/pluie`, {
          credentials: "include", signal: controller.signal,
        });
        if (response.status === 401) throw new Error("Connecte-toi pour afficher la pluie.");
        let body;
        try {
          body = await response.json();
        } catch {
          throw new Error("Réponse du serveur illisible.");
        }
        if (!response.ok) throw new Error(body && typeof body.detail === "string" ? body.detail : "Requête de pluie refusée.");
        if (!validResult(body)) throw new Error("Réponse de pluie invalide.");
        if (!active) return;
        if (!body.source.ok) {
          setState({
            pending: false, result: null,
            error: typeof body.source.detail === "string" ? body.source.detail : "Source de pluie indisponible.",
          });
        } else {
          setState({ pending: false, error: "", result: body });
        }
      } catch (failure) {
        if (!active || controller.signal.aborted) return;
        const message = failure instanceof Error ? failure.message : "Erreur de chargement de la pluie.";
        setState({
          pending: false, result: null,
          error: message === "Failed to fetch" ? "Serveur ΣIRIUS injoignable." : message,
        });
      }
    };
    load();
    return () => { active = false; controller.abort(); };
  }, [enabled, refreshVersion]);

  return { state: enabled ? state : null, selectedTime, setSelectedTime };
}
