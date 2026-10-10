const { webcrypto } = require("crypto");
const { TextEncoder, TextDecoder } = require("util");
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;
Object.defineProperty(global, "crypto", { configurable: true, value: webcrypto });
const { encryptVault, decryptVault, parseVault, validateVaultKeys } = require("./configurationVault");
const { exportAccountProfile, importAccountProfile } = require("./accountSetup");
const { loadApiKeys, saveApiKeys, lockApiKeys, setKeyAccount, storeVault, readStoredVault, readLegacyKeys, removeLegacyKeys } = require("./apiKeyStorage");

afterEach(() => {
  lockApiKeys();
  setKeyAccount("");
  localStorage.clear();
  sessionStorage.clear();
});

test("vault encrypts keys, authenticates content and rejects the wrong password", async () => {
  const keys = { groq_key: "personal-test-key", serp: "personal-web-key" };
  const envelope = await encryptVault(keys, "long-unique-password");
  expect(JSON.stringify(envelope)).not.toContain("personal-test-key");
  expect(envelope.iterations).toBe(600000);
  expect(await decryptVault(parseVault(JSON.stringify(envelope)), "long-unique-password")).toEqual(keys);
  await expect(decryptVault(envelope, "wrong-long-password")).rejects.toThrow("Mot de passe incorrect");
  const altered = { ...envelope, ciphertext: (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1) };
  await expect(decryptVault(altered, "long-unique-password")).rejects.toThrow("coffre altéré");
}, 60000);

test("version, KDF cost, service types and size are bounded before decryption", async () => {
  expect(() => parseVault('{"format":"sirius.vault","version":9}')).toThrow();
  expect(() => parseVault(" ".repeat(128 * 1024 + 1))).toThrow("volumineux");
  expect(() => validateVaultKeys({ groq_key: 42 })).toThrow();
  expect(() => validateVaultKeys({ administrator: "yes" })).toThrow("Service non reconnu");
  await expect(encryptVault({ groq_key: "key" }, "short")).rejects.toThrow("12 caractères");
});

test("session keys never persist in cleartext and are isolated when changing accounts", async () => {
  setKeyAccount("account-one");
  const envelope = await encryptVault({ groq_key: "personal-test-key" }, "long-unique-password");
  storeVault(envelope);
  saveApiKeys({ groq_key: "personal-test-key" });
  expect(loadApiKeys().groq_key).toBe("personal-test-key");
  expect(localStorage.getItem("sirius_keys")).toBeNull();
  expect(sessionStorage.getItem("sirius_keys")).toBeNull();
  setKeyAccount("account-two");
  expect(loadApiKeys()).toEqual({});
  expect(readStoredVault()).toBeNull();
  setKeyAccount("account-one");
  expect(readStoredVault()).toBe(JSON.stringify(envelope));
  expect(loadApiKeys()).toEqual({});
}, 30000);

test("legacy keys are not silently deleted or used before consented migration", () => {
  localStorage.setItem("sirius_keys", '{"groq_key":"legacy-personal-key"}');
  expect(loadApiKeys()).toEqual({});
  expect(readLegacyKeys()).toEqual({ groq_key: "legacy-personal-key" });
  expect(localStorage.getItem("sirius_keys")).not.toBeNull();
  removeLegacyKeys();
  expect(readLegacyKeys()).toBeNull();
});

test("profile transfer excludes secrets and cannot import roles or legacy keys", () => {
  const profile = { name: "Daniel", role: "admin", keys: { groq_key: "secret" } };
  expect(exportAccountProfile(profile)).toEqual({ profile: { name: "Daniel" }, _app: "ΣIRIUS", _version: 2 });
  expect(importAccountProfile({ profile, keys: { groq_key: "secret" } }))
    .toEqual({ profile: { name: "Daniel" }, ignoredKeys: true });
});
