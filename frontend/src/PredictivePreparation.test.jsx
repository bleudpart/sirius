import { act } from "react";
import { createRoot } from "react-dom/client";
import PredictivePreparation from "./PredictivePreparation";
import LocalPredictionMonitor from "./LocalPredictionMonitor";
import { configurePredictions, readPredictions, refreshPredictions } from "./localPredictions";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const templates = { analysis: { title: "Analyse standard" }, review: { title: "Bilan" }, alert: { title: "Alerte" } };
let root, host, prepare, originalFetch;
const render = (props = {}) => act(async () => root.render(<PredictivePreparation owner="one" templates={templates} onPrepare={prepare} {...props} />));
const click = (text) => act(async () => [...host.querySelectorAll("button")].find((item) => item.textContent === text).click());
beforeEach(() => {
  jest.useFakeTimers(); localStorage.clear();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  prepare = jest.fn(); originalFetch = global.fetch; global.fetch = jest.fn();
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); jest.useRealTimers(); global.fetch = originalFetch;
});

test("consentement et désactivation effaçante, aucune requête réseau", async () => {
  await render();
  expect(readPredictions("one").enabled).toBe(false);
  expect([...host.querySelectorAll("button")][0].disabled).toBe(true);
  await act(async () => host.querySelector("input").click());
  await click("Activer les préparations prédictives");
  expect(readPredictions("one").enabled).toBe(true);
  await click("Désactiver et effacer les habitudes");
  expect(readPredictions("one").events).toEqual([]);
  expect(global.fetch).not.toHaveBeenCalled();
});

test("le moniteur prépare un modèle avant la demande, la consultation ne lance rien", async () => {
  jest.setSystemTime(new Date(2026, 9, 22, 10));
  configurePredictions("one", true);
  [18, 19, 20].forEach((day) => refreshPredictions("one", new Date(2026, 9, day, 10), "analysis"));
  await act(async () => root.render(<>
    <LocalPredictionMonitor owner="one" />
    <PredictivePreparation owner="one" templates={templates} onPrepare={prepare} />
  </>));
  expect(host.textContent).toContain("3 jours distincts");
  expect(prepare).not.toHaveBeenCalled();
  await click("Relire le modèle préparé : Analyse standard");
  expect(prepare).toHaveBeenCalledWith("analysis");
  expect(global.fetch).not.toHaveBeenCalled();
});

test("un autre compte ne voit aucune suggestion et l'audit ne modifie rien", async () => {
  configurePredictions("one", true);
  await render({ owner: "two", auditOnly: true });
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(host.textContent).toContain("désactivée");
  expect(readPredictions("one").enabled).toBe(true);
});

test("corruption visible puis effacement explicite", async () => {
  localStorage.setItem("sirius_local_predictions_v1_one", "invalid");
  await render();
  expect(host.querySelector('[role="alert"]').textContent).toContain("illisible");
  await click("Effacer les données prédictives locales");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(readPredictions("one").enabled).toBe(false);
});
