import { act } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceNavigation, WorkspaceSummary } from "./WorkspaceRails";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("workspace navigation opens existing actions and keeps one active destination", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const actions = Object.fromEntries(["onAssistant", "onModules", "onInfo", "onSettings", "onOdysseia", "onDossiers", "onVoice"].map((key) => [key, jest.fn()]));
  try {
    await act(async () => root.render(<WorkspaceNavigation active="modules" {...actions} />));
    const nav = host.querySelector('nav[aria-label="Espace ΣIRIUS"]');
    expect(nav.querySelectorAll("[aria-current]")).toHaveLength(1);
    expect(nav.querySelector("[aria-current]").textContent).toBe("Modules");
    const buttons = [...nav.querySelectorAll("button")];
    for (const button of buttons) {
      expect(button.type).toBe("button");
      await act(async () => button.click());
    }
    Object.values(actions).forEach((action) => expect(action).toHaveBeenCalledTimes(1));
  } finally {
    await act(async () => root.unmount());
  }
});

test("summary reports the real server state and does not invent dossier data", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const actions = { onDossiers: jest.fn(), onVoice: jest.fn(), onOdysseia: jest.fn() };
  try {
    await act(async () => root.render(<WorkspaceSummary connected={false} {...actions} />));
    expect(host.textContent).toContain("Serveur indisponible");
    expect(host.querySelector(".workspace-connection .is-online")).toBeNull();
    expect(host.querySelector(".workspace-clock").textContent).toMatch(/\d{2}:\d{2}/);
    await act(async () => root.render(<WorkspaceSummary connected {...actions} />));
    expect(host.textContent).toContain("Serveur connecté");
    for (const button of host.querySelectorAll("button")) {
      await act(async () => button.click());
    }
    Object.values(actions).forEach((action) => expect(action).toHaveBeenCalledTimes(1));
  } finally {
    await act(async () => root.unmount());
  }
});
