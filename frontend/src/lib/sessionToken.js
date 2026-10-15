// Jeton d'accès ΣIRIUS gardé en mémoire : les WebSockets ne peuvent pas envoyer d'en-tête
// Authorization, et l'app native ne rejoue pas les cookies du domaine de l'API.
export const WS_BEARER_PROTOCOL = "sirius.bearer";

let accessToken = null;

export const setSessionToken = (token) => {
  accessToken = typeof token === "string" && token ? token : null;
};

export const getSessionToken = () => accessToken;

// Le serveur lit le jeton dans Sec-WebSocket-Protocol et renvoie « sirius.bearer » à l'acceptation.
export const websocketProtocols = () => (accessToken ? [WS_BEARER_PROTOCOL, accessToken] : []);

// Sur mobile, le refresh token est conservé dans le stockage privé de l'app pour
// retrouver la session au redémarrage (le cookie de l'API n'y est jamais rejoué).
const NATIVE_REFRESH_KEY = "sirius_native_refresh";

export const isNativeSession = () => typeof window !== "undefined"
  && Boolean(window.Capacitor?.isNativePlatform?.());

export const nativeSessionHeaders = () => {
  if (!isNativeSession()) return {};
  const headers = { "X-Sirius-Session": "native" };
  try {
    const refresh = window.localStorage.getItem(NATIVE_REFRESH_KEY);
    if (refresh) headers["X-Sirius-Refresh-Token"] = refresh;
  } catch { /* stockage indisponible : reconnexion manuelle */ }
  return headers;
};

export const setNativeRefreshToken = (token) => {
  if (!isNativeSession()) return;
  try {
    if (typeof token === "string" && token) window.localStorage.setItem(NATIVE_REFRESH_KEY, token);
    else window.localStorage.removeItem(NATIVE_REFRESH_KEY);
  } catch { /* stockage indisponible */ }
};
