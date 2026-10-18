import { act } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceClock, WorkspaceNavigation, WorkspaceSummary } from "./WorkspaceRails";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("workspace navigation opens existing actions and keeps one active destination", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const actions = Object.fromEntries(["onAssistant", "onModules", "onInfo", "onSettings", "onOdysseia", "onDossiers", "onVoice", "onSearch"].map((key) => [key, jest.fn()]));
  try {
    await act(async () => root.render(<WorkspaceNavigation active="modules" {...actions} />));
    const nav = host.querySelector('nav[aria-label="Espace ΣIRIUS"]');
    expect(nav.querySelectorAll("[aria-current]")).toHaveLength(1);
    expect(nav.querySelector("[aria-current]").textContent).toContain("Mes modules");
    expect(nav.querySelectorAll('[data-destination="odysseia"]')).toHaveLength(1);
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

test("summary reports the real server state without duplicate links or invented appointments", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<WorkspaceSummary connected={false} />));
    expect(host.textContent).toContain("Serveur indisponible");
    expect(host.querySelector(".workspace-connection .is-online")).toBeNull();
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(host.textContent).not.toContain("Horizon");
    expect(host.querySelector("textarea").getAttribute("aria-describedby")).toBe("workspace-note-help");
    expect(host.textContent).toContain("non enregistrée");
    await act(async () => root.render(<WorkspaceSummary connected />));
    expect(host.textContent).toContain("Serveur connecté");
  } finally {
    await act(async () => root.unmount());
  }
});

test("the top bar clock shows the real date and time", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<WorkspaceClock />));
    expect(host.querySelector("strong").textContent).toMatch(/\d{2}:\d{2}/);
    expect(host.querySelector(".workspace-header-clock > span").textContent.length).toBeGreaterThan(4);
  } finally {
    await act(async () => root.unmount());
  }
});
