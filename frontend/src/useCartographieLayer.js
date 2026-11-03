import { useEffect, useState } from "react";
import { API_BASE_URL } from "./lib/api";

const EMPTY_ITEMS = [];
const DEBOUNCE_MS = 250;

export default function useCartographieLayer(kind, enabled, query, refreshVersion) {
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!enabled || !query) {
      setState(null);
      return undefined;
    }

    const controller = new AbortController();
    let active = true;
    setState((previous) => ({
      pending: true, error: "", items: previous?.items || EMPTY_ITEMS, result: previous?.result || null,
    }));

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/veille/carte/calques/${kind}?${query}`, {
          credentials: "include", signal: controller.signal,
        });
        if (response.status === 401) throw new Error("Connecte-toi pour afficher ce calque.");
        let body;
        try {
          body = await response.json();
        } catch {
          throw new Error("Réponse du serveur illisible.");
        }
        if (!response.ok) throw new Error(body && typeof body.detail === "string" ? body.detail : "Requête du calque refusée.");
        if (!body || !Array.isArray(body.items) || !body.source || typeof body.source.ok !== "boolean"
          || !Number.isFinite(body.total) || !Number.isFinite(body.truncated)) {
          throw new Error("Réponse du calque invalide.");
        }
        if (!active) return;
        if (!body.source.ok) {
          setState({
            pending: false, items: EMPTY_ITEMS, result: body,
            error: typeof body.source.detail === "string" ? body.source.detail : "Source indisponible.",
          });
        } else {
          setState({ pending: false, error: "", items: body.items, result: body });
        }
      } catch (failure) {
        if (!active || controller.signal.aborted) return;
        const message = failure instanceof Error ? failure.message : "Erreur de chargement du calque.";
        setState({
          pending: false, items: EMPTY_ITEMS, result: null,
          error: message === "Failed to fetch" ? "Serveur ΣIRIUS injoignable." : message,
        });
      }
    }, DEBOUNCE_MS);

    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [kind, enabled, query, refreshVersion]);

  return enabled ? state : null;
}
