import { createModuleRegistry } from "./moduleRegistry";

const registry = (platform) => createModuleRegistry({
  platform, icons: {}, actions: {}, state: {}, user: { id: "test" },
});

test("Android excludes PC-only actions at every screen size but retains usable modules", () => {
  const ids = registry("android").map((item) => item.id);
  for (const id of ["capture-interface", "capture-region", "open-capture-folder", "install", "scripts", "packager", "hephaistos"]) {
    expect(ids).not.toContain(id);
  }
  for (const id of ["getting-started", "info-hub", "connections", "journal", "media-modules", "plans", "odysseia"]) {
    expect(ids).toContain(id);
  }
});

test("the PC registry retains its capture and installation actions", () => {
  const ids = registry("web").map((item) => item.id);
  expect(ids).toEqual(expect.arrayContaining(["capture-interface", "capture-region", "open-capture-folder", "install"]));
});

test.each([
  ["android", { showMediaModules: true, displayOpen: false }, true],
  ["android", { showMediaModules: false, displayOpen: true, displayType: "media" }, false],
  ["web", { showMediaModules: false, displayOpen: true, displayType: "media" }, true],
])("the media catalogue active state follows its window on %s", (platform, state, active) => {
  const items = createModuleRegistry({ platform, icons: {}, actions: {}, state, user: { id: "test" } });
  expect(items.find((item) => item.id === "media-modules").active).toBe(active);
});

test("information and enterprise entries keep the Sigma brand", () => {
  for (const id of ["info-hub", "enterprise"]) {
    expect(registry("android").find((item) => item.id === id).label).toContain("ΣIRIUS");
  }
});
