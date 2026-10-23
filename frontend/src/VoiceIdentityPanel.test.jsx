import { act } from "react";
import { createRoot } from "react-dom/client";
import VoiceIdentityPanel from "./VoiceIdentityPanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
let host;
let api;
let record;
let callback;
let session;
let before;
const click = async (label) => act(async () => {
  [...host.querySelectorAll("button")].find((button) => button.textContent === label).click();
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  api = {
    status: jest.fn(async () => ({ ready: true, enrolled: false })),
    enroll: jest.fn(async () => ({ enrolled: true })),
    remove: jest.fn(async () => ({ deleted: true })),
  };
  session = { cancel: jest.fn(), stop: jest.fn() };
  before = jest.fn(async () => {});
  record = jest.fn(async (options) => { callback = options; return session; });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const mount = async (account = "A") => act(async () => root.render(
  <VoiceIdentityPanel key={account} account={account} api={api} record={record} onBeforeRecord={before} onClose={() => {}} />
));
const sample = () => ({ duration: 4, audio: new Blob(["reference"], { type: "audio/webm" }) });
const consent = async () => act(async () => host.querySelector('input[type="checkbox"]').click());

test("opening never requests microphone or uploads references; explicit consent and send are required", async () => {
  await mount();
  expect(record).not.toHaveBeenCalled();
  expect(api.enroll).not.toHaveBeenCalled();
  await click("Enregistrer une référence vocale");
  expect(record).not.toHaveBeenCalled();
  await consent();
  for (let index = 0; index < 3; index += 1) {
    await click("Enregistrer une référence vocale");
    await act(async () => callback.onReady(sample()));
  }
  expect(before).toHaveBeenCalledTimes(3);
  expect(api.enroll).not.toHaveBeenCalled();
  api.status.mockResolvedValue({ ready: true, enrolled: true });
  await click("Envoyer et activer mon profil vocal");
  expect(api.enroll).toHaveBeenCalledWith([sample(), sample(), sample()], { signal: expect.any(AbortSignal) });
  expect(host.textContent).toContain("Profil vocal enregistré");
  expect(host.textContent).toContain("0/3 extraits");
});

test("insufficient audio is not added and unavailable engine cannot record", async () => {
  await mount();
  await consent();
  await click("Enregistrer une référence vocale");
  await act(async () => callback.onReady({ ...sample(), duration: 1 }));
  expect(host.textContent).toContain("3 à 15 secondes");
  expect(host.textContent).toContain("0/3 extraits");
  expect(api.enroll).not.toHaveBeenCalled();
  api.status.mockResolvedValue({ ready: false, enrolled: false });
  await mount("B");
  await consent();
  await click("Enregistrer une référence vocale");
  expect(record).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Moteur non disponible");
});

test("changing account aborts pending operations and discards references", async () => {
  await mount();
  await consent();
  await click("Enregistrer une référence vocale");
  const oldCallback = callback;
  const oldSignal = api.status.mock.calls[0][0].signal;
  await mount("B");
  expect(oldSignal.aborted).toBe(true);
  expect(session.cancel).toHaveBeenCalled();
  await act(async () => oldCallback.onReady(sample()));
  expect(host.textContent).toContain("0/3 extraits");
  expect(host.querySelector('input[type="checkbox"]').checked).toBe(false);
  expect(api.enroll).not.toHaveBeenCalled();
});

test("deleting the server profile requires confirmation and stops existing voice first", async () => {
  api.status.mockResolvedValue({ ready: true, enrolled: true });
  await mount();
  await click("Supprimer mon empreinte serveur");
  expect(api.remove).not.toHaveBeenCalled();
  api.status.mockResolvedValue({ ready: true, enrolled: false });
  await click("Confirmer la suppression serveur");
  expect(before).toHaveBeenCalledTimes(1);
  expect(api.remove).toHaveBeenCalledTimes(1);
  expect(before.mock.invocationCallOrder[0]).toBeLessThan(api.remove.mock.invocationCallOrder[0]);
  expect(host.textContent).toContain("Empreinte vocale supprimée");
});

test("a changed model can be recovered by deleting the stale profile and refreshing readiness", async () => {
  api.status.mockResolvedValue({ ready: false, enrolled: true, reason: "model_changed", needs_reenrollment: true });
  await mount();
  expect(host.textContent).toContain("Le modèle vocal a changé");
  await consent();
  await click("Enregistrer une référence vocale");
  expect(record).not.toHaveBeenCalled();
  await click("Supprimer mon empreinte serveur");
  api.status.mockResolvedValue({ ready: true, enrolled: false });
  await click("Confirmer la suppression serveur");
  await consent();
  await click("Enregistrer une référence vocale");
  expect(record).toHaveBeenCalledTimes(1);
});

test("failed enrollment never displays success and preserves reference retry", async () => {
  await mount();
  await consent();
  for (let index = 0; index < 3; index += 1) {
    await click("Enregistrer une référence vocale");
    await act(async () => callback.onReady(sample()));
  }
  api.enroll.mockRejectedValue(new Error("Références incohérentes"));
  await click("Envoyer et activer mon profil vocal");
  expect(host.querySelector('[role="alert"]').textContent).toBe("Références incohérentes");
  expect(host.textContent).not.toContain("Profil vocal enregistré");
  expect(host.textContent).toContain("3/3 extraits");
});
