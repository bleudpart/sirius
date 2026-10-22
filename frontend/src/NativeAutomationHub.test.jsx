import { act } from "react";
import { createRoot } from "react-dom/client";
import NativeAutomationHub from "./NativeAutomationHub";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host, bridge, original, state, listener, unsubscribe, review, requestOpen;
const initial = () => ({ shortcut: false, notifications: false, resume: false, folder: null, events: [] });
beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  original = window.siriusNative;
  state = initial(); unsubscribe = jest.fn(); review = jest.fn(); requestOpen = jest.fn();
  bridge = {
    begin: jest.fn(async () => ({ token: "session", state })),
    configure: jest.fn(async (_token, options) => { state = { ...state, ...options }; return state; }),
    chooseFolder: jest.fn(async () => { state = { ...state, folder: "C:\\Selected" }; return state; }),
    unwatch: jest.fn(async () => { state = { ...state, folder: null }; return state; }),
    stop: jest.fn(async () => initial()),
    onEvent: jest.fn((callback) => { listener = callback; return unsubscribe; }),
  };
  window.siriusNative = bridge;
});
afterEach(() => { act(() => root.unmount()); host.remove(); window.siriusNative = original; });
const mount = (open = true) => act(async () => root.render(<NativeAutomationHub open={open}
  onClose={() => {}} onReview={review} onRequestOpen={requestOpen} />));
const click = (text) => act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === text).click());

test("default disabled; each hook requires opt-in and folder selection is native", async () => {
  await mount();
  expect(bridge.configure).not.toHaveBeenCalled();
  expect(bridge.chooseFolder).not.toHaveBeenCalled();
  expect([...host.querySelectorAll('input[type="checkbox"]')].every((input) => !input.checked)).toBe(true);
  await act(async () => host.querySelector('input[type="checkbox"]').click());
  expect(bridge.configure).toHaveBeenCalledWith("session", { shortcut: true, resume: false, notifications: false });
  await click("Choisir le dossier à surveiller");
  expect(bridge.chooseFolder).toHaveBeenCalledWith("session");
  expect(host.textContent).toContain("C:\\Selected");
  await click("Arrêter la surveillance du dossier");
  expect(bridge.unwatch).toHaveBeenCalledWith("session");
  expect(host.textContent).toContain("Aucun dossier surveillé");
  await click("Consulter les rappels et tâches en attente");
  expect(review).toHaveBeenCalledTimes(1);
});

test("hidden panel keeps hooks; unmount and account switch stop them and unsubscribe", async () => {
  await mount(); await mount(false);
  expect(bridge.stop).not.toHaveBeenCalled();
  expect(host.textContent).toBe("");
  await act(async () => listener({ ...state, events: [{ id: "e", kind: "review", message: "Consulter" }] }));
  expect(requestOpen).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  root = createRoot(host);
  expect(bridge.stop).toHaveBeenCalledWith("session");
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test("native errors are explicit and never shown as enabled", async () => {
  await mount();
  bridge.configure.mockRejectedValueOnce(new Error("Raccourci déjà utilisé"));
  await act(async () => host.querySelector('input[type="checkbox"]').click());
  expect(host.querySelector('[role="alert"]').textContent).toContain("déjà utilisé");
  expect(host.querySelector('input[type="checkbox"]').checked).toBe(false);
});

test("web/mobile do not attempt IPC and explain desktop-only support", async () => {
  delete window.siriusNative;
  await mount();
  expect(host.textContent).toContain("uniquement dans l'application Windows Electron");
  expect(bridge.begin).not.toHaveBeenCalled();
});
