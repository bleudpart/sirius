const STORAGE_KEY = "sirius_keys";

export function loadApiKeys() {
  try {
    const sessionValue = sessionStorage.getItem(STORAGE_KEY);
    if (sessionValue) return JSON.parse(sessionValue) || {};
    const legacyValue = localStorage.getItem(STORAGE_KEY);
    if (!legacyValue) return {};
    sessionStorage.setItem(STORAGE_KEY, legacyValue);
    localStorage.removeItem(STORAGE_KEY);
    return JSON.parse(legacyValue) || {};
  } catch (_) {
    return {};
  }
}

export function saveApiKeys(keys) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(keys || {}));
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {
    // La session peut être indisponible en mode navigation privée très restreint.
  }
}