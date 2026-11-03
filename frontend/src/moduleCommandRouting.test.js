import { dockTitleMatchesModule, executeModuleOpen, findModuleForCommand, MODULE_ALIASES, parseModuleOpenCommand, moduleDisplayName } from "./moduleCommandRouting";

test.each([
  ["plans", "Architecture & Intérieur (PLANS)", "PLANS"],
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
  { id: "voice-profile", label: "Ma voix — configuration & diction" },
  { id: "messaging", label: "Messagerie — Gmail & Outlook" },
];

test.each(["ouvre la messagerie", "affiche ma boîte de réception"])("opens the messaging workspace: %s", (command) => {
  expect(findModuleForCommand(command, modules, MODULE_ALIASES).item?.id).toBe("messaging");
});

test.each(["ouvre ma voix et ma diction", "ouvre le profil vocal", "affiche mes extraits vocaux", "ouvre configurer ma voix", "ouvre enregistrer ma voix"])(
  "opens the guided voice workspace: %s", (command) => {
    expect(findModuleForCommand(command, modules, MODULE_ALIASES).item?.id).toBe("voice-profile");
  },
);

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

const brandedModules = [
  { id: "prime", label: "ΣIRIUS PRIME — mémoire" },
  { id: "memory", label: "Ce que ΣIRIUS sait sur moi" },
  { id: "enterprise", label: "ΣIRIUS ENTREPRISE — équipe, audit & sauvegardes" },
  { id: "info-hub", label: "Centre d'information ΣIRIUS" },
  { id: "reload", label: "Recharger ΣIRIUS" },
];

test.each([
  ["ouvre sirius prime", "prime"],
  ["ouvre ce que sirius sait sur moi", "memory"],
  ["ouvre sirius entreprise", "enterprise"],
  ["ouvre le centre d'information sirius", "info-hub"],
  ["lance recharger sirius", "reload"],
  ["ouvre ΣIRIUS PRIME", "prime"],
])("la marque ΣIRIUS reste prononçable pour ouvrir un module: %s", (command, expectedId) => {
  expect(findModuleForCommand(command, brandedModules, MODULE_ALIASES).item?.id).toBe(expectedId);
});

test("une pastille de dock ΣIRIUS correspond au module ΣIRIUS", () => {
  expect(dockTitleMatchesModule("ΣIRIUS PRIME — MÉMOIRE", brandedModules[0], MODULE_ALIASES)).toBe(true);
  expect(dockTitleMatchesModule("ΣIRIUS ENTREPRISE", brandedModules[0], MODULE_ALIASES)).toBe(false);
});

test("generic camera opens Vision while facial capture opens Face ID", () => {
  expect(findModuleForCommand("ouvre la caméra", modules, MODULE_ALIASES).item?.id).toBe("vision");
  expect(findModuleForCommand("ouvre la caméra faciale", modules, MODULE_ALIASES).item?.id).toBe("faceid");
});