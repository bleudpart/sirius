import { act } from "react";
import { createRoot } from "react-dom/client";
import WorkModulesPanel from "./WorkModulesPanel";
import { emptyWorkData, serializeWorkBackup, WORK_BACKUP_MAX_BYTES } from "./workModuleBackup";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const key = "sirius_work_modules_v1_test";
const item = { id: "d1", title: "Martin", createdAt: "2026-10-03T12:00:00Z" };
let root;
let host;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  jest.restoreAllMocks();
  localStorage.clear();
});
const render = async (id = "test") => act(async () => root.render(
  <WorkModulesPanel initialModule="dossiers" user={{ id }} onClose={() => {}} onOpenExisting={() => {}} />
));
const button = (text) => Array.from(host.querySelectorAll("button")).find((node) => node.textContent === text);
const click = async (node) => act(async () => node.click());
async function importFile(file) {
  const input = host.querySelector('.work-backup input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

test("requires confirmation before deleting and allows cancellation", async () => {
  localStorage.setItem(key, JSON.stringify({ ...emptyWorkData(), dossiers: [item] }));
  await render();
  await click(host.querySelector('[aria-label="Supprimer Martin"]'));
  expect(JSON.parse(localStorage.getItem(key)).dossiers).toEqual([item]);
  await click(button("Annuler la suppression"));
  expect(host.querySelector('[aria-label="Confirmer la suppression"]')).toBeNull();
  await click(host.querySelector('[aria-label="Supprimer Martin"]'));
  await click(button("Confirmer la suppression"));
  expect(JSON.parse(localStorage.getItem(key)).dossiers).toEqual([]);
  expect(JSON.parse(localStorage.getItem(key)).audit).toHaveLength(1);
});

test("requires confirmation to merge, keeps existing data and all imported audit entries", async () => {
  localStorage.setItem(key, JSON.stringify({ ...emptyWorkData(), dossiers: [item] }));
  const imported = { ...emptyWorkData(), dossiers: [{ ...item, title: "Autre version" }],
    audit: [{ id: "a1", at: item.createdAt, activity: "Ancienne action" }] };
  await render();
  await importFile({ size: 500, text: async () => serializeWorkBackup(imported) });
  expect(JSON.parse(localStorage.getItem(key)).dossiers).toHaveLength(1);
  await click(button("Confirmer la fusion"));
  const stored = JSON.parse(localStorage.getItem(key));
  expect(stored.dossiers.map((entry) => entry.title)).toEqual(["Martin", "Autre version"]);
  expect(stored.audit).toHaveLength(2);
  expect(host.textContent).toContain("Restauration enregistrée");
});

test("quota failure leaves persisted and displayed data intact", async () => {
  localStorage.setItem(key, JSON.stringify({ ...emptyWorkData(), dossiers: [item] }));
  await render();
  await importFile({ size: 100, text: async () => serializeWorkBackup({ ...emptyWorkData(), dossiers: [{ ...item, id: "d2", title: "Nouveau" }] }) });
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await click(button("Confirmer la fusion"));
  expect(JSON.parse(localStorage.getItem(key)).dossiers).toEqual([item]);
  expect(host.querySelector('[role="alert"]').textContent).toContain("Enregistrement local impossible");
  expect(host.querySelector(".work-list").textContent).not.toContain("Nouveau");
});

test("rejects oversized or invalid imports without changing storage", async () => {
  await render();
  const read = jest.fn();
  await importFile({ size: WORK_BACKUP_MAX_BYTES + 1, text: read });
  expect(read).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]').textContent).toContain("5 Mo");
  await importFile({ size: 10, text: async () => '{"bad":true}' });
  expect(host.querySelector('[role="alert"]').textContent).toContain("invalide");
  expect(localStorage.getItem(key)).toBeNull();
});

test("blocks edits on corrupt storage and isolates a subsequent account", async () => {
  localStorage.setItem(key, "{broken");
  await render();
  expect(host.querySelector("fieldset").disabled).toBe(true);
  expect(button("Sauvegarder les six modules").disabled).toBe(true);
  expect(localStorage.getItem(key)).toBe("{broken");
  localStorage.setItem("sirius_work_modules_v1_second", JSON.stringify({ ...emptyWorkData(), dossiers: [item] }));
  await render("second");
  expect(host.querySelector("fieldset").disabled).toBe(false);
  expect(host.querySelector(".work-list").textContent).toContain("Martin");
});

test("exports the complete backup through a download link", async () => {
  localStorage.setItem(key, JSON.stringify({ ...emptyWorkData(), dossiers: [item] }));
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const create = jest.fn(() => "blob:test");
  URL.createObjectURL = create;
  URL.revokeObjectURL = jest.fn();
  const download = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    await render();
    await click(button("Sauvegarder les six modules"));
    expect(create).toHaveBeenCalledWith(expect.any(Blob));
    expect(download).toHaveBeenCalled();
    expect(host.textContent).toContain("Vérifiez que le fichier");
  } finally {
    // Let the URL cleanup run before restoring the browser APIs.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
