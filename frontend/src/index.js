// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import React from "react";
import ReactDOM from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "@/App";
import AuthGate from "@/AuthGate";
import MediaHudWindow from "@/MediaHudWindow";
import FdeErrorBoundary from "@/FdeErrorBoundary";
import { initFdeOmega } from "@/fdeOmega";
import { initLanguage } from "@/i18n/domTranslator";
import LanguageSwitcher from "@/i18n/LanguageSwitcher";
import PublicStore from "@/PublicStore";
import { FriendSupplierManager, HaccpCaptureWorkspace, HaccpKitchenPage, SupplierOrderPortal, SupplierOrdersManager } from "@/lazyModules";
import "./siriusVisualTheme.css";
import "./moduleWindowLayout.css";
import "./pantheonTheme.css";
import "./androidHud.css";
import "./electronHud.css";
import "./windowHud.css";

document.documentElement.dataset.siriusVisualTheme = "classic";
document.documentElement.dataset.siriusPlatform = Capacitor.getPlatform();

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
const isHaccpCapture = /^\/haccp\/?$/.test(window.location.pathname);
const haccpInitialTab = window.location.hash === "#dlc" ? "snap" : undefined;
const isKitchen = /^\/cuisine\/?$/.test(window.location.pathname);
const isSupplierPortal = /^\/commandes\/?$/.test(window.location.pathname);
const isSupplierManagement = /^\/commandes\/gestion\/?$/.test(window.location.pathname);
const isFriendSupplierManager = /^\/portail\/gestion\/?$/.test(window.location.pathname);
if (isKitchen) document.querySelector('link[rel="manifest"]')?.setAttribute("href", "/manifest-cuisine.json");
if (isSupplierPortal || isFriendSupplierManager) {
  document.title = "Portail de commandes";
  document.querySelector('link[rel="manifest"]')?.remove();
  document.querySelector('link[rel="apple-touch-icon"]')?.remove();
  document.querySelector('link[rel="icon"]')?.setAttribute("href", "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%231c3d4c'/%3E%3Cpath d='M14 24h36l-4 23H18zM24 24l8-12 8 12' fill='none' stroke='white' stroke-width='4'/%3E%3C/svg%3E");
  document.querySelector('meta[name="description"]')?.setAttribute("content", "Portail de commandes professionnelles.");
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute("content", "Portail de commandes");
}
const isPublicStore = ["sirius-assistant.fr", "www.sirius-assistant.fr"].includes(window.location.hostname)
  || ["/acheter", "/compte"].includes(window.location.pathname);
const stopFdeOmega = isSupplierPortal || isFriendSupplierManager ? null : initFdeOmega();
initLanguage();
if (stopFdeOmega) window.addEventListener("beforeunload", stopFdeOmega, { once: true });
// StrictMode retiré : il double l'exécution des effets en développement,
// ce qui faisait parler chaque module deux fois (écho des voix de présentation).
root.render(
  <QueryClientProvider client={queryClient}>
    <FdeErrorBoundary>
      {(isKitchen || isHaccpCapture) && <LanguageSwitcher className="sirius-floating-language" />}
      {isFriendSupplierManager ? <FriendSupplierManager /> : isSupplierPortal ? <SupplierOrderPortal /> : isSupplierManagement ? <AuthGate><SupplierOrdersManager /></AuthGate> : isKitchen ? <HaccpKitchenPage /> : isHaccpCapture ? <AuthGate><HaccpCaptureWorkspace standalone initialTab={haccpInitialTab} /></AuthGate> : isPublicStore ? <PublicStore /> : (
        <AuthGate>
          {isMediaHud ? <MediaHudWindow /> : <App />}
        </AuthGate>
      )}
    </FdeErrorBoundary>
  </QueryClientProvider>,
);
