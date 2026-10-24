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
const createUrl = URL.createObjectURL;
const revokeUrl = URL.revokeObjectURL;
const matchMedia = window.matchMedia;
const click = async (label) => act(async () => {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
  expect(button).toBeDefined();
  button.click();
});
beforeEach(() => {
  window.matchMedia = jest.fn(() => ({ matches: true }));
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
  record = jest.fn(async (options) => { callback = options; options.onStart(); return session; });
  URL.createObjectURL = jest.fn(() => `blob:reference-${Math.random()}`);
  URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); jest.useRealTimers(); jest.restoreAllMocks();
  document.getElementById("holo-dock")?.remove();
  URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl;
  window.matchMedia = matchMedia;
});
const mount = async (account = "A", props = {}) => act(async () => root.render(
  <VoiceIdentityPanel key={account} account={account} api={api} record={record} onBeforeRecord={before} onClose={() => {}} {...props} />
));
const sample = () => ({ duration: 4, audio: new Blob(["reference"], { type: "audio/webm" }) });
const consent = async () => act(async () => host.querySelector('input[type="checkbox"]').click());
const prepare = async () => { await consent(); await click("Commencer les enregistrements"); };
const finishSample = async () => { await act(async () => callback.onReady(sample())); await click("Confirmer cet extrait"); };
const threeSamples = async () => {
  await prepare();
  for (let index = 0; index < 3; index += 1) { await click("Enregistrer une référence vocale"); await finishSample(); }
};

test("the guided page requests no microphone and requires consent, preview confirmation and explicit activation", async () => {
  await mount();
  expect(record).not.toHaveBeenCalled();
  expect(api.enroll).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-current="step"]').textContent).toContain("Préparer");
  await click("Commencer les enregistrements");
  expect(host.querySelector('[aria-current="step"]').textContent).toContain("Préparer");
  await prepare();
  for (let index = 0; index < 3; index += 1) {
    await click("Enregistrer une référence vocale");
    await act(async () => callback.onReady(sample()));
    expect(host.querySelector(`audio[aria-label="Réécouter l'extrait ${index + 1}"]`)).not.toBeNull();
    expect(host.textContent).toContain("Réécoutez et confirmez");
    expect(host.querySelector('[aria-current="step"]').textContent).toContain("Enregistrer");
    expect(api.enroll).not.toHaveBeenCalled();
    await click("Confirmer cet extrait");
  }
  expect(host.querySelector('[aria-current="step"]').textContent).toContain("Activer");
  expect(host.querySelectorAll("audio")).toHaveLength(3);
  expect(before).toHaveBeenCalledTimes(3);
  api.status.mockResolvedValue({ ready: true, enrolled: true });
  await click("Envoyer et activer mon profil vocal");
  expect(api.enroll).toHaveBeenCalledWith([sample(), sample(), sample()], { signal: expect.any(AbortSignal) });
  expect(host.textContent).toContain("Profil vocal enregistré");
  expect(host.textContent).toContain("Votre profil vocal est prêt");
  expect(host.textContent).toContain("ne l'active pas automatiquement");
  expect(host.querySelectorAll("audio")).toHaveLength(0);
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});

test("an unconfirmed preview can be discarded and is never counted or uploaded", async () => {
  await mount(); await prepare(); await click("Enregistrer une référence vocale");
  await act(async () => callback.onReady(sample()));
  const url = host.querySelector("audio").getAttribute("src");
  await click("Recommencer cet extrait");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  expect(host.querySelector("audio")).toBeNull();
  expect(host.textContent).toContain("EXTRAIT 1 SUR 3");
  expect(api.enroll).not.toHaveBeenCalled();
  await click("Enregistrer une référence vocale"); await finishSample();
  expect(host.textContent).toContain("EXTRAIT 2 SUR 3");
  expect(host.textContent).toContain("1/3 extraits prêts");
});

test("minimizing stops capture, retains confirmed references and restores the wizard from its pill", async () => {
  await mount(); await prepare(); await click("Enregistrer une référence vocale"); await finishSample();
  await click("Enregistrer une référence vocale");
  const stale = callback;
  await click("Réduire la fenêtre");
  expect(session.cancel).toHaveBeenCalled();
  expect(host.querySelector(".voice-studio").classList.contains("holo-minimized")).toBe(true);
  expect(host.querySelectorAll("audio")).toHaveLength(1);
  await act(async () => stale.onReady(sample()));
  expect(host.querySelectorAll("audio")).toHaveLength(1);
  expect(api.enroll).not.toHaveBeenCalled();
  await act(async () => document.querySelector(".hdp-restore").click());
  expect(host.querySelector(".voice-studio").classList.contains("holo-minimized")).toBe(false);
  expect(host.textContent).toContain("EXTRAIT 2 SUR 3");
  expect(host.textContent).toContain("1/3 extraits prêts");
});

test("insufficient audio is not added and an unavailable engine cannot start the wizard", async () => {
  await mount(); await prepare(); await click("Enregistrer une référence vocale");
  await act(async () => callback.onReady({ ...sample(), duration: 1 }));
  expect(host.textContent).toContain("3 à 15 secondes");
  expect(host.querySelector("audio")).toBeNull();
  expect(api.enroll).not.toHaveBeenCalled();
  api.status.mockResolvedValue({ ready: false, enrolled: false });
  await mount("B"); await consent(); await click("Commencer les enregistrements");
  expect(record).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Moteur non disponible");
});

test("the timer starts at actual microphone startup, and stop waits for the audio preview", async () => {
  jest.useFakeTimers();
  record.mockImplementation(async (options) => { callback = options; return session; });
  await mount(); await prepare(); await click("Enregistrer une référence vocale");
  await act(async () => jest.advanceTimersByTime(5000));
  expect(host.textContent).toContain("Préparation du micro");
  expect(host.querySelector(".voice-studio-timer").textContent).toBe("00:00 / 00:15");
  await act(async () => callback.onStart());
  await act(async () => jest.advanceTimersByTime(4000));
  expect(host.querySelector(".voice-studio-timer").textContent).toBe("00:04 / 00:15");
  await click("Terminer cette référence");
  expect(session.stop).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Préparation de votre extrait");
  await act(async () => callback.onReady(sample()));
  expect(host.textContent).toContain("Réécoutez et confirmez");
});

test("stop requested before the recording session resolves is applied on arrival", async () => {
  let resolve;
  record.mockImplementation((options) => {
    callback = options; options.onStart();
    return new Promise((done) => { resolve = done; });
  });
  await mount(); await prepare(); await click("Enregistrer une référence vocale");
  await click("Terminer cette référence");
  await act(async () => resolve(session));
  expect(session.stop).toHaveBeenCalledTimes(1);
});

test("cancel during microphone preparation discards a late session and allows retry", async () => {
  let resolve;
  record.mockImplementationOnce((options) => { callback = options; return new Promise((done) => { resolve = done; }); });
  await mount(); await prepare(); await click("Enregistrer une référence vocale");
  const stale = callback;
  await click("Annuler l'enregistrement");
  await act(async () => { resolve(session); });
  expect(session.cancel).toHaveBeenCalled();
  await act(async () => { stale.onStart(); stale.onReady(sample()); });
  expect(host.querySelector("audio")).toBeNull();
  await click("Enregistrer une référence vocale");
  expect(record).toHaveBeenCalledTimes(2);
});

test("changing account aborts requests, cancels the microphone and resets consent", async () => {
  await mount(); await prepare(); await click("Enregistrer une référence vocale");
  const oldCallback = callback;
  const oldSignal = api.status.mock.calls[0][0].signal;
  await mount("B");
  expect(oldSignal.aborted).toBe(true);
  expect(session.cancel).toHaveBeenCalled();
  await act(async () => oldCallback.onReady(sample()));
  expect(host.querySelector("audio")).toBeNull();
  expect(host.querySelector('input[type="checkbox"]').checked).toBe(false);
  expect(api.enroll).not.toHaveBeenCalled();
});

test("the close cross cancels recording and ignores late audio without enrolling", async () => {
  const onClose = jest.fn();
  const onDismiss = jest.fn();
  await mount("A", { onClose, onDismiss }); await prepare(); await click("Enregistrer une référence vocale");
  const signal = api.status.mock.calls[0][0].signal;
  await click("Fermer la vérification de ma voix");
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  expect(signal.aborted).toBe(true);
  expect(session.cancel).toHaveBeenCalled();
  await act(async () => callback.onReady(sample()));
  expect(host.querySelector("audio")).toBeNull();
  expect(api.enroll).not.toHaveBeenCalled();
});

test("the library action remains distinct from closing and Escape closes the whole window", async () => {
  const onClose = jest.fn();
  const onDismiss = jest.fn();
  await mount("A", { onClose, onDismiss });
  await click("Ouvrir la bibliothèque et la diction");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onDismiss).not.toHaveBeenCalled();
  expect(api.status.mock.calls[0][0].signal.aborted).toBe(true);
  await mount("B", { onClose, onDismiss });
  await act(async () => host.querySelector("section").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("deleting the server profile requires confirmation and stops voice first", async () => {
  api.status.mockResolvedValue({ ready: true, enrolled: true });
  await mount();
  expect(host.textContent).toContain("Votre profil vocal est prêt");
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  await click("Supprimer mon empreinte serveur");
  expect(api.remove).not.toHaveBeenCalled();
  api.status.mockResolvedValue({ ready: true, enrolled: false });
  await click("Confirmer la suppression serveur");
  expect(before).toHaveBeenCalledTimes(1);
  expect(api.remove).toHaveBeenCalledTimes(1);
  expect(before.mock.invocationCallOrder[0]).toBeLessThan(api.remove.mock.invocationCallOrder[0]);
  expect(host.textContent).toContain("Empreinte vocale supprimée");
  expect(host.querySelector('input[type="checkbox"]').checked).toBe(false);
});

test("a changed model can be recovered by deleting the stale profile", async () => {
  api.status.mockResolvedValue({ ready: false, enrolled: true, reason: "model_changed" });
  await mount();
  expect(host.textContent).toContain("Le modèle vocal a changé");
  await consent(); await click("Commencer les enregistrements");
  expect(record).not.toHaveBeenCalled();
  await click("Supprimer mon empreinte serveur");
  api.status.mockResolvedValue({ ready: true, enrolled: false });
  await click("Confirmer la suppression serveur");
  await prepare(); await click("Enregistrer une référence vocale");
  expect(record).toHaveBeenCalledTimes(1);
});

test.each(["error", "unconfirmed"])("failed %s enrollment preserves the three confirmed references for retry", async (mode) => {
  await mount(); await threeSamples();
  if (mode === "error") api.enroll.mockRejectedValue(new Error("Références incohérentes"));
  await click("Envoyer et activer mon profil vocal");
  expect(host.querySelector('[role="alert"]').textContent).toContain(mode === "error" ? "Références incohérentes" : "n'a pas confirmé");
  expect(host.textContent).not.toContain("Profil vocal enregistré");
  expect(host.textContent).toContain("3/3 extraits prêts");
  expect(host.querySelectorAll("audio")).toHaveLength(3);
});

test("restarting from review releases all previews without sending them", async () => {
  await mount(); await threeSamples();
  const urls = [...host.querySelectorAll("audio")].map((audio) => audio.getAttribute("src"));
  await click("Recommencer les références");
  urls.forEach((url) => expect(URL.revokeObjectURL).toHaveBeenCalledWith(url));
  expect(host.querySelectorAll("audio")).toHaveLength(0);
  expect(host.textContent).toContain("EXTRAIT 1 SUR 3");
  expect(api.enroll).not.toHaveBeenCalled();
});

test("an existing profile is not replaced until new consent and explicit reconfiguration", async () => {
  api.status.mockResolvedValue({ ready: true, enrolled: true });
  await mount();
  await click("Refaire mes enregistrements");
  expect(host.querySelector('input[type="checkbox"]').checked).toBe(false);
  expect(api.remove).not.toHaveBeenCalled();
  expect(api.enroll).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});

test("status and permission failures are explained and can be retried", async () => {
  api.status.mockRejectedValueOnce(new Error("Connexion au serveur impossible"));
  await mount();
  expect(host.querySelector('[role="alert"]').textContent).toBe("Connexion au serveur impossible");
  await click("Actualiser l'état du moteur");
  await prepare();
  record.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  await click("Enregistrer une référence vocale");
  expect(host.textContent).toContain("Microphone refusé");
  await click("Enregistrer une référence vocale");
  expect(record).toHaveBeenCalledTimes(2);
});

test("playback failure is visible and recording pauses previous previews", async () => {
  await mount(); await prepare(); await click("Enregistrer une référence vocale"); await finishSample();
  const audio = host.querySelector("audio");
  await act(async () => audio.dispatchEvent(new Event("error")));
  expect(host.textContent).toContain("Réécoute indisponible");
  HTMLMediaElement.prototype.pause.mockClear();
  await click("Enregistrer une référence vocale");
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
});
