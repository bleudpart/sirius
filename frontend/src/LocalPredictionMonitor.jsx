import { useEffect, useState } from "react";
import { refreshPredictions } from "./localPredictions";

export default function LocalPredictionMonitor({ owner }) {
  const [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => {
      try { refreshPredictions(owner); setError(""); }
      catch { setError("Préparations prédictives locales indisponibles ; vérifiez ou effacez l'historique dans ARIANE."); }
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => clearInterval(timer);
  }, [owner]);
  return error ? <p role="alert">{error}</p> : null;
}
