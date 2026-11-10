import { useEffect, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { checkHaccpResponse, haccpFetch } from "./haccpRequest";

const API = `${API_BASE_URL}/haccp/releves`;
const ENABLED_KEY = "sirius_haccp_word_relay_enabled";
const RELAY_KEY = "sirius_haccp_word_relay_id";
const CHANGE_EVENT = "sirius-haccp-word-relay-change";

export function wordRelayEnabled() {
  return localStorage.getItem(ENABLED_KEY) === "true";
}

export function setWordRelayEnabled(enabled) {
  localStorage.setItem(ENABLED_KEY, enabled ? "true" : "false");
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function relayId() {
  let id = localStorage.getItem(RELAY_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(RELAY_KEY, id);
  }
  return id;
}

export function useHaccpRelevePrintRelay(accountKey) {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!window.siriusHaccpPrinter) return undefined;
    const sync = () => {
      try {
        setEnabled(wordRelayEnabled());
        setError("");
      } catch {
        setEnabled(false);
        setError("Le stockage local du relais Word est inaccessible.");
      }
    };
    window.addEventListener(CHANGE_EVENT, sync);
    sync();
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!enabled || !accountKey || !window.siriusHaccpPrinter) return undefined;
    let cancelled = false;
    let timer;
    async function tick() {
      try {
        await haccpFetch(`${API}/impression/traiter`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ relay_id: relayId() }),
        }, async (response) => (await checkHaccpResponse(response)).json());
        if (!cancelled) {
          setError("");
          timer = setTimeout(tick, 5000);
        }
      } catch (failure) {
        if (!cancelled) setError(failure.message || "Relais Word indisponible.");
      }
    }
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, accountKey]);

  return { enabled, error };
}
