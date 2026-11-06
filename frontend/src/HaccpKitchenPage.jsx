import { useEffect, useState } from "react";
import { Camera, LoaderCircle, RotateCcw, X } from "lucide-react";
import HaccpKitchen from "./HaccpKitchen";
import { API_BASE_URL } from "./lib/api";
import { checkHaccpResponse, haccpFetch } from "./haccpRequest";
import useScreenWakeLock from "./useScreenWakeLock";
import "./HaccpWorkspace.css";

export const KITCHEN_STORAGE_KEY = "sirius-cuisine-jeton";

// Le jeton reste dans le fragment (#k=…) : il n'est jamais envoyé au serveur web ni dans le Referer.
export function readKitchenToken() {
  const match = /(?:^#|&)k=([A-Za-z0-9_-]{20,200})(?:&|$)/.exec(window.location.hash);
  if (match) {
    try { localStorage.setItem(KITCHEN_STORAGE_KEY, match[1]); } catch { /* navigation privée */ }
    return match[1];
  }
  try {
    const saved = localStorage.getItem(KITCHEN_STORAGE_KEY) || "";
    if (saved) window.history.replaceState(null, "", `${window.location.pathname}#k=${saved}`);
    return saved;
  } catch {
    return "";
  }
}

export default function HaccpKitchenPage() {
  const [token] = useState(readKitchenToken);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState(() => token ? { status: "loading" } : { status: "missing" });
  const wakeLock = useScreenWakeLock(state.status === "ready");
  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    setState({ status: "loading" });
    haccpFetch(`${API_BASE_URL}/haccp/cuisine/session`, { headers: { "X-Sirius-Cuisine": token } },
      async (response) => (await checkHaccpResponse(response)).json())
      .then((session) => { if (active) setState({ status: "ready", restaurant: session.restaurant_name }); })
      .catch((failure) => {
        if (!active) return;
        if (failure.status === 401) {
          try { localStorage.removeItem(KITCHEN_STORAGE_KEY); } catch { /* navigation privée */ }
        }
        setState({ status: "error", message: failure.status ? failure.message : "Pas de connexion Internet.", retry: failure.status !== 401 });
      });
    return () => { active = false; };
  }, [token, attempt]);

  return <main className="haccp-ui haccp-standalone haccp-kitchen-page">
    {state.status === "loading" && <p className="haccp-kitchen-page-message" role="status">
      <LoaderCircle className="haccp-loading" size={64} aria-hidden="true" />
    </p>}
    {state.status === "missing" && <p className="haccp-kitchen-page-message" role="alert">
      <Camera size={72} aria-hidden="true" />Scannez le QR code du chef.
    </p>}
    {state.status === "error" && <div className="haccp-kitchen-page-message" role="alert">
      <X size={72} aria-hidden="true" />
      <p>{state.message}</p>
      {state.retry && <button type="button" className="haccp-simple-small" onClick={() => setAttempt((n) => n + 1)}>
        <RotateCcw size={22} aria-hidden="true" />Encore
      </button>}
    </div>}
    {state.status === "ready" && <HaccpKitchen
      kitchenToken={token}
      establishmentName={state.restaurant}
      onFullMode={() => window.location.assign("/haccp")}
    />}
    {state.status === "ready" && wakeLock.status !== "active" && wakeLock.message
      && <p className="haccp-wake-lock" role="status">{wakeLock.message}</p>}
  </main>;
}
