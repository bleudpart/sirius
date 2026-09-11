// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "@/App";
import AuthGate from "@/AuthGate";
import MediaHudWindow from "@/MediaHudWindow";
import FdeErrorBoundary from "@/FdeErrorBoundary";
import { initFdeOmega } from "@/fdeOmega";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

const root = ReactDOM.createRoot(document.getElementById("root"));
const isMediaHud = new URLSearchParams(window.location.search).has("mediaHud");
const stopFdeOmega = initFdeOmega();
window.addEventListener("beforeunload", stopFdeOmega, { once: true });
// StrictMode retiré : il double l'exécution des effets en développement,
// ce qui faisait parler chaque module deux fois (écho des voix de présentation).
root.render(
  <QueryClientProvider client={queryClient}>
    <FdeErrorBoundary>
      <AuthGate>
        {isMediaHud ? <MediaHudWindow /> : <App />}
      </AuthGate>
    </FdeErrorBoundary>
  </QueryClientProvider>,
);
