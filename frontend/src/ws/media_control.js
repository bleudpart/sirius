import { useCallback, useEffect, useRef, useState } from "react";

const BACKEND_BASE = process.env.REACT_APP_BACKEND_URL || "http://127.0.0.1:8001";
const MEDIA_API = `${BACKEND_BASE}/api/media`;

export const MEDIA_PROVIDERS = [
  { id: "youtube", label: "YouTube" },
  { id: "spotify", label: "Spotify" },
  { id: "twitch", label: "Twitch" },
  { id: "tiktok", label: "TikTok" },
  { id: "deezer", label: "Deezer" },
  { id: "netflix", label: "Netflix" },
];

function websocketUrl() {
  const url = new URL(`${MEDIA_API}/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function request(path, options = {}) {
  const response = await fetch(`${MEDIA_API}${path}`, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || "Le service multimedia est indisponible.");
  }
  return payload;
}

function requestId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useMediaControl() {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const socketRef = useRef(null);
  const pendingRef = useRef(new Map());

  const refresh = useCallback(async () => {
    try {
      const payload = await request("/state");
      setState(payload.state || null);
      return payload.state || null;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    }
  }, []);

  const resolveMedia = useCallback(async ({ provider, query = "", url = "" }) => {
    setBusy(true);
    setError("");
    try {
      const payload = await request("/resolve", {
        method: "POST",
        body: JSON.stringify({ provider, query, url }),
      });
      setState(payload.state || null);
      return payload.state || null;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const controlMedia = useCallback(async (control) => {
    const normalizedControl = typeof control === "string" ? { action: control } : control;
    setBusy(true);
    setError("");
    try {
      const socket = socketRef.current;
      let nextState;
      if (socket && socket.readyState === WebSocket.OPEN) {
        const id = requestId();
        nextState = await new Promise((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            pendingRef.current.delete(id);
            reject(new Error("Le controle multimedia n'a pas recu de reponse."));
          }, 5000);
          pendingRef.current.set(id, { resolve, reject, timeout });
          socket.send(JSON.stringify({
            type: "media_control",
            request_id: id,
            control: normalizedControl,
          }));
        });
      } else {
        const payload = await request("/control", {
          method: "POST",
          body: JSON.stringify(normalizedControl),
        });
        nextState = payload.state || null;
      }
      setState(nextState);
      return nextState;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let socket;
    let retryTimer;
    let stopped = false;
    let attempt = 0;

    const rejectPending = (message) => {
      for (const pending of pendingRef.current.values()) {
        window.clearTimeout(pending.timeout);
        pending.reject(new Error(message));
      }
      pendingRef.current.clear();
    };

    const scheduleReconnect = () => {
      if (stopped || retryTimer) return;
      const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
      attempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, delay);
    };

    const connect = () => {
      if (stopped) return;
      try {
        socket = new WebSocket(websocketUrl());
      } catch (connectionError) {
        setConnected(false);
        setError(connectionError.message || "La connexion multimedia ne peut pas etre ouverte.");
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;
      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      socket.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch (messageError) {
          setError(messageError.message || "Le serveur multimedia a envoye un message invalide.");
          return;
        }
        if (payload.type === "media_state") {
          setState(payload.state || null);
          return;
        }
        if (payload.type === "media_ack") {
          const pending = pendingRef.current.get(payload.request_id);
          if (!pending) return;
          window.clearTimeout(pending.timeout);
          pendingRef.current.delete(payload.request_id);
          pending.resolve(payload.state || null);
          return;
        }
        if (payload.type === "media_error") {
          const pending = pendingRef.current.get(payload.request_id);
          if (pending) {
            window.clearTimeout(pending.timeout);
            pendingRef.current.delete(payload.request_id);
            pending.reject(new Error(payload.detail || "Commande multimedia refusee."));
          } else {
            setError(payload.detail || "Commande multimedia refusee.");
          }
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (socketRef.current === socket) socketRef.current = null;
        rejectPending("La connexion multimedia a ete fermee.");
        scheduleReconnect();
      };
      socket.onerror = () => {
        setError("La connexion multimedia a rencontre une erreur.");
        socket.close();
      };
    };

    void refresh();
    connect();
    return () => {
      stopped = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      rejectPending("Le controle multimedia a ete ferme.");
      if (socket) {
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        socket.close();
      }
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    const bridge = window.siriusMedia;
    if (!bridge || !bridge.onCommand) return undefined;
    return bridge.onCommand((command) => {
      const action = command && command.action;
      if (["play", "pause", "stop", "toggle"].includes(action)) {
        void controlMedia({ action });
      }
    });
  }, [controlMedia]);

  return {
    state,
    connected,
    busy,
    error,
    clearError: () => setError(""),
    refresh,
    resolveMedia,
    controlMedia,
  };
}
