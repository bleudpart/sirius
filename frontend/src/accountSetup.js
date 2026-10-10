import { withBackendResponse } from "@/lib/backendRequest";

export async function validatePersonalService(service, key) {
  return withBackendResponse("/keys/validate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service, key }),
  }, async (response) => {
    const result = await response.json();
    return {
      ...result, ok: response.ok && result.ok === true,
      message: result.message || (typeof result.detail === "string" ? result.detail : "Vérification non réussie."),
    };
  }, { timeoutMs: 20000 });
}

export async function readAccountSetup(fetchImpl = fetch) {
  try {
    return await withBackendResponse("/setup/status", {}, async (response) => {
      const data = await response.json();
      if (!response.ok) {
        throw new Error(typeof data.detail === "string" ? data.detail : response.status === 401
          ? "Connectez-vous à votre compte SIRIUS pour vérifier les services."
          : "Vérification des services indisponible. Réessayez.");
      }
      if (data.mode !== "trial_then_personal" || !Array.isArray(data.services)) {
        throw new Error("Le serveur doit être mis à jour pour l'essai et les clés personnelles.");
      }
      return data;
    }, { timeoutMs: 20000, fetchImpl });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("La vérification des services a dépassé le délai. Réessayez.");
    throw error;
  }
}

const PROFILE_FIELDS = ["name", "age", "profession", "city", "gender", "interests", "style"];

export function exportAccountProfile(profile) {
  return {
    profile: Object.fromEntries(PROFILE_FIELDS.filter((key) => typeof profile?.[key] === "string")
      .map((key) => [key, profile[key]])),
    _app: "ΣIRIUS",
    _version: 2,
  };
}

export function importAccountProfile(data) {
  if (!data || typeof data !== "object" || !data.profile || typeof data.profile !== "object"
    || Array.isArray(data.profile)) {
    throw new Error("Ce fichier ne contient pas de profil SIRIUS valide.");
  }
  return { profile: exportAccountProfile(data.profile).profile, ignoredKeys: Boolean(data.keys) };
}
