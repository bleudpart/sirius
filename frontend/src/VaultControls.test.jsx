import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { openKeys, sealKeys } from "./deviceKeyStore";
import VaultControls, { persistPersonalKeys } from "./VaultControls";
import { hasSavedPersonalKeys, loadApiKeys, restorePersonalKeys, setKeyAccount } from "./apiKeyStorage";

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
