import { act } from "react";
import { createRoot } from "react-dom/client";
import MythosGallery from "./MythosGallery";
import { WORK_MODULES } from "./workModules";

jest.mock("./voice", () => ({
  speakAsCharacter: jest.fn(),
  cancelSpeech: jest.fn(),
  CHAR_PROFILES: { "ASCLÉPIOS#": "M2" },
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test.each(WORK_MODULES)("displays $label without a hash while preserving its module key", async ({ label, image }) => {
  const originalFetch = global.fetch;
  const openModule = jest.fn();
  const moduleKey = `${label}#`;
  const character = {
    module: moduleKey, character: label, role: "Module métier", image,
    voiceIntro: `Je suis ${label}.`, details: "Présentation du module.",
    style: { color: "doré" }, column: { enabled: true },
  };
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ characters: [character] }) }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MythosGallery onClose={() => {}} onOpenModule={openModule} />));
    expect(container.querySelector(".mg-thumb-module").textContent).toBe(label);
    expect(container.querySelector(".mg-detail-module").textContent).toBe(label);
    expect(container.querySelector(".mg-open").textContent).not.toContain("#");
    act(() => container.querySelector('[data-testid="mythos-open-module-btn"]').click());
    expect(openModule).toHaveBeenCalledWith(moduleKey);
  } finally {
    act(() => root.unmount());
    container.remove();
    global.fetch = originalFetch;
  }
});

test("presents Asclépios with role, introduction and access to the coach", async () => {
  const originalFetch = global.fetch;
  const openModule = jest.fn();
  const character = {
    module: "ASCLÉPIOS#", character: "Asclépios", role: "Coach sport & bien-être",
    image: "/api/mythos/img/asclepios.png", voiceIntro: "Je suis Asclépios.",
    details: "Séances guidées et illustrées.", bio: "Figure de la mythologie grecque.",
    capacites: ["Séances guidées"], style: { color: "doré" }, column: { enabled: true },
  };
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ characters: [character] }) }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MythosGallery onClose={() => {}} onOpenModule={openModule} />));
    expect(container.textContent).toContain("Asclépios");
    expect(container.textContent).toContain("Fonction : Coach sport & bien-être");
    expect(container.querySelector(".mg-detail-img").getAttribute("src")).toContain("/api/mythos/img/asclepios.png");
    expect(container.textContent).toContain("Séances guidées et illustrées.");
    expect(container.textContent).toContain("Je suis Asclépios.");
    act(() => container.querySelector('[data-testid="mythos-open-module-btn"]').click());
    expect(openModule).toHaveBeenCalledWith("ASCLÉPIOS#");
  } finally {
    act(() => root.unmount());
    container.remove();
    global.fetch = originalFetch;
  }
});
