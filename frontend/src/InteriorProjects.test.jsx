import { act } from "react";
import { createRoot } from "react-dom/client";
import InteriorProjects from "./InteriorProjects";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const project = {
  format: "sirius-interior-project", version: 1, name: "Salon sauvegardé",
  before: { photo: { dataUrl: "data:image/jpeg;base64,cGhvdG8=" }, plan: { pieces: [{ nom: "Salon", x: 0, y: 0, l: 4, p: 3 }], mobilier: [] } },
  after: { plan: { pieces: [{ nom: "Salon", x: 0, y: 0, l: 4, p: 3 }], mobilier: [{ nom: "Canapé proposé", x: 1, y: 1, l: 2, p: 1 }] },
    proposal: { mobilier: [], conseils: ["Confirmer les cotes"], eclairage: "LED", achats: [] } },
};
const ok = (data) => Promise.resolve({ ok: true, json: async () => data });
let root, host;
beforeEach(() => {
  global.fetch = jest.fn();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function click(text) {
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent.includes(text)).click());
}
const renderPlan = (plan) => <span>{plan.mobilier.length ? "Plan proposé" : "Plan d'origine"}</span>;

test("explicitly saves both sides, then can reopen the project after unmounting", async () => {
  global.fetch.mockReturnValueOnce(ok({ id: "p1", original_filename: "salon.json" })).mockReturnValueOnce(ok({ ok: true }));
  await act(async () => root.render(<InteriorProjects draft={project} renderPlan={renderPlan} />));
  expect(global.fetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain("AVANT · Sans IA");
  expect(host.textContent).toContain("APRÈS · Proposition IA");
  await click("Enregistrer la proposition");
  expect(host.textContent).toContain("Enregistré : Médiathèque > Architecture - Avant-Apres > salon.json");
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<InteriorProjects draft={null} renderPlan={renderPlan} />));
  expect(host.querySelector("img")).toBeNull();
  global.fetch.mockReturnValueOnce(ok([{ id: "p1", original_filename: "salon.json", dossier: "Architecture - Avant-Apres" }]))
    .mockReturnValueOnce(ok(project));
  await click("Ouvrir mes projets");
  await click("salon.json");
  expect(host.querySelector("img").getAttribute("src")).toBe(project.before.photo.dataUrl);
  expect(host.textContent).toContain("Plan d'origine");
  expect(host.textContent).toContain("Plan proposé");
  expect(host.textContent).toContain("Confirmer les cotes");
  expect(host.textContent).toContain("Salon sauvegardé");
});

test("storage errors remain visible without a success notification", async () => {
  global.fetch.mockReturnValueOnce(Promise.resolve({ ok: false, json: async () => ({ detail: "Connexion requise" }) }));
  await act(async () => root.render(<InteriorProjects draft={project} renderPlan={renderPlan} />));
  await click("Enregistrer la proposition");
  expect(host.querySelector('[role="alert"]').textContent).toBe("Connexion requise");
  expect(host.textContent).not.toContain("Enregistré :");
});
