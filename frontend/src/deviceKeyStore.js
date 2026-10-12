// Clés personnelles chiffrées avec une clé AES propre à cet appareil.
// La clé AES est non exportable et conservée dans IndexedDB : aucun mot de passe à retenir.
const DB_NAME = "sirius-device-keys";
const STORE = "keys";
const KEY_ID = "aes-gcm-v1";
const FORMAT = "sirius.device-keys";
const utf8 = (text) => new TextEncoder().encode(text);
const AAD = "SIRIUS-DEVICE-KEYS-1";

let keyPromise = null;

function subtleApi() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Le chiffrement nécessite une application ou une connexion HTTPS sécurisée.");
  }
  return globalThis.crypto;
}

function request(operation) {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error("Stockage sécurisé indisponible sur cet appareil."));
  }
  const opening = globalThis.indexedDB.open(DB_NAME, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
  return request(opening);
}

async function loadOrCreateDeviceKey() {
  const db = await openDatabase();
  try {
    const existing = await request(db.transaction(STORE, "readonly").objectStore(STORE).get(KEY_ID));
    if (existing) return existing;
    const created = await subtleApi().subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(created, KEY_ID));
    return created;
  } finally {
    db.close();
  }
}

function deviceKey() {
  if (!keyPromise) {
    keyPromise = loadOrCreateDeviceKey().catch((error) => { keyPromise = null; throw error; });
  }
  return keyPromise;
}

const encode = (bytes) => btoa(String.fromCharCode(...bytes));
const decode = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

export async function sealKeys(keys) {
  const api = subtleApi();
  const iv = api.getRandomValues(new Uint8Array(12));
  const ciphertext = await api.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(AAD) }, await deviceKey(), utf8(JSON.stringify({ keys })),
  );
  return { format: FORMAT, version: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}

export async function openKeys(envelope) {
  if (!envelope || envelope.format !== FORMAT || envelope.version !== 1
    || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("Clés enregistrées illisibles sur cet appareil.");
  }
  let plaintext;
  try {
    plaintext = await subtleApi().subtle.decrypt(
      { name: "AES-GCM", iv: decode(envelope.iv), additionalData: utf8(AAD) }, await deviceKey(), decode(envelope.ciphertext),
    );
  } catch {
    throw new Error("Clés enregistrées illisibles sur cet appareil. Collez-les à nouveau.");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)).keys || {};
}
