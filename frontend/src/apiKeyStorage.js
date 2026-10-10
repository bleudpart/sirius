import { BACKEND_BASE_URL } from "@/lib/api";

const STORAGE_KEY = "sirius_keys";
let sessionKeys = {};
let accountId = "";
export const KEY_STORAGE_EVENT = "sirius-vault-changed";

export function loadApiKeys() {
  return { ...sessionKeys };
}

export function personalMarketHeaders() {
  const key = loadApiKeys().alphavantage;
  if (!key) return {};
  assertSecureKeyTransport();
  return { "X-Sirius-Alphavantage-Key": key };
}

export function saveApiKeys(keys) {
  if (Object.values(keys || {}).some(Boolean)) assertSecureKeyTransport();
  sessionKeys = { ...(keys || {}) };
  window.dispatchEvent(new Event(KEY_STORAGE_EVENT));
}

export function assertSecureKeyTransport() {
  const url = new URL(BACKEND_BASE_URL);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Les clés personnelles nécessitent un backend HTTPS ou local à cet appareil.");
  }
}

export function lockApiKeys() {
  saveApiKeys({});
}

export function setKeyAccount(id) {
  if (accountId === id) return;
  accountId = id || "";
  lockApiKeys();
}

export function vaultStorageKey() {
  if (!accountId) throw new Error("Connectez-vous avant d'enregistrer votre coffre.");
  return `sirius_vault_v1:${accountId}`;
}

export function readStoredVault() {
  return localStorage.getItem(vaultStorageKey());
}

export function assertKeyAccount(expectedStorageKey) {
  if (vaultStorageKey() !== expectedStorageKey) {
    throw new Error("Le compte a changé. Recommencez l'opération du coffre.");
  }
}

export function storeVault(envelope, expectedStorageKey = vaultStorageKey()) {
  assertKeyAccount(expectedStorageKey);
  localStorage.setItem(vaultStorageKey(), JSON.stringify(envelope));
}

export function readLegacyKeys() {
  const raw = sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const keys = JSON.parse(raw);
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error("L'ancienne configuration de clés est invalide.");
  }
  return keys;
}

export function removeLegacyKeys() {
  for (const storage of [localStorage, sessionStorage]) {
    storage.removeItem(STORAGE_KEY);
  }
}
