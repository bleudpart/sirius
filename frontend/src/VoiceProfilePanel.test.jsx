import { act } from "react";
import { createRoot } from "react-dom/client";
import VoiceProfilePanel from "./VoiceProfilePanel";
import { enabledVoiceVocabulary } from "./voiceVocabulary";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => localStorage.clear());

test("records only on request, confirms exact transcript, deletes with confirmation and cleans preview", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const entries = [];
  const store = {
    list: jest.fn(async () => [...entries]),
    save: jest.fn(async (account, sample) => { entries.push({ ...sample, account, id: "sample" }); }),
    remove: jest.fn(async () => { entries.length = 0; }),
    clear: jest.fn(async () => { entries.length = 0; }),
  };
  let callbacks;
  const session = { cancel: jest.fn(), stop: jest.fn() };
  const record = jest.fn(async (opts) => { callbacks = opts; return session; });
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => "blob:local-only");
  URL.revokeObjectURL = jest.fn();
  const pause = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const originalFetch = global.fetch;
  global.fetch = jest.fn();
  const click = async (label) => act(async () => {
    [...host.querySelectorAll("button")].find((button) => button.textContent === label).click();
  });
  try {
    await act(async () => root.render(<VoiceProfilePanel user={{ user_id: "A" }} onClose={() => {}} store={store} record={record} />));
    expect(record).not.toHaveBeenCalled();
    await click("Enregistrer volontairement un extrait");
    await act(async () => callbacks.onReady({ audio: new Blob(["audio"], { type: "audio/webm" }), duration: 1 }));
    expect(store.save).not.toHaveBeenCalled();
    await act(async () => {
      const input = host.querySelector("textarea");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "Ma diction exacte.");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Confirmer et conserver localement");
    expect(store.save).toHaveBeenCalledWith("A", expect.objectContaining({ text: "Ma diction exacte.", audio: expect.any(Blob) }));
    await click("Supprimer cet extrait");
    expect(store.remove).not.toHaveBeenCalled();
    await click("Confirmer la suppression");
    expect(store.remove).toHaveBeenCalledWith("A", "sample");
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    URL.createObjectURL = create; URL.revokeObjectURL = revoke;
    pause.mockRestore(); host.remove();
    global.fetch = originalFetch;
  }
});

test("changing account discards pending recording and clears the other account's samples", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const cancel = jest.fn();
  const store = { list: jest.fn(async () => []), save: jest.fn() };
  const record = jest.fn(async () => ({ cancel, stop: jest.fn() }));
  try {
    await act(async () => root.render(<VoiceProfilePanel user={{ user_id: "A" }} onClose={() => {}} store={store} record={record} />));
    await act(async () => [...host.querySelectorAll("button")].find((button) => /Enregistrer volontairement/.test(button.textContent)).click());
    expect(record).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<VoiceProfilePanel user={{ user_id: "B" }} onClose={() => {}} store={store} record={record} />));
    expect(cancel).toHaveBeenCalled();
    expect(store.list).toHaveBeenLastCalledWith("B");
    expect(host.querySelector("textarea")).toBeNull();
    expect(store.save).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("closing while the previous voice session stops never requests another microphone", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let finish;
  const before = () => new Promise((resolve) => { finish = resolve; });
  const record = jest.fn();
  const store = { list: async () => [] };
  try {
    await act(async () => root.render(<VoiceProfilePanel user={{ user_id: "A" }} onClose={() => {}} onBeforeRecord={before} record={record} store={store} />));
    await act(async () => [...host.querySelectorAll("button")].find((button) => /Enregistrer volontairement/.test(button.textContent)).click());
    await act(async () => host.querySelector('[aria-label="Fermer le profil vocal"]').click());
    await act(async () => finish());
    expect(record).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("explicit expression validation and account toggle never infer terms from recordings", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<VoiceProfilePanel user={{ user_id: "A" }} onClose={() => {}} store={{ list: async () => [] }} />));
    expect(host.querySelector('input[type="checkbox"]').checked).toBe(false);
    await act(async () => {
      const input = host.querySelector('[aria-label="Expression à valider"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Daniel Partel");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Valider cette expression").click());
    expect(enabledVoiceVocabulary({ user_id: "A" })).toEqual([]);
    await act(async () => host.querySelector('input[type="checkbox"]').click());
    expect(enabledVoiceVocabulary({ user_id: "A" })).toEqual(["Daniel Partel"]);
    expect(enabledVoiceVocabulary({ user_id: "B" })).toEqual([]);
    await act(async () => host.querySelector('input[type="checkbox"]').click());
    expect(enabledVoiceVocabulary({ user_id: "A" })).toEqual([]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
