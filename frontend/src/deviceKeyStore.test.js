import { webcrypto } from "crypto";
import { TextDecoder, TextEncoder } from "util";

function fakeIndexedDb() {
  const data = new Map();
  const request = (result) => {
    const req = { result };
    setTimeout(() => req.onsuccess && req.onsuccess());
    return req;
  };
  const db = {
    createObjectStore: () => {},
    close: () => {},
    transaction: () => ({ objectStore: () => ({
      get: (id) => request(data.get(id)),
      put: (value, id) => { data.set(id, value); return request(id); },
    }) }),
  };
  return { open: () => {
    const req = request(db);
    setTimeout(() => req.onupgradeneeded && req.onupgradeneeded());
    return req;
  } };
}

const saved = {};
beforeAll(() => {
  for (const name of ["crypto", "indexedDB", "TextEncoder", "TextDecoder"]) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDb() });
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
});
afterAll(() => {
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

test("keys are sealed with the device key and reopened without a password", async () => {
  const { openKeys, sealKeys } = require("./deviceKeyStore");
  const envelope = await sealKeys({ cerebras: "csk-secret-value" });
  expect(JSON.stringify(envelope)).not.toContain("csk-secret-value");
  await expect(openKeys(envelope)).resolves.toEqual({ cerebras: "csk-secret-value" });
});

test("tampered envelopes are rejected", async () => {
  const { openKeys, sealKeys } = require("./deviceKeyStore");
  const envelope = await sealKeys({ groq_key: "gsk-secret" });
  const bytes = Uint8Array.from(atob(envelope.ciphertext), (char) => char.charCodeAt(0));
  bytes[0] ^= 1;
  const altered = { ...envelope, ciphertext: btoa(String.fromCharCode(...bytes)) };
  await expect(openKeys(altered)).rejects.toThrow("illisibles");
});
