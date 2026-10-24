import { INTERIOR_PROJECT_FOLDER, listInteriorProjects, readInteriorProject, saveInteriorProject, validateInteriorProject } from "./interiorProjectStorage";

const PROJECT = {
  format: "sirius-interior-project", version: 1, name: "Salon",
  before: { photo: { dataUrl: "data:image/jpeg;base64,cGhvdG8=" }, plan: { pieces: [{ nom: "Salon", x: 0, y: 0, l: 4, p: 3 }] } },
  after: { plan: { pieces: [{ nom: "Salon", x: 0, y: 0, l: 4, p: 3 }] },
    proposal: { mobilier: [], conseils: ["Vérifier les mesures"], achats: [], eclairage: "LED" } },
};
const response = (data, ok = true) => Promise.resolve({ ok, json: async () => data });
beforeEach(() => { global.fetch = jest.fn(); });

test("saves the complete before/after file and assigns the dedicated library folder", async () => {
  global.fetch.mockReturnValueOnce(response({ id: "p1", original_filename: "projet.json", dossier: "Documents" }))
    .mockReturnValueOnce(response({ ok: true }));
  const saved = await saveInteriorProject(PROJECT);
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toContain("/files/upload");
  const file = options.body.get("file");
  expect(file.type).toBe("application/json");
  const text = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
  expect(JSON.parse(text)).toEqual(PROJECT);
  expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ dossier: INTERIOR_PROJECT_FOLDER });
  expect(saved.dossier).toBe(INTERIOR_PROJECT_FOLDER);
});

test("reloads saved projects through the existing authenticated file endpoints", async () => {
  global.fetch.mockReturnValueOnce(response([
    { id: "p1", dossier: INTERIOR_PROJECT_FOLDER },
    { id: "p2", dossier: "Photos", original_filename: "image.jpg" },
  ])).mockReturnValueOnce(response(PROJECT));
  expect(await listInteriorProjects()).toEqual([{ id: "p1", dossier: INTERIOR_PROJECT_FOLDER }]);
  expect(await readInteriorProject("p1")).toEqual(PROJECT);
  expect(global.fetch.mock.calls[1][0]).toContain("/files/p1/download");
});

test("upload failure is explicit and no move or success is reported", async () => {
  global.fetch.mockReturnValueOnce(response({ detail: "Stockage indisponible" }, false));
  await expect(saveInteriorProject(PROJECT)).rejects.toThrow("Stockage indisponible");
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("a partial classification failure tells the user where the already-saved file is", async () => {
  global.fetch.mockReturnValueOnce(response({ id: "p1", dossier: "Documents" }))
    .mockReturnValueOnce(response({ detail: "Dossier indisponible" }, false));
  await expect(saveInteriorProject(PROJECT)).rejects.toThrow("Fichier conservé dans Médiathèque > Documents");
});

test("rejects incompatible projects and active photo URLs before any upload", async () => {
  expect(() => validateInteriorProject({})).toThrow("compatible");
  await expect(saveInteriorProject({ ...PROJECT, before: { ...PROJECT.before, photo: { dataUrl: "javascript:alert(1)" } } })).rejects.toThrow("photo avant");
  expect(global.fetch).not.toHaveBeenCalled();
});
