import { withBackendResponse } from "./lib/backendRequest";
import { voiceIdentityStatus, voiceIdentityGuidance } from "./voiceIdentity";

async function serviceStatus({ signal }) {
  return withBackendResponse("/setup/status", { method: "GET" }, async (response) => {
    if (!response.ok) throw new Error(response.status === 401
      ? "Session expirée : reconnectez-vous à Sirius."
      : `Le serveur répond avec une erreur HTTP ${response.status}.`);
    const data = await response.json();
    if (!Array.isArray(data?.services)) throw new Error("Réponse du serveur invalide. Vérifiez sa mise à jour.");
    return data;
  }, { signal, timeoutMs: 10000 });
}

export async function collectVoiceDiagnostic({
  signal, services = serviceStatus, identity = voiceIdentityStatus,
  browser = navigator, recorderAvailable = typeof MediaRecorder !== "undefined",
  now = () => performance.now(),
} = {}) {
  const checked = async (id, label, request, describe) => {
    const start = now();
    try {
      const data = await request({ signal });
      if (signal?.aborted) throw new DOMException("Diagnostic annulé.", "AbortError");
      return { id, label, ...describe(data), ms: Math.round(now() - start) };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        id, label, state: "error", ms: Math.round(now() - start),
        detail: error.name === "AbortError"
          ? "Délai dépassé. Réessayez ; cela ne prouve pas une panne de votre Wi-Fi."
          : error.message || "Contrôle impossible. Réessayez.",
      };
    }
  };
  const permission = async () => {
    if (!browser.permissions?.query) return { state: "unknown", detail: "Permission non lisible ici. Vérifiez les réglages du système." };
    const result = await browser.permissions.query({ name: "microphone" });
    if (result.state === "denied") return { state: "error", detail: "Microphone refusé. Autorisez-le dans les réglages du navigateur ou de l'appareil." };
    return {
      state: "unknown",
      detail: result.state === "granted"
        ? "Permission accordée ; la capture et le son réel ne sont pas testés par ce contrôle."
        : "Autorisation à demander lors d'un appui volontaire sur le micro. Aucun accès demandé ici.",
    };
  };
  const [server, speaker, micPermission] = await Promise.all([
    checked("server", "Serveur et session", services, (data) => ({
      state: "ok",
      detail: `API authentifiée joignable. ${data.services.some((service) => service.id === "chat" && ["configured", "available"].includes(service.state))
        ? "Service de réponse déclaré configuré, sans test d'une réponse réelle."
        : "Service de réponse non confirmé : vérifiez vos réglages de compte."}`,
    })),
    checked("identity", "Vérification de votre voix", identity, (data) => ({
      state: data?.ready === true && data.enrolled === true ? "ok" : "error",
      detail: voiceIdentityGuidance(data),
    })),
    checked("permission", "Autorisation microphone", permission, (data) => data),
  ]);
  if (signal?.aborted) throw new DOMException("Diagnostic annulé.", "AbortError");
  return {
    measuredAt: new Date().toISOString(),
    checks: [
      { id: "network", label: "Connexion déclarée par l'appareil", state: browser.onLine === false ? "error" : "unknown",
        detail: browser.onLine === false ? "Appareil déclaré hors ligne. Vérifiez Wi-Fi ou données mobiles."
          : "Cet indicateur ne prouve pas l'accès Internet ; consultez le contrôle serveur ci-dessous." },
      server, speaker,
      { id: "capture", label: "Capture audio disponible", state: browser.mediaDevices?.getUserMedia && recorderAvailable ? "unknown" : "error",
        detail: browser.mediaDevices?.getUserMedia && recorderAvailable
          ? "Fonctions de capture présentes. Le microphone n'a pas été ouvert : son fonctionnement réel n'est pas vérifié."
          : "Capture audio non disponible ici. Utilisez l'application ou un navigateur compatible avec les permissions requises." },
      micPermission,
      { id: "voice", label: "Voix et haut-parleur", state: "unknown",
        detail: "Non testés. Ouvrez les réglages voix pour écouter une phrase de test et vérifier le volume. Aucun son n'est lancé par ce diagnostic." },
    ],
  };
}
