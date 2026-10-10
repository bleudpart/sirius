const ITERATIONS = 600000;
const MAX_FILE_BYTES = 128 * 1024;
const KEY_NAMES = ["groq_key", "groq", "serp", "fal", "gmaps", "alphavantage", "google_tts", "gemini_tts"];
const utf8 = (text) => new TextEncoder().encode(text);

function cryptoApi() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Le chiffrement nécessite une application ou une connexion HTTPS sécurisée.");
  }
  return globalThis.crypto;
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function decode(value, maxLength) {
  if (typeof value !== "string" || value.length > maxLength * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Coffre invalide.");
  }
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  if (bytes.length > maxLength) throw new Error("Coffre trop volumineux.");
  return bytes;
}

export function validateVaultKeys(keys) {
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new Error("Configuration de clés invalide.");
  const result = {};
  for (const [name, value] of Object.entries(keys)) {
    if (!KEY_NAMES.includes(name)) throw new Error(`Service non reconnu : ${name}.`);
    if (typeof value !== "string" || value.length > 4096) throw new Error("Clé de service invalide.");
    result[name] = value.trim();
  }
  return result;
}

export function checkVaultPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    throw new Error("Choisissez un mot de passe de coffre de 12 caractères minimum.");
  }
}

async function derive(password, salt, usages) {
  const subtle = cryptoApi().subtle;
  const material = await subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material, { name: "AES-GCM", length: 256 }, false, usages,
  );
}

export async function encryptVault(keys, password) {
  checkVaultPassword(password);
  const api = cryptoApi();
  const salt = api.getRandomValues(new Uint8Array(16));
  const iv = api.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt, ["encrypt"]);
  const plaintext = utf8(JSON.stringify({ keys: validateVaultKeys(keys) }));
  const ciphertext = await api.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8("SIRIUS-VAULT-1") }, key, plaintext,
  );
  return {
    format: "sirius.vault", version: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS,
    cipher: "AES-256-GCM", salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)),
  };
}

export function parseVault(text) {
  if (typeof text !== "string" || utf8(text).length > MAX_FILE_BYTES) {
    throw new Error("Coffre trop volumineux.");
  }
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw new Error("Ce fichier n'est pas un coffre SIRIUS valide."); }
  if (!envelope || envelope.format !== "sirius.vault" || envelope.version !== 1
    || envelope.kdf !== "PBKDF2-SHA256" || envelope.iterations !== ITERATIONS || envelope.cipher !== "AES-256-GCM") {
    throw new Error("Format de coffre non pris en charge.");
  }
  return envelope;
}

export async function decryptVault(envelope, password) {
  checkVaultPassword(password);
  const checked = parseVault(JSON.stringify(envelope));
  const salt = decode(checked.salt, 16);
  const iv = decode(checked.iv, 12);
  const ciphertext = decode(checked.ciphertext, MAX_FILE_BYTES);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new Error("Coffre invalide.");
  const key = await derive(password, salt, ["decrypt"]);
  let plaintext;
  try {
    plaintext = await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: utf8("SIRIUS-VAULT-1") }, key, ciphertext,
    );
  } catch (error) {
    if (error.name !== "OperationError") throw error;
    throw new Error("Mot de passe incorrect ou coffre altéré.");
  }
  return validateVaultKeys(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)).keys);
}
