import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpKitchenPage, { KITCHEN_STORAGE_KEY } from "./HaccpKitchenPage";

global.IS_REACT_ACT_ENVIRONMENT = true;
const TOKEN = "abcdefghijklmnopqrstuvwxyz0123";
let host, root, oldFetch, oldWakeLock;
const reply = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
beforeEach(() => {
  oldFetch = global.fetch;
  oldWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
  delete navigator.mediaDevices;
  localStorage.clear();
  window.history.replaceState(null, "", "/cuisine");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = oldFetch; jest.restoreAllMocks();
  if (oldWakeLock) Object.defineProperty(navigator, "wakeLock", oldWakeLock);
  else delete navigator.wakeLock;
});

test("without a token the page only asks to scan the chef's QR code", async () => {
  global.fetch = jest.fn();
  await act(async () => root.render(<HaccpKitchenPage />));
  expect(host.textContent).toContain("Scannez le QR code du chef");
  expect(global.fetch).not.toHaveBeenCalled();
});

test("the token from the QR code is remembered and opens the simple kitchen screen", async () => {
  window.history.replaceState(null, "", `/cuisine#k=${TOKEN}`);
  global.fetch = jest.fn(async () => reply({ restaurant_name: "Le Papillon" }));
  await act(async () => root.render(<HaccpKitchenPage />));
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/haccp\/cuisine\/session$/);
  expect(options.headers).toEqual({ "X-Sirius-Cuisine": TOKEN });
  expect(localStorage.getItem(KITCHEN_STORAGE_KEY)).toBe(TOKEN);
  expect(host.textContent).toContain("PHOTO");
  expect(host.textContent).toContain("RETROUVER");
  expect(host.textContent).toContain("Mode complet");
});

test("a saved token restores the link when the home-screen icon opens /cuisine", async () => {
  localStorage.setItem(KITCHEN_STORAGE_KEY, TOKEN);
  global.fetch = jest.fn(async () => reply({ restaurant_name: "Le Papillon" }));
  await act(async () => root.render(<HaccpKitchenPage />));
  expect(window.location.hash).toBe(`#k=${TOKEN}`);
  expect(global.fetch.mock.calls[0][1].headers).toEqual({ "X-Sirius-Cuisine": TOKEN });
});

test("a revoked QR code is forgotten and tells the cook to ask the chef", async () => {
  window.history.replaceState(null, "", `/cuisine#k=${TOKEN}`);
  global.fetch = jest.fn(async () => reply({ detail: "QR code cuisine désactivé. Demandez le nouveau QR code au chef." }, 401));
  await act(async () => root.render(<HaccpKitchenPage />));
  expect(host.textContent).toContain("Demandez le nouveau QR code au chef");
  expect(localStorage.getItem(KITCHEN_STORAGE_KEY)).toBeNull();
  expect(host.querySelector("button")).toBeNull();
});

test("a valid kitchen page keeps the screen on and releases it when leaving", async () => {
  const lock = { addEventListener: jest.fn(), release: jest.fn().mockResolvedValue() };
  const request = jest.fn().mockResolvedValue(lock);
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
  window.history.replaceState(null, "", `/cuisine#k=${TOKEN}`);
  global.fetch = jest.fn(async () => reply({ restaurant_name: "Le Papillon" }));

  await act(async () => root.render(<HaccpKitchenPage />));
  expect(request).toHaveBeenCalledWith("screen");
  expect(host.textContent).toContain("PHOTO");
  expect(host.textContent).not.toContain("Écran maintenu allumé pendant le service.");

  await act(async () => root.render(<div>Fermé</div>));
  expect(lock.release).toHaveBeenCalledTimes(1);
});

test("the kitchen page warns when the browser cannot keep the screen on", async () => {
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: undefined });
  window.history.replaceState(null, "", `/cuisine#k=${TOKEN}`);
  global.fetch = jest.fn(async () => reply({ restaurant_name: "Le Papillon" }));

  await act(async () => root.render(<HaccpKitchenPage />));
  expect(host.textContent).toContain("Ce navigateur ne permet pas de garder l’écran allumé.");
  expect(host.textContent).toContain("PHOTO");
});
