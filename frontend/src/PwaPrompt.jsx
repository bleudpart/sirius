// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import { Download, BellRing, X, Share } from "lucide-react";
import "./PwaPrompt.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const DISMISS_KEY = "sirius_pwa_dismiss";
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

const b64ToUint8 = (s) => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export default function PwaPrompt() {
  const deferredRef = useRef(null);
  const [installable, setInstallable] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pushState, setPushState] = useState(
    "Notification" in window ? Notification.permission : "unsupported"
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;
    const dismissed = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (Date.now() - dismissed < 7 * 24 * 3600 * 1000) return;
    const onBip = (e) => {
      e.preventDefault();
      deferredRef.current = e;
      setInstallable(true);
      setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", onBip);
    // iOS n'émet jamais beforeinstallprompt : proposer les instructions après 6 s
    const t = isIOS() ? setTimeout(() => setVisible(true), 6000) : null;
    return () => { window.removeEventListener("beforeinstallprompt", onBip); clearTimeout(t); };
  }, []);

  const install = async () => {
    const d = deferredRef.current;
    if (!d) return;
    d.prompt();
    const { outcome } = await d.userChoice;
    if (outcome === "accepted") setVisible(false);
    deferredRef.current = null;
    setInstallable(false);
  };

  const enablePush = async () => {
    if (busy || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPushState(perm);
      if (perm !== "granted") { setBusy(false); return; }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await (await fetch(`${API}/push/public_key`)).json();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToUint8(publicKey),
        });
      }
      await fetch(`${API}/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      await fetch(`${API}/push/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "SIRIUS", body: "Notifications activées. Je peux désormais vous contacter à tout moment." }),
      });
    } catch (e) { /* refus ou navigateur incompatible */ }
    setBusy(false);
  };

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setVisible(false);
  };

  // En mode installé : petite pastille pour activer les notifications si pas encore fait
  if (isStandalone()) {
    if (pushState !== "default") return null;
    return (
      <button className="pwa-bell-pill" onClick={enablePush} disabled={busy} data-testid="pwa-enable-push-pill">
        <BellRing size={13} /> ACTIVER LES NOTIFICATIONS
      </button>
    );
  }

  if (!visible) return null;

  return (
    <div className="pwa-banner" data-testid="pwa-install-banner">
      <div className="pwa-banner-glow" />
      <img src="/icon-192.png" alt="" className="pwa-banner-icon" />
      <div className="pwa-banner-text">
        <b>Installer SIRIUS</b>
        {installable ? (
          <span>Ajoutez SIRIUS à votre écran d'accueil pour une expérience plein écran.</span>
        ) : (
          <span className="pwa-ios-hint"><Share size={11} /> Touchez « Partager » puis « Sur l'écran d'accueil »</span>
        )}
      </div>
      <div className="pwa-banner-actions">
        {installable && (
          <button className="pwa-btn install" onClick={install} data-testid="pwa-install-btn">
            <Download size={13} /> INSTALLER
          </button>
        )}
        {pushState === "default" && (
          <button className="pwa-btn" onClick={enablePush} disabled={busy} data-testid="pwa-push-btn">
            <BellRing size={13} /> NOTIFICATIONS
          </button>
        )}
      </div>
      <button className="pwa-close" onClick={dismiss} data-testid="pwa-dismiss-btn"><X size={14} /></button>
    </div>
  );
}
