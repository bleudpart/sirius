import { WORK_MODULES } from "./workModules";
import { createModuleRegistry } from "./moduleRegistry";
import { createWindowController } from "./windowController";
import { findModuleForCommand, MODULE_ALIASES } from "./moduleCommandRouting";

const WORK_IDS = ["workflows", "pricing", "dossiers", "audit", "documents", "planning"];

const buildRegistry = (openWorkModule = jest.fn()) => createModuleRegistry({
  icons: {},
  actions: { openWorkModule },
  state: {},
  user: null,
});

test("declares the six work modules with a portrait", () => {
  expect(WORK_MODULES.map((module) => module.id)).toEqual(WORK_IDS);
  WORK_MODULES.forEach((module) => {
    expect(module.image).toMatch(/^\/api\/mythos\/img\/[a-z]+\.png$/);
  });
});

test.each(WORK_IDS)("registry entry '%s' opens its work module", (id) => {
  const openWorkModule = jest.fn();
  const entry = buildRegistry(openWorkModule).find((item) => item.id === id);
  expect(entry).toBeDefined();
  entry.run();
  expect(openWorkModule).toHaveBeenCalledWith(id);
  expect(MODULE_ALIASES[id]).toBeTruthy();
});

test.each([
  ["ouvre ariane", "workflows"],
  ["ouvre plutos", "pricing"],
  ["ouvre mnémosyne", "dossiers"],
  ["ouvre némésis", "audit"],
  ["ouvre thot", "documents"],
  ["ouvre chronos", "planning"],
])("voice command '%s' reaches the work module", (command, expectedId) => {
  expect(findModuleForCommand(command, buildRegistry(), MODULE_ALIASES).item?.id).toBe(expectedId);
});

test.each(WORK_IDS)("window controller closes '%s'", (id) => {
  const setActiveWorkModule = jest.fn();
  expect(createWindowController({ setActiveWorkModule }).close(id)).toBe(true);
  expect(setActiveWorkModule).toHaveBeenCalledWith(null);
});
