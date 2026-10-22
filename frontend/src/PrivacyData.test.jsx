import { act } from "react";
import { createRoot } from "react-dom/client";
import PrivacyData from "./PrivacyData";
import { ProfilePanel } from "./AuthGate";
import SiriusSetup from "./SiriusSetup";
import { HUD_DEFAULTS, applyHud } from "./hudPrefs";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, previousFetch;
beforeEach(() => {
  previousFetch = global.fetch;
  global.fetch = jest.fn();
  localStorage.clear();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); global.fetch = previousFetch; localStorage.clear(); applyHud(HUD_DEFAULTS); jest.restoreAllMocks(); });

test("privacy explains real boundaries and opens existing controls without requesting permissions or data", async () => {
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "browser-female", rate: 1, pitch: 1 }));
  const account = jest.fn(), memory = jest.fn(), connections = jest.fn();
  await act(async () => root.render(<PrivacyData onOpenAccount={account} onMemory={memory} onConnections={connections} />));
  expect(host.textContent).toContain("Voix de l'appareil sélectionnée");
  expect(host.textContent).toContain("n'est pas une sauvegarde complète");
  expect(host.textContent).toContain("durée unique garantie");
  expect(host.textContent).toContain("ne supprime pas automatiquement");
  expect(host.textContent).toContain("accord individuel");
  expect(host.textContent).toContain("sans notification inter-compte");
  expect(host.textContent).toContain("aucun audio de Huddle");
  expect(global.fetch).not.toHaveBeenCalled();
  await act(async () => [...host.querySelectorAll("button")].forEach((button) => button.click()));
  expect(account).toHaveBeenCalledTimes(1);
  expect(memory).toHaveBeenCalledTimes(1);
  expect(connections).toHaveBeenCalledTimes(1);
});
test("remote reading is clearly distinct from transcription and a private conversation is not promised", async () => {
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "fr-FR-Neural2-G", rate: 1, pitch: 1 }));
  await act(async () => root.render(<PrivacyData />));
  expect(host.textContent).toContain("Voix distante sélectionnée");
  expect(host.textContent).toContain("transcription du microphone est distincte");
  expect(host.textContent).toContain("n'active pas de conversation privée");
});
test("failed account export explicitly tells the user it did not succeed", async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 503 });
  jest.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => root.render(<ProfilePanel user={{ id: "u", name: "Test", email: "test@example.test" }} />));
  await act(async () => host.querySelector('[data-testid="profile-export-btn"]').click());
  expect(host.querySelector('[role="alert"]').textContent).toContain("aucun fichier complet n'est confirmé");
});
test("privacy is reachable in setup and accessible display choices apply immediately", async () => {
  await act(async () => root.render(<SiriusSetup initialTab="confidentialite" initialProfile={{ name: "Test" }} onCancel={jest.fn()} onComplete={jest.fn()} />));
  expect(host.querySelector('[data-testid="setup-panel-confidentialite"]')).not.toBeNull();
  await act(async () => host.querySelector('[data-testid="setup-tab-hud"]').click());
  await act(async () => host.querySelector('[data-testid="setup-reduced-motion"]').click());
  expect(document.body.classList.contains("hud-reduced-motion")).toBe(true);
  await act(async () => host.querySelector('[data-testid="setup-high-contrast"]').click());
  expect(document.body.classList.contains("hud-high-contrast")).toBe(true);
  await act(async () => host.querySelector('[data-testid="setup-hud-size-XL"]').click());
  expect(JSON.parse(localStorage.getItem("sirius_hud")).zoom).toBe(1.25);
});
