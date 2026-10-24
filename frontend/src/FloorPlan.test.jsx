import React, { act } from "react";
import { createRoot } from "react-dom/client";
import FloorPlanPanel, { readImportFile } from "./FloorPlan";

jest.mock("./InteriorCamera", () => function Camera({ onCapture }) {
  return <button data-testid="camera-test-capture" onClick={() => onCapture({
    dataUrl: "data:image/jpeg;base64,cGhvdG8=", name: "Lieu.jpg", pdf: false, realPlace: true,
  })}>Capturer</button>;
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PLAN = {
  titre: "Studio",
  pieces: [
    { nom: "Séjour", x: 0, y: 0, l: 5, p: 4 },
    { nom: "Chambre", x: 5, y: 0, l: 3, p: 4 },
  ],
  ouvertures: [{ type: "porte", piece: "Séjour", mur: "sud", position: 1, largeur: 0.9 }],
  mobilier: [{ nom: "Ancien canapé", x: 1, y: 1, l: 2, p: 0.9 }],
  geometrie: {
    pieces: [{ nom: "Séjour", surface_m2: 20, perimetre_m: 18 }, { nom: "Chambre", surface_m2: 12, perimetre_m: 14 }],
    surface_totale_m2: 32, emprise: { largeur_m: 8, profondeur_m: 4 },
  },
};

const jsonResponse = (data, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(data) });
let mounted = [];

async function render(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  mounted.push({ root, container });
  const q = (id) => container.querySelector(`[data-testid="${id}"]`);
  return { container, q };
}

async function click(el) {
  await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function waitFor(check, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { return check(); } catch {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    }
  }
  return check();
}

const tab = (container, name) => [...container.querySelectorAll('[role="tab"]')].find((b) => b.textContent.includes(name));

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn();
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
});

test("bascule en INTÉRIEUR : pièces, ambiances et métrés de la pièce active", async () => {
  localStorage.setItem("sirius_floorplan", JSON.stringify(PLAN));
  const { container, q } = await render(<FloorPlanPanel keys={{}} onClose={() => {}} />);
  await click(q("floorplan-mode-interior"));

  expect(q("interior-studio")).not.toBeNull();
  expect(tab(container, "Séjour").getAttribute("aria-selected")).toBe("true");
  expect(q("interior-metrics").textContent).toContain("20 m²");
  expect(q("floorplan-svg-3d")).not.toBeNull();

  await click(q("ambiance-industriel"));
  expect(q("ambiance-industriel").getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("Béton ciré");
  expect(JSON.parse(localStorage.getItem("sirius_interior")).pieces["Séjour"].ambiance).toBe("industriel");
  expect(localStorage.getItem("sirius_plan_mode")).toBe("interieur");

  await click(container.querySelector('polygon[data-room="Chambre"]'));
  expect(tab(container, "Chambre").getAttribute("aria-selected")).toBe("true");
});

test("sans plan, le mode INTÉRIEUR invite à passer par la structure", async () => {
  const { container, q } = await render(<FloorPlanPanel keys={{}} initialMode="interieur" onClose={() => {}} />);
  expect(q("interior-studio")).toBeNull();
  const goto = [...container.querySelectorAll("button")].find((b) => b.textContent.includes("ALLER À STRUCTURE"));
  await click(goto);
  expect(q("floorplan-input")).not.toBeNull();
});

test("une demande dictée sélectionne la pièce et applique la proposition de l'IA", async () => {
  localStorage.setItem("sirius_floorplan", JSON.stringify(PLAN));
  global.fetch.mockReturnValueOnce(jsonResponse({
    piece: "Chambre",
    mobilier: [{ nom: "Lit 160", x: 5.5, y: 0.5, l: 1.6, p: 2 }],
    conseils: ["Tête de lit en lin."],
    eclairage: "Appliques murales 2700 K.",
    achats: [{ article: "Lit 160", quantite: 1, budget_eur: 600 }],
  }));
  const onSpeak = jest.fn();
  const { container, q } = await render(
    <FloorPlanPanel keys={{}} initialMode="interieur" initialPrompt="aménage la chambre en style art déco" onClose={() => {}} onSpeak={onSpeak} />,
  );

  await waitFor(() => expect(q("interior-purchases").textContent).toContain("Lit 160"));
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/floorplan\/interior$/);
  const body = JSON.parse(options.body);
  expect(body).toMatchObject({ piece: "Chambre", envies: "aménage la chambre en style art déco", photo: "" });
  expect(body.ambiance).toMatch(/^Art déco/);
  expect(tab(container, "Chambre").getAttribute("aria-selected")).toBe("true");
  expect(container.textContent).toContain("Tête de lit en lin.");
  expect(JSON.parse(localStorage.getItem("sirius_floorplan")).mobilier.map((m) => m.nom)).toEqual(["Ancien canapé", "Lit 160"]);
  expect(onSpeak).toHaveBeenCalledWith(expect.stringContaining("Chambre"));
});

test("un plan importé (PDF) est envoyé au dessin, même sans description", async () => {
  global.fetch.mockReturnValueOnce(jsonResponse(PLAN));
  const { q } = await render(<FloorPlanPanel keys={{}} initialMode="structure" onClose={() => {}} />);
  const input = q("floorplan-file");
  Object.defineProperty(input, "files", { value: [new File(["%PDF-1.4"], "plan.pdf", { type: "application/pdf" })] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

  await waitFor(() => expect(q("floorplan-attachment").textContent).toContain("plan.pdf"));
  expect(q("floorplan-generate").textContent).toBe("REDESSINER");

  await click(q("floorplan-generate"));
  await waitFor(() => expect(q("floorplan-metrics")).not.toBeNull());
  const body = JSON.parse(global.fetch.mock.calls[0][1].body);
  expect(body.description).toBe("");
  expect(body.image).toMatch(/^data:application\/pdf;base64,/);
  expect(q("floorplan-attachment")).toBeNull();
});

test("refuse les formats non pris en charge", async () => {
  await expect(readImportFile(new File(["x"], "plan.gif", { type: "image/gif" }))).rejects.toThrow(/PNG, JPG, WebP ou PDF/);
  const big = new File(["x"], "gros.pdf", { type: "application/pdf" });
  Object.defineProperty(big, "size", { value: 13 * 1024 * 1024 });
  await expect(readImportFile(big)).rejects.toThrow(/12 Mo/);
});

test("a real-place photo requires explicit proposal and is distinguished from inspiration", async () => {
  localStorage.setItem("sirius_floorplan", JSON.stringify(PLAN));
  global.fetch.mockReturnValueOnce(jsonResponse({ piece: "Séjour", mobilier: [], conseils: ["Vérifier les dimensions sur place."], achats: [] }));
  const { q, container } = await render(<FloorPlanPanel keys={{}} initialMode="interieur" onClose={() => {}} />);
  await click(q("interior-open-camera"));
  await click(q("camera-test-capture"));
  expect(global.fetch).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Lieu à aménager / rénover");
  expect(q("camera-test-capture")).toBeNull();
  await click(q("interior-propose"));
  const body = JSON.parse(global.fetch.mock.calls[0][1].body);
  expect(body.photo).toBe("data:image/jpeg;base64,cGhvdG8=");
  expect(body.envies).toContain("lieu réel à aménager ou rénover");
  expect(body.envies).toContain("sans déduire de dimensions exactes");
  expect(body.plan).toMatchObject({ titre: "Studio" });
  global.fetch.mockReturnValueOnce(jsonResponse({ id: "p1", original_filename: "studio.json" }))
    .mockReturnValueOnce(jsonResponse({ ok: true }));
  await click(q("interior-save-project"));
  const stored = global.fetch.mock.calls[1][1].body.get("file");
  const storedText = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(stored);
  });
  const project = JSON.parse(storedText);
  expect(project.before.photo.dataUrl).toBe(body.photo);
  expect(project.before.plan.mobilier).toEqual(PLAN.mobilier);
  expect(project.after.plan.mobilier).not.toEqual(PLAN.mobilier);
  expect(project.after.proposal.conseils).toEqual(["Vérifier les dimensions sur place."]);
  expect(project).not.toHaveProperty("keys");
  expect(container.textContent).toContain("Enregistré : Médiathèque > Architecture - Avant-Apres");
});
