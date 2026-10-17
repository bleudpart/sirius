import { act } from "react";
import { createRoot } from "react-dom/client";
import GuidedFirstAction from "./GuidedFirstAction";

global.IS_REACT_ACT_ENVIRONMENT = true;
let root, host, previousFetch;
beforeEach(() => {
  previousFetch = global.fetch;
  host = document.createElement("div"); root = createRoot(host);
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ kind: "work", read_only: true, briefing: "Deux engagements à vérifier." }) });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => { await act(async () => root.unmount()); global.fetch = previousFetch; jest.restoreAllMocks(); jest.useRealTimers(); });
const prepare = async () => act(async () => host.querySelector("button").click());
test("guides to an actual read-only result and only opens dossiers on request", async () => {
  const onDossiers = jest.fn();
  await act(async () => root.render(<GuidedFirstAction onDossiers={onDossiers} onBack={jest.fn()} />));
  expect(global.fetch).not.toHaveBeenCalled();
  await prepare();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][1].method).toBeUndefined();
  expect(host.textContent).toContain("Deux engagements à vérifier");
  expect(onDossiers).not.toHaveBeenCalled();
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent.startsWith("Choisir la suite")).click());
  expect(onDossiers).toHaveBeenCalledTimes(1);
});
test("an invalid or failed result is not presented as completed and retry is explicit", async () => {
  global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ briefing: "not certified" }) });
  await act(async () => root.render(<GuidedFirstAction />));
  await prepare();
  expect(host.querySelector('[role="alert"]').textContent).toContain("La préparation n'a pas abouti");
  expect(host.querySelector(".guided-result")).toBeNull();
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Réessayer").click());
  expect(host.querySelector(".guided-result").textContent).toContain("Deux engagements");
});
test("double click is locked and timeout exposes recovery", async () => {
  jest.useFakeTimers();
  global.fetch.mockImplementation((_, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
  await act(async () => root.render(<GuidedFirstAction />));
  await prepare(); await prepare();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  await act(async () => jest.advanceTimersByTime(12000));
  expect(host.textContent).toContain("Le service n'a pas répondu à temps");
  expect(host.querySelector("button").disabled).toBe(false);
});
test("stopping a refresh preserves the previously received result", async () => {
  await act(async () => root.render(<GuidedFirstAction />));
  await prepare();
  global.fetch.mockImplementation((_, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
  await prepare();
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Arrêter la préparation").click());
  expect(host.querySelector(".guided-result").textContent).toContain("Deux engagements");
  expect(host.textContent).toContain("Préparation interrompue");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
