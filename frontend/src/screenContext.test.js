import { Capacitor } from "@capacitor/core";
import { activeScreenContext } from "./screenContext";

jest.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: jest.fn() } }));

beforeEach(() => {
  Capacitor.getPlatform.mockReturnValue("android");
});

afterEach(() => {
  document.body.innerHTML = "";
});

test("résume la fenêtre au premier plan sans le contenu des champs", () => {
  document.body.innerHTML = `
    <div class="sirius-root mobile-section-modules">
      <section class="sirius-module-window" data-testid="themis-panel" style="z-index: 1201">
        <header><span class="sirius-window-title">THÉMIS</span></header>
      </section>
      <section class="sirius-module-window" data-testid="haccp-panel" style="z-index: 1205">
        <header><span class="sirius-window-title">HACCP — HYGIÈNE</span></header>
        <input value="4,2 °C secret" />
        <p role="alert">Choisissez d'abord l'établissement.</p>
      </section>
      <section class="sirius-module-window holo-minimized" data-testid="sirius-files-panel" style="z-index: 1300"></section>
    </div>`;

  const screen = activeScreenContext();

  expect(screen).toEqual({
    platform: "android",
    section: "modules",
    window_id: "haccp-panel",
    window_title: "HACCP — HYGIÈNE",
    alert: "Choisissez d'abord l'établissement.",
  });
  expect(JSON.stringify(screen)).not.toContain("secret");
});

test("sans fenêtre ouverte, n'envoie que la plateforme", () => {
  Capacitor.getPlatform.mockReturnValue("web");
  document.body.innerHTML = `<div class="sirius-root mobile-section-home"></div>`;
  expect(activeScreenContext()).toEqual({ platform: "web" });
});
