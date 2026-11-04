import { dockTitleMatchesModule, executeModuleOpen, findModuleForCommand, isCartographieOpenCommand, isNamedModuleOpenRequest, MODULE_ALIASES, parseModuleOpenCommand, parseModuleOpenRequest, moduleDisplayName } from "./moduleCommandRouting";
import { createModuleRegistry } from "./moduleRegistry";

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

const mapModules = [
  { id: "display", label: "ΣIRIUS DISPLAY" },
  { id: "atlas", label: "ATLAS — cartes et navigation" },
  { id: "cartographie", label: "CARTOGRAPHIE — événements OSIRIS proches" },
];

test.each([
  "Zirius, ouvre la carte OSIRIS",
  "ΣIRIUS, affiche OSIRIS carte",
  "afficher OSIRIS carte",
  "ouvre OSIRIS",
  "montre-moi les cartes OSIRIS",
  "peux-tu m'afficher la carte OSIRIS ?",
  "est-ce que tu peux ouvrir OSIRIS dans ton Zirius Display ?",
  "je voudrais voir la carte d'OSIRIS s'il te plaît",
  "affiche la cartographie sur l'écran",
  "ouvre le module OSIRIS",
  "OSIRIS carte",
  "cartographie",
  "la carte des événements",
  "les événements proches",
  "ouvre Osiri",
  "affiche Osirisss",
])("OSIRIS ouvre Cartographie et jamais ATLAS ou le Display : %s", (command) => {
  expect(isCartographieOpenCommand(command)).toBe(true);
  expect(findModuleForCommand(command, mapModules, MODULE_ALIASES).item?.id).toBe("cartographie");
});

test.each([
  "que fait OSIRIS en plus de la météo ?",
  "comment ouvrir la carte OSIRIS ?",
  "n'ouvre pas OSIRIS",
  "je ne veux pas afficher OSIRIS",
  "ferme OSIRIS",
  "réduis OSIRIS",
  "ouvre ATLAS",
  "affiche la carte de Paris",
  "affiche le guide de la carte OSIRIS",
  "explique la cartographie",
])("une mention ou une autre action ne devient pas une ouverture OSIRIS : %s", (command) => {
  expect(isCartographieOpenCommand(command)).toBe(false);
});

test("la carte OSIRIS restaure sa propre pastille avant de rouvrir le module", () => {
  const cartographiePill = { querySelector: () => ({ textContent: "CARTOGRAPHIE" }), click: jest.fn() };
  const atlasPill = { querySelector: () => ({ textContent: "ATLAS" }), click: jest.fn() };
  const run = jest.fn();
  expect(executeModuleOpen("affiche OSIRIS carte", mapModules, MODULE_ALIASES, [atlasPill, cartographiePill], run)?.id)
    .toBe("cartographie");
  expect(cartographiePill.click).toHaveBeenCalledTimes(1);
  expect(atlasPill.click).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledWith(mapModules[2]);
});

test.each(["android", "web"])("chaque identifiant de module disponible sur %s reste ouvrable avec une demande naturelle", (platform) => {
  const items = createModuleRegistry({ platform, icons: {}, actions: {}, state: {}, user: { role: "admin" } });
  for (const item of items) {
    const command = `Zirius, peux-tu m'afficher le module ${item.id} dans ton Display ?`;
    expect(parseModuleOpenRequest(command)).toEqual({
      query: item.id.replace(/-/g, " "), target: "display", explicit: true,
    });
    expect(findModuleForCommand(command, items, MODULE_ALIASES).item?.id).toBe(item.id);
  }
});

test.each([
  "peux-tu m'afficher le module Thémis ?",
  "Zirius, montre-moi la fenêtre Thémis dans ton Display",
  "je voudrais consulter Thémis",
  "je te demande de m'afficher le panneau Thémis",
])("les préfixes naturels n'empêchent pas l'ouverture d'un module : %s", (command) => {
  expect(parseModuleOpenRequest(command)).not.toBeNull();
  expect(findModuleForCommand(command, modules, MODULE_ALIASES).item?.id).toBe("themis");
});

test.each([
  "comment ouvrir Thémis ?",
  "n'ouvre pas le module Thémis",
  "je ne veux pas afficher Thémis",
  "peux-tu expliquer le module Thémis ?",
])("les questions et les négations ne deviennent pas des demandes d'ouverture : %s", (command) => {
  expect(parseModuleOpenRequest(command)).toBeNull();
});

test.each(["display", "ouvre le Display", "affiche l'écran"])("le Display reste ouvrable uniquement quand il est demandé : %s", (command) => {
  expect(findModuleForCommand(command, mapModules, MODULE_ALIASES).item?.id).toBe("display");
});

test("les vrais noms de modules priment sur le dialogue métier, pas les demandes de données", () => {
  const items = createModuleRegistry({ platform: "android", icons: {}, actions: {}, state: {}, user: {} });
  expect(isNamedModuleOpenRequest("affiche Nummarius", items, MODULE_ALIASES)).toBe(true);
  expect(isNamedModuleOpenRequest("montre le module dossiers", items, MODULE_ALIASES)).toBe(true);
  expect(isNamedModuleOpenRequest("affiche mes dossiers", items, MODULE_ALIASES)).toBe(false);
  expect(isNamedModuleOpenRequest("montre mes résultats de travail", items, MODULE_ALIASES)).toBe(false);
});
test.each([
  ["SIRIUS, affiche le module OZERIS.", "cartographie"],
  ["AFIS affiche le module OSIRIS.", "cartographie"],
  ["Cirius, ouvre Ozyris", "cartographie"],
  ["euh affiche le module Témis", "themis"],
  ["affiche le module Chrono", "planning"],
])("un nom de module mal transcrit ouvre quand même le bon module : %s", (command, expectedId) => {
  const items = createModuleRegistry({ platform: "android", icons: {}, actions: {}, state: {}, user: { role: "admin" } });
  expect(parseModuleOpenRequest(command)).not.toBeNull();
  expect(findModuleForCommand(command, items, MODULE_ALIASES).item?.id).toBe(expectedId);
  expect(isNamedModuleOpenRequest(command, items, MODULE_ALIASES)).toBe(true);
});

test.each([
  "je ne veux pas afficher le module Thémis",
  "explique comment ouvrir OSIRIS",
  "si tu affiches OSIRIS",
])("le rattrapage des mots parasites ne transforme pas une négation ou une question en ouverture : %s", (command) => {
  expect(parseModuleOpenRequest(command)).toBeNull();
});

test("un nom inconnu sans proximité claire n'ouvre aucun module", () => {
  const items = createModuleRegistry({ platform: "android", icons: {}, actions: {}, state: {}, user: { role: "admin" } });
  expect(findModuleForCommand("affiche le module bouillabaisse", items, MODULE_ALIASES).item).toBeNull();
});
