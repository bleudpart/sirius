import { configurePredictions, forgetPredictions, predictionOwner, readPredictions, refreshPredictions } from "./localPredictions";

beforeEach(() => localStorage.clear());
const date = (day, hour = 10) => new Date(2026, 9, day, hour);

test("aucune collecte par défaut et isolation stricte des comptes", () => {
  expect(predictionOwner({ user_id: "one", id: "legacy" })).toBe("one");
  expect(predictionOwner(null)).toBeNull();
  refreshPredictions("one", date(22), "analysis");
  expect(localStorage.length).toBe(0);
  configurePredictions("one", true);
  refreshPredictions("one", date(22), "analysis");
  expect(readPredictions("one").events).toHaveLength(1);
  expect(readPredictions("two").events).toEqual([]);
  expect(() => configurePredictions(null, true)).toThrow("compte identifié");
});

test("trois jours distincts avant suggestion, jamais trois clics le même jour", () => {
  configurePredictions("one", true);
  for (let n = 0; n < 4; n += 1) refreshPredictions("one", date(18), "analysis");
  refreshPredictions("one", date(19), "analysis");
  expect(refreshPredictions("one", date(20)).suggestions).toEqual([]);
  refreshPredictions("one", date(20), "analysis");
  expect(refreshPredictions("one", date(21, 11)).suggestions).toEqual([{ template: "analysis", days: 3 }]);
  expect(refreshPredictions("one", date(21, 12)).suggestions).toEqual([]);
  expect(readPredictions("one").events).toHaveLength(3);
});

test("rétention 28 jours, type fermé et aucune donnée de contenu", () => {
  configurePredictions("one", true);
  refreshPredictions("one", new Date(2026, 8, 1, 10), "review");
  refreshPredictions("one", date(22), "https://unapproved.test/private");
  const data = refreshPredictions("one", date(22), "review");
  expect(data.events).toEqual([{ template: "review", day: "2026-10-22", hour: 10 }]);
  expect(JSON.stringify(data)).not.toContain("https");
  configurePredictions("one", false);
  expect(readPredictions("one")).toEqual({ enabled: false, events: [], suggestions: [] });
  forgetPredictions("one");
  expect(localStorage.length).toBe(0);
});

test("stockage corrompu signalé, jamais converti en consentement implicite", () => {
  localStorage.setItem("sirius_local_predictions_v1_one", "bad json");
  expect(() => readPredictions("one")).toThrow("illisible");
  localStorage.setItem("sirius_local_predictions_v1_one", JSON.stringify({ enabled: "true", events: [], suggestions: [] }));
  expect(() => refreshPredictions("one")).toThrow("invalide");
  forgetPredictions("one");
  expect(readPredictions("one").enabled).toBe(false);
});
