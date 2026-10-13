import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { openKeys, sealKeys } from "./deviceKeyStore";
import VaultControls, { persistPersonalKeys } from "./VaultControls";
import { hasSavedPersonalKeys, loadApiKeys, restorePersonalKeys, setKeyAccount } from "./apiKeyStorage";
import { decryptVault } from "./configurationVault";

global.TextEncoder = require("util").TextEncoder;

jest.mock("./configurationVault", () => ({
  ...jest.requireActual("./configurationVault"),
  decryptVault: jest.fn(),
}));

jest.mock("./deviceKeyStore", () => ({
  sealKeys: jest.fn(),
  openKeys: jest.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host;
let root;
let onKeys;
let validateKeys;

beforeEach(() => {
  sealKeys.mockImplementation(async (keys) => ({ sealed: JSON.stringify(keys) }));
  openKeys.mockImplementation(async (envelope) => JSON.parse(envelope.sealed));
  localStorage.clear(); sessionStorage.clear(); setKeyAccount("one");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  onKeys = jest.fn(); validateKeys = jest.fn().mockResolvedValue([]);
  decryptVault.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); setKeyAccount(""); jest.restoreAllMocks(); });
const render = () => act(() => root.render(
  <VaultControls onKeys={onKeys} validateKeys={validateKeys}>Champs</VaultControls>,
));
const keys = { groq_key: "my-personal-key" };

test("saving tests the keys, stores them on the device and activates them without a password", async () => {
  localStorage.setItem("sirius_keys", '{"groq_key":"old-key"}');
  const result = await persistPersonalKeys(keys, validateKeys);
  expect(result).toEqual(expect.objectContaining({ unverified: [] }));
  expect(validateKeys).toHaveBeenCalledWith(keys);
  expect(hasSavedPersonalKeys()).toBe(true);
  expect(loadApiKeys()).toEqual(keys);
  expect(localStorage.getItem("sirius_keys")).toBeNull();
});
test("the panel has no separate save button and shows the saved status", async () => {
  await persistPersonalKeys(keys, validateKeys);
  render();
  expect(host.querySelector('[data-testid="vault-save"]')).toBeNull();
  expect(host.textContent).toContain("ENREGISTRER");
  expect(host.querySelector('[data-testid="vault-saved-status"]')).not.toBeNull();
});

test("saved keys reload automatically when the account is set again", async () => {
  await persistPersonalKeys(keys, validateKeys);
  setKeyAccount("");
  expect(loadApiKeys()).toEqual({});
  setKeyAccount("one");
  await restorePersonalKeys();
  expect(loadApiKeys()).toEqual(keys);
});

test("a refused service is neither stored nor activated", async () => {
  validateKeys.mockRejectedValue(new Error("Clé refusée."));
  await expect(persistPersonalKeys(keys, validateKeys)).rejects.toThrow("Clé refusée");
  expect(hasSavedPersonalKeys()).toBe(false);
  expect(loadApiKeys()).toEqual({});
});

test.each([true, false])("unverifiable keys require explicit consent (%s)", async (accepted) => {
  validateKeys.mockResolvedValue(["Clé fal.ai"]);
  jest.spyOn(window, "confirm").mockReturnValue(accepted);
  const result = await persistPersonalKeys(keys, validateKeys);
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Clé fal.ai"));
  expect(Boolean(result)).toBe(accepted);
  expect(hasSavedPersonalKeys()).toBe(accepted);
  expect(loadApiKeys()).toEqual(accepted ? keys : {});
});

test("changing accounts during encryption cannot store keys under the new account", async () => {
  let complete;
  sealKeys.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const pending = persistPersonalKeys(keys, validateKeys);
  while (!complete) await Promise.resolve();
  setKeyAccount("two");
  complete({ sealed: "{}" });
  await expect(pending).rejects.toThrow("compte a changé");
  expect(hasSavedPersonalKeys()).toBe(false);
  expect(loadApiKeys()).toEqual({});
});

test("advanced section can forget keys from the device", async () => {
  await persistPersonalKeys(keys, validateKeys);
  render();
  jest.spyOn(window, "confirm").mockReturnValue(true);
  await act(async () => host.querySelector('[data-testid="vault-forget"]').click());
  expect(hasSavedPersonalKeys()).toBe(false);
  expect(loadApiKeys()).toEqual({});
});

const chooseFile = (file) => act(() => {
  const input = host.querySelector('[data-testid="vault-import"]');
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
const enterImportPassword = () => act(() => {
  const input = host.querySelector('[data-testid="vault-import-password"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "test-password-123");
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const vaultFile = () => ({
  name: "sirius.vault", size: 100,
  text: async () => JSON.stringify({
    format: "sirius.vault", version: 1, kdf: "PBKDF2-SHA256", iterations: 600000, cipher: "AES-256-GCM",
  }),
});

test("one visible import button opens the file picker outside advanced controls", () => {
  render();
  const input = host.querySelector('[data-testid="vault-import"]');
  const click = jest.spyOn(input, "click");
  act(() => host.querySelector('[data-testid="vault-import-button"]').click());
  expect(click).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[data-testid="vault-import-button"]').closest("details")).toBeNull();
});

test("import decrypts, validates and saves keys without a second save step", async () => {
  render();
  decryptVault.mockResolvedValue(keys);
  chooseFile(vaultFile());
  enterImportPassword();
  await act(async () => host.querySelector('[data-testid="vault-restore"]').click());
  expect(decryptVault).toHaveBeenCalledWith(expect.objectContaining({ format: "sirius.vault" }), "test-password-123");
  expect(validateKeys).toHaveBeenCalledWith(keys);
  expect(loadApiKeys()).toEqual(keys);
  expect(onKeys).toHaveBeenCalledWith(keys);
  expect(host.querySelector('[data-testid="vault-import-password"]')).toBeNull();
  expect(host.textContent).toContain("Coffre importé");
});

test("wrong password preserves the chosen file and does not replace existing keys", async () => {
  await persistPersonalKeys(keys, validateKeys);
  render();
  decryptVault.mockRejectedValue(new Error("Mot de passe incorrect ou coffre altéré."));
  chooseFile(vaultFile());
  enterImportPassword();
  await act(async () => host.querySelector('[data-testid="vault-restore"]').click());
  expect(host.querySelector('[role="alert"]').textContent).toContain("Mot de passe incorrect");
  expect(host.querySelector('[data-testid="vault-restore"]')).not.toBeNull();
  expect(loadApiKeys()).toEqual(keys);
  expect(onKeys).not.toHaveBeenCalled();
});

test("oversized file is rejected before decryption", () => {
  render();
  chooseFile({ ...vaultFile(), size: 128 * 1024 + 1 });
  expect(host.querySelector('[role="alert"]').textContent).toContain("volumineux");
  expect(decryptVault).not.toHaveBeenCalled();
});

test("cancelling import removes the file and password", () => {
  render();
  chooseFile(vaultFile());
  enterImportPassword();
  act(() => host.querySelector('[data-testid="vault-import-cancel"]').click());
  expect(host.querySelector('[data-testid="vault-import-password"]')).toBeNull();
  expect(decryptVault).not.toHaveBeenCalled();
});
