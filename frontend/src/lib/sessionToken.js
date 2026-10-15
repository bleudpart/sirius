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
