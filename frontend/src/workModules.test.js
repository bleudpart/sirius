import { WORK_MODULES } from "./workModules";
import { act } from "react";
import { createRoot } from "react-dom/client";
import WorkModulesPanel from "./WorkModulesPanel";
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

test("intelligent dossier has a distinct registry action", () => {
  const openWorkDossiers = jest.fn();
  const entry = createModuleRegistry({
    icons: {}, actions: { openWorkDossiers }, state: {}, user: null,
  }).find((item) => item.id === "dossiers-pro");
  entry.run();
  expect(openWorkDossiers).toHaveBeenCalledTimes(1);
  expect(MODULE_ALIASES["dossiers-pro"]).toContain("intelligents");
  expect(findModuleForCommand("ouvre la journée sirius", [entry], MODULE_ALIASES).item).toBe(entry);
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

test.each(WORK_MODULES)("clicking the $label icon opens its matching panel", (module) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClose = jest.fn();
  try {
    act(() => root.render(<WorkModulesPanel initialModule="workflows" user={{ id: "test" }} onClose={onClose} />));
    const button = [...container.querySelectorAll(".work-nav button")]
      .find((entry) => entry.textContent.includes(module.label));
    expect(button).toBeDefined();
    act(() => button.click());
    expect(button.classList.contains("selected")).toBe(true);
    expect(container.querySelector(".oracle-title").textContent).toContain(module.label);
    expect(new URL(container.querySelector(".work-portrait img").src).pathname).toBe(module.image);
    act(() => container.querySelector(".setup-close").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
