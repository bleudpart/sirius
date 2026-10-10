import React, { act } from "react";
import { createRoot } from "react-dom/client";
import VaultControls from "./VaultControls";
import { encryptVault } from "./configurationVault";
import { loadApiKeys, readStoredVault, setKeyAccount } from "./apiKeyStorage";

jest.mock("./configurationVault", () => ({
  ...jest.requireActual("./configurationVault"),
  encryptVault: jest.fn(),
  decryptVault: jest.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host;
let root;
let onKeys;
let validateKeys;
const envelope = { ciphertext: "ciphertext-not-a-key" };

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); setKeyAccount("one");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  onKeys = jest.fn(); validateKeys = jest.fn().mockResolvedValue();
  encryptVault.mockResolvedValue(envelope);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setKeyAccount(""); jest.restoreAllMocks(); });
const input = (id, value) => {
  const element = host.querySelector(`[data-testid="${id}"]`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const render = () => act(() => root.render(
  <VaultControls keys={{ groq_key: "my-personal-key" }} onKeys={onKeys} validateKeys={validateKeys}>Champs</VaultControls>,
));
const password = () => { input("vault-password", "my-long-password"); input("vault-confirm", "my-long-password"); };

test("protection tests services then stores ciphertext and removes legacy cache", async () => {
  localStorage.setItem("sirius_keys", '{"groq_key":"old-key"}');
  render(); password();
  await act(async () => host.querySelector('[data-testid="vault-save"]').click());
  expect(validateKeys).toHaveBeenCalledWith({ groq_key: "my-personal-key" });
  expect(readStoredVault()).toBe(JSON.stringify(envelope));
  expect(loadApiKeys()).toEqual({ groq_key: "my-personal-key" });
  expect(localStorage.getItem("sirius_keys")).toBeNull();
  expect(host.textContent).toContain("Coffre chiffré enregistré");
});

test("a refused service leaves legacy keys intact and does not activate or store them", async () => {
  localStorage.setItem("sirius_keys", '{"groq_key":"old-key"}');
  validateKeys.mockRejectedValue(new Error("Clé refusée."));
  render(); password();
  await act(async () => host.querySelector('[data-testid="vault-save"]').click());
  expect(readStoredVault()).toBeNull();
  expect(loadApiKeys()).toEqual({});
  expect(localStorage.getItem("sirius_keys")).not.toBeNull();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Clé refusée");
});

test("short passwords fail before provider tests", async () => {
  render(); input("vault-password", "short"); input("vault-confirm", "short");
  await act(async () => host.querySelector('[data-testid="vault-save"]').click());
  expect(validateKeys).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]').textContent).toContain("12 caractères");
});

test.each([true, false])("unverifiable keys require explicit storage consent (%s)", async (accepted) => {
  validateKeys.mockResolvedValue(["Clé fal.ai"]);
  jest.spyOn(window, "confirm").mockReturnValue(accepted);
  render(); password();
  await act(async () => host.querySelector('[data-testid="vault-save"]').click());
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("sans les déclarer fonctionnelles"));
  expect(encryptVault).toHaveBeenCalledTimes(accepted ? 1 : 0);
  expect(Boolean(readStoredVault())).toBe(accepted);
  expect(loadApiKeys()).toEqual(accepted ? { groq_key: "my-personal-key" } : {});
  if (accepted) expect(host.textContent).toContain("Services non vérifiés : Clé fal.ai");
});

test("changing accounts during encryption cannot store keys under the new account", async () => {
  let complete;
  encryptVault.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  render(); password();
  await act(async () => host.querySelector('[data-testid="vault-save"]').click());
  setKeyAccount("two");
  await act(async () => complete(envelope));
  expect(readStoredVault()).toBeNull();
  expect(loadApiKeys()).toEqual({});
  expect(host.querySelector('[role="alert"]').textContent).toContain("compte a changé");
});
