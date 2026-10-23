import { withBackendResponse } from "./lib/backendRequest";

const messages = {
  no_profile: "Enregistrez votre voix dans « Ma voix et ma diction » avant l'écoute continue. Le bouton maintenu reste disponible.",
  speaker_mismatch: "Voix non reconnue : demande ignorée. Utilisez le bouton maintenu si nécessaire.",
  insufficient_audio: "Extrait trop court ou peu audible : demande ignorée. Parlez au moins 3 secondes ou utilisez le bouton micro maintenu pour une demande courte.",
};

export function voiceIdentityGuidance(status) {
  if (status?.reason === "model_changed") return "Le modèle vocal a changé. Supprimez l'ancienne empreinte dans « Ma voix et ma diction », puis créez-en une nouvelle.";
  if (["operator_disabled", "threshold_not_configured", "model_checksum_not_configured", "model_missing"].includes(status?.reason)) {
    return "La protection vocale n'est pas activée ou configurée sur le serveur. L'exploitant doit terminer son installation ; utilisez le bouton micro maintenu en attendant.";
  }
  if (status?.ready !== true) return "Moteur de vérification vocale indisponible sur le serveur. Le bouton maintenu reste disponible.";
  if (status.enrolled !== true) return messages.no_profile;
  return "Profil vocal prêt. Cela ne prouve pas le rejet de la télévision ; un essai réel reste nécessaire.";
}

const readJson = async (response) => {
  const data = await response.json();
  if (!response.ok) throw new Error(response.status === 401
    ? "Session expirée. Reconnectez-vous à Sirius pour utiliser votre profil vocal."
    : typeof data?.detail === "string" ? data.detail : "Vérification vocale indisponible. Utilisez le bouton maintenu.");
  return data;
};

async function identityRequest(path, options, { signal, timeoutMs }) {
  try {
    return await withBackendResponse(path, options, readJson, { signal, timeoutMs });
  } catch (error) {
    if (error.name === "AbortError" && !signal?.aborted) {
      throw new Error("Le serveur n'a pas terminé la vérification vocale dans le délai prévu. Réessayez ou utilisez le bouton micro maintenu ; la cause réseau n'est pas confirmée.");
    }
    throw error;
  }
}

export function voiceIdentityStatus({ signal } = {}) {
  return identityRequest("/voice-identity/status", { method: "GET" }, { signal, timeoutMs: 15000 });
}

export async function requireVoiceIdentity({ signal } = {}) {
  const status = await voiceIdentityStatus({ signal });
  if (status?.ready !== true || status.enrolled !== true) throw new Error(voiceIdentityGuidance(status));
  return status;
}

export function enrollVoiceIdentity(samples, { signal } = {}) {
  const body = new FormData();
  samples.forEach((sample, index) => body.append("files", sample.audio, `reference-${index + 1}.${sample.audio.type.includes("wav") ? "wav" : sample.audio.type.includes("mp4") ? "m4a" : "webm"}`));
  body.append("consent", "true");
  return identityRequest("/voice-identity/enroll", { method: "POST", body }, { signal, timeoutMs: 60000 });
}

export function deleteVoiceIdentity({ signal } = {}) {
  return identityRequest("/voice-identity/profile", { method: "DELETE" }, { signal, timeoutMs: 15000 });
}

export async function verifyVoiceIdentity(audio, { signal } = {}) {
  const body = new FormData();
  body.append("file", audio, `utterance.${audio.type.includes("wav") ? "wav" : audio.type.includes("mp4") ? "m4a" : "webm"}`);
  const result = await identityRequest("/voice-identity/verify", { method: "POST", body }, { signal, timeoutMs: 20000 });
  if (!result || typeof result.verified !== "boolean") throw new Error("Réponse de vérification vocale invalide. Demande ignorée.");
  if (result.verified && result.reason !== "speaker_match") throw new Error("Réponse de vérification vocale incohérente. Demande ignorée.");
  if (!result.verified && !["speaker_mismatch", "insufficient_audio"].includes(result.reason)) {
    throw new Error("Vérification vocale indisponible ou profil à recréer. L'écoute continue est arrêtée ; utilisez le bouton maintenu.");
  }
  return { ...result, message: messages[result.reason] || "Voix non reconnue ou son insuffisant : demande ignorée." };
}
