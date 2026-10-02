import {
  buildSportSession, readSportHistory, saveSportHistory, sportStorageKey, suggestSportAdaptation,
} from "./sportSessions";
import { createModuleRegistry } from "./moduleRegistry";
import { findModuleForCommand, MODULE_ALIASES } from "./moduleCommandRouting";
import { createWindowController } from "./windowController";

test.each(["mobilite", "force", "masse"])("builds an illustrated %s session without unavailable equipment", (goal) => {
  const session = buildSportSession({ goal, equipment: "aucun", minutes: 15 });
  expect(session.exercises).toHaveLength(3);
  expect(session.exercises.every((exercise) => exercise.steps.length >= 3 && exercise.illustration)).toBe(true);
  expect(session.exercises.some((exercise) => /haltère|élastique/.test(exercise.equipment))).toBe(false);
});

test("adapts length and equipment to the user's choices", () => {
  const short = buildSportSession({ goal: "force", equipment: "elastique", minutes: 15 });
  const long = buildSportSession({ goal: "force", equipment: "elastique", minutes: 40 });
  expect(short.exercises).toHaveLength(3);
  expect(long.exercises).toHaveLength(6);
  expect(buildSportSession({ goal: "force", equipment: "aucun", minutes: 40 }).exercises).toHaveLength(5);
  expect(long.exercises.some((exercise) => exercise.equipment === "élastique")).toBe(true);
  expect(buildSportSession({ goal: "force", equipment: "halteres", minutes: 40 }).exercises
    .some((exercise) => exercise.equipment === "haltère")).toBe(true);
  expect(() => buildSportSession({ goal: "masse", equipment: "aucun", minutes: 100 })).toThrow();
  expect(() => buildSportSession({ goal: "inconnu", equipment: "aucun", minutes: 15 })).toThrow();
  expect(() => buildSportSession({ goal: "force", equipment: "machine", minutes: 15 })).toThrow();
});

test("keeps histories separate per account and refuses to overwrite unreadable data", () => {
  const storage = { getItem: jest.fn(), setItem: jest.fn() };
  const first = { id: "a" };
  const second = { id: "b" };
  expect(sportStorageKey(first)).not.toBe(sportStorageKey(second));
  const entry = { id: "one", at: "2026-02-03T12:00:00Z", goal: "force", exercises: ["walk"], effort: "facile" };
  saveSportHistory(storage, first, [entry]);
  expect(storage.setItem).toHaveBeenCalledWith(sportStorageKey(first), JSON.stringify([entry]));
  storage.getItem.mockReturnValueOnce(JSON.stringify([entry]));
  expect(readSportHistory(storage, first)).toEqual([entry]);
  storage.getItem.mockReturnValueOnce("not json");
  expect(() => readSportHistory(storage, first)).toThrow();
  storage.getItem.mockReturnValueOnce('[{"id":"broken"}]');
  expect(() => readSportHistory(storage, first)).toThrow("Historique local illisible");
});

test("registry, voice command and close action reach the coach", () => {
  const openSportCoach = jest.fn();
  const setShowSportCoach = jest.fn();
  const entry = createModuleRegistry({
    icons: {}, actions: { openSportCoach }, state: {}, user: null,
  }).find((module) => module.id === "sport-coach");
  entry.run();
  expect(openSportCoach).toHaveBeenCalledTimes(1);
  expect(findModuleForCommand("ouvre le coach sportif", [entry], MODULE_ALIASES).item).toBe(entry);
  expect(findModuleForCommand("ouvre Asclépios", [entry], MODULE_ALIASES).item).toBe(entry);
  expect(createWindowController({ setShowSportCoach }).close("sport-coach")).toBe(true);
  expect(setShowSportCoach).toHaveBeenCalledWith(false);
});

const entry = (overrides = {}) => ({
  id: "one", at: "2026-02-03T12:00:00Z", goal: "force", exercises: ["walk"], effort: "facile",
  ...overrides,
});
const adaptation = (choice = "gentle", overrides = {}) => ({
  choice, comfort: "confortable", effort: "modere", ...overrides,
});
const suggest = (overrides = {}) => suggestSportAdaptation({
  goal: "force", comfort: "confortable", effort: "modere", history: [], ...overrides,
});

test.each([
  ["confortable", "facile", "usual"],
  ["confortable", "modere", "usual"],
  ["confortable", "difficile", "gentle"],
  ["a_ajuster", "facile", "gentle"],
  ["a_ajuster", "modere", "gentle"],
  ["a_ajuster", "difficile", "gentle"],
])("uses explicit comfort %s and effort %s to propose %s without diagnosis", (comfort, effort, choice) => {
  const proposal = suggest({ comfort, effort });
  expect(proposal).toEqual({ choice, historyCount: 0, reason: expect.any(String) });
});

test("uses at most three most recent completed histories for the selected goal, without mutation", () => {
  const history = [
    entry({ id: "old", at: "2026-01-01T12:00:00Z", effort: "difficile" }),
    entry({ id: "third", at: "2026-02-01T12:00:00Z" }),
    entry({ id: "other-goal", at: "2026-03-01T12:00:00Z", goal: "masse", effort: "difficile" }),
    entry({ id: "newest", at: "2026-02-03T12:00:00Z" }),
    entry({ id: "skipped", at: "2026-03-02T12:00:00Z", exercises: [], effort: "difficile" }),
    entry({ id: "second", at: "2026-02-02T12:00:00Z" }),
  ];
  const snapshot = JSON.stringify(history);
  history.forEach(Object.freeze);
  Object.freeze(history);
  expect(suggest({ history })).toMatchObject({ choice: "usual", historyCount: 3 });
  expect(JSON.stringify(history)).toBe(snapshot);
  expect(suggest({ history: [entry({ effort: "difficile" })] }))
    .toMatchObject({ choice: "gentle", historyCount: 1 });
});

test("does not reuse previous choices or infer progress from easy sessions or skips", () => {
  expect(suggest({ history: [entry({ adaptation: adaptation("short") })] }))
    .toMatchObject({ choice: "usual", historyCount: 1 });
  expect(suggest({ history: [entry({ exercises: [] })] }))
    .toMatchObject({ choice: "usual", historyCount: 0 });
  const base = { goal: "force", equipment: "aucun", minutes: 25 };
  expect(buildSportSession(base).adaptation).toBeUndefined();
  expect(buildSportSession({ ...base, history: [entry({ effort: "difficile" })] })).toEqual(buildSportSession(base));
});

test.each(["mobilite", "force", "masse"])("keeps %s usual sessions unchanged and gentle sessions no harder", (goal) => {
  for (const equipment of ["aucun", "elastique", "halteres"]) {
    for (const minutes of [15, 25, 40]) {
      const options = { goal, equipment, minutes };
      const usual = buildSportSession(options);
      const chosenUsual = buildSportSession({ ...options, adaptation: adaptation("usual") });
      const gentle = buildSportSession({ ...options, adaptation: adaptation("gentle") });
      expect(chosenUsual).toEqual({ ...usual, adaptation: adaptation("usual") });
      expect(gentle.minutes).toBe(usual.minutes);
      expect(gentle.exercises.map(({ id }) => id)).toEqual(usual.exercises.map(({ id }) => id));
      expect(gentle.exercises.every(({ suggestion }) => /douce|doucement/.test(suggestion))).toBe(true);
      expect(gentle.exercises.every(({ suggestion }) => suggestion.includes("pauses libres"))).toBe(true);
      expect(gentle.exercises.map(({ steps, caution }) => ({ steps, caution })))
        .toEqual(usual.exercises.map(({ steps, caution }) => ({ steps, caution })));
    }
  }
});

test.each([15, 25, 40])("short choice is measurably shorter than %s minutes without new equipment", (minutes) => {
  for (const goal of ["mobilite", "force", "masse"]) {
    for (const equipment of ["aucun", "elastique", "halteres"]) {
      const options = { goal, equipment, minutes };
      const usual = buildSportSession(options);
      const short = buildSportSession({ ...options, adaptation: adaptation("short") });
      expect(short.minutes).toBe(minutes === 15 ? 10 : 15);
      expect(short.exercises).toHaveLength(minutes === 15 ? 2 : 3);
      expect(short.exercises.length).toBeLessThan(usual.exercises.length);
      expect(short.exercises).toEqual(usual.exercises.slice(0, short.exercises.length));
    }
  }
});

test("snapshots approved metadata and normalizes the selected duration", () => {
  const approved = adaptation("short");
  const session = buildSportSession({ goal: "force", equipment: "aucun", minutes: "25", adaptation: approved });
  approved.choice = "gentle";
  expect(session.adaptation.choice).toBe("short");
  expect(buildSportSession({ goal: "force", equipment: "aucun", minutes: "25" }).exercises).toHaveLength(4);
});

test.each([
  null, {}, [], "gentle", adaptation("automatic"), adaptation("usual", { comfort: "pain" }),
  adaptation("usual", { effort: "" }), { ...adaptation(), diagnosis: "hidden" },
  { choice: "gentle", comfort: "confortable" },
])("refuses invalid or hidden adaptation metadata %p before any write", (invalid) => {
  const storage = { getItem: jest.fn(), setItem: jest.fn() };
  expect(() => buildSportSession({ goal: "force", equipment: "aucun", minutes: 25, adaptation: invalid })).toThrow();
  const entries = [entry({ adaptation: invalid })];
  storage.getItem.mockReturnValue(JSON.stringify(entries));
  expect(() => readSportHistory(storage, { id: "a" })).toThrow();
  expect(() => saveSportHistory(storage, { id: "a" }, entries)).toThrow();
  expect(storage.setItem).not.toHaveBeenCalled();
});

test.each([
  { comfort: "" }, { effort: "automatic" }, { goal: "diagnostic" },
  { history: null }, { history: [entry({ adaptation: {} })] },
])("refuses invalid suggestion inputs %p", (invalid) => {
  expect(() => suggest(invalid)).toThrow();
});

test.each(["gentle", "short", "usual"])("round-trips %s metadata alongside legacy entries locally", (choice) => {
  const storage = { getItem: jest.fn(), setItem: jest.fn() };
  const entries = [entry({ adaptation: adaptation(choice) }), entry({ id: "legacy" })];
  saveSportHistory(storage, { id: "a" }, entries);
  const [key, serialized] = storage.setItem.mock.calls[0];
  expect(key).toBe(sportStorageKey({ id: "a" }));
  expect(JSON.parse(serialized)).toEqual(entries);
  storage.getItem.mockReturnValue(serialized);
  expect(readSportHistory(storage, { id: "a" })).toEqual(entries);
});

test("surfaces storage access and quota errors rather than reporting success", () => {
  const storage = {
    getItem: () => { throw new Error("Accès refusé"); },
    setItem: () => { throw new Error("Quota dépassé"); },
  };
  expect(() => readSportHistory(storage, { id: "a" })).toThrow("Accès refusé");
  expect(() => saveSportHistory(storage, { id: "a" }, [entry()])).toThrow("Quota dépassé");
});

test("keeps id, alternate identity and anonymous local journals separated", () => {
  expect(sportStorageKey({ id: "primary", _id: "alternate", email: "email" })).toBe("sirius_sport_v1_primary");
  expect(sportStorageKey({ _id: "alternate", email: "email" })).toBe("sirius_sport_v1_alternate");
  expect(sportStorageKey({ email: "email" })).toBe("sirius_sport_v1_email");
  expect(sportStorageKey(null)).toBe("sirius_sport_v1_local");
  expect(sportStorageKey(undefined)).toBe(sportStorageKey(null));
});
