import { dockTitleMatchesModule, executeModuleOpen, findModuleForCommand, MODULE_ALIASES, parseModuleOpenCommand, moduleDisplayName } from "./moduleCommandRouting";

test.each([
  ["plans", "Plans 2D (PLANS)", "PLANS"],
  ["photo3d", "Photos → Objet 3D (PHOTO3D)", "PHOTO3D"],
  ["themis", "THÉMIS# — gestion d'entreprise", "THÉMIS"],
])("le nom prononcé de %s n'est pas sa fonction", (id, label, expected) => {
  expect(moduleDisplayName({ id, label })).toBe(expected);
});

const modules = [
  { id: "faceid", label: "FACE ID — reconnaissance faciale locale" },
  { id: "cortex", label: "ZEUS CORTEX — intelligence centrale" },
  { id: "themis", label: "THÉMIS — gestion d'entreprise" },
  { id: "gcal", label: "AGENDA — Google Calendar" },
  { id: "vision", label: "Vision caméra" },
];

const aliases = {
  faceid: "reconnaissance faciale visage prise de vue faciale capture visage",
  vision: "caméra webcam",
  cortex: "cerveau intelligence centrale",
  themis: "comptabilite factures devis",
  gcal: "calendrier agenda google",
};

test.each([
  ["ouvre la prise de vue faciale", "faceid"],
  ["ouvre-moi FACE ID", "faceid"],
  ["affiche le cortex", "cortex"],
  ["ouvre THÉMIS dans le HUD", "themis"],
  ["affiche le calendrier Google sur l'écran", "gcal"],
  ["ouvre la caméra", "vision"],
])("routes '%s' to the actual module", (command, expectedId) => {
  expect(findModuleForCommand(command, modules, aliases).item?.id).toBe(expectedId);
});

test("parses the requested window destination separately from the module", () => {
  expect(parseModuleOpenCommand("ouvre-moi le module Thémis sur le display")).toEqual({
    query: "themis",
    target: "display",
  });
});

test("only restores the dock pill belonging to the requested module", () => {
  expect(dockTitleMatchesModule("FACE ID — RECONNAISSANCE LOCALE", modules[0], aliases)).toBe(true);
  expect(dockTitleMatchesModule("THÉMIS — GESTION D'ENTREPRISE", modules[0], aliases)).toBe(false);
});

test("restores the matching pill and still executes the real module open action", () => {
  const facePill = { querySelector: () => ({ textContent: "FACE ID — RECONNAISSANCE LOCALE" }), textContent: "", click: jest.fn() };
  const themisPill = { querySelector: () => ({ textContent: "THÉMIS — gestion d'entreprise" }), textContent: "", click: jest.fn() };
  const runModule = jest.fn();

  const opened = executeModuleOpen(
    "ouvre la prise de vue faciale",
    modules,
    aliases,
    [themisPill, facePill],
    runModule,
  );

  expect(opened.id).toBe("faceid");
  expect(facePill.click).toHaveBeenCalledTimes(1);
  expect(themisPill.click).not.toHaveBeenCalled();
  expect(runModule).toHaveBeenCalledWith(opened);
});

test("generic camera opens Vision while facial capture opens Face ID", () => {
  expect(findModuleForCommand("ouvre la caméra", modules, MODULE_ALIASES).item?.id).toBe("vision");
  expect(findModuleForCommand("ouvre la caméra faciale", modules, MODULE_ALIASES).item?.id).toBe("faceid");
});