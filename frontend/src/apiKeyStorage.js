const STORAGE_KEY = "sirius_keys";

export function loadApiKeys() {
  try {
    const sessionValue = sessionStorage.getItem(STORAGE_KEY);
    if (sessionValue) return JSON.parse(sessionValue) || {};
    const legacyValue = localStorage.getItem(STORAGE_KEY);
    if (!legacyValue) return {};
    sessionStorage.setItem(STORAGE_KEY, legacyValue);
    return JSON.parse(legacyValue) || {};
  } catch (_) {
    return {};
  }
}

export function saveApiKeys(keys) {
  try {
    const serialized = JSON.stringify(keys || {});
    sessionStorage.setItem(STORAGE_KEY, serialized);
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch (_) {
    // La session peut être indisponible en mode navigation privée très restreint.
  }
}