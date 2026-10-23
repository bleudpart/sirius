import { act } from "react";
import { createRoot } from "react-dom/client";
import VoiceDiagnosticPanel from "./VoiceDiagnosticPanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host, root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const result = {
  measuredAt: "2026-10-23T20:00:00Z",
  checks: [{ id: "server", label: "Serveur", state: "error", detail: "Session expirée", ms: 42 }],
};
const click = async (text) => act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === text).click());

test("shows actionable measured results and permits rerun, profile and settings", async () => {
  const collect = jest.fn(async () => result);
  const profile = jest.fn(), settings = jest.fn(), close = jest.fn();
  await act(async () => root.render(<VoiceDiagnosticPanel collect={collect} onClose={close} onProfile={profile} onSettings={settings} />));
  expect(host.textContent).toContain("Session expirée");
  expect(host.textContent).toContain("42 ms");
  expect(host.textContent).toContain("À corriger");
  expect(document.activeElement.textContent).toBe("Fermer le diagnostic");
  await click("Relancer les contrôles");
  expect(collect).toHaveBeenCalledTimes(2);
  expect(collect.mock.calls[0][0].signal.aborted).toBe(true);
  await click("Ouvrir mon profil vocal");
  await click("Ouvrir les réglages voix");
  expect(profile).toHaveBeenCalledTimes(1);
  expect(settings).toHaveBeenCalledTimes(1);
  await act(async () => host.querySelector("section").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(close).toHaveBeenCalledTimes(1);
});

test("unmount cancels pending checks and never renders late results", async () => {
  let finish;
  const collect = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<VoiceDiagnosticPanel collect={collect} onClose={() => {}} />));
  expect(host.textContent).toContain("Contrôles en cours");
  await act(async () => root.render(null));
  expect(collect.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => finish(result));
  expect(host.textContent).toBe("");
});
