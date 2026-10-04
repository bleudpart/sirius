import { emptyWorkData, loadWorkData, mergeWorkBackup, parseWorkBackup, serializeWorkBackup, WORK_BACKUP_MAX_BYTES } from "./workModuleBackup";

const entry = { id: "d1", title: "Client", contact: "Martin", createdAt: "2026-10-03T12:00:00Z" };
const sample = () => ({
  workflows: [{ id: "w1", title: "Devis", createdAt: entry.createdAt, steps: [{ text: "Préparer", done: false }] }],
  pricing: [{ id: "p1", title: "Papier", createdAt: entry.createdAt, supplier: "Fournisseur", price: 12.5 }],
  dossiers: [entry],
  documents: [{ id: "t1", title: "Notes", createdAt: entry.createdAt, content: "Confidentiel" }],
  planning: [{ id: "c1", title: "Appeler", createdAt: entry.createdAt, due: "2026-10-04", done: false }],
  audit: [{ id: "a1", at: entry.createdAt, activity: "Ajout" }],
});

afterEach(() => localStorage.clear());

test("round-trips all six collections without account identifiers", () => {
  const backup = serializeWorkBackup(sample());
  expect(parseWorkBackup(backup)).toEqual(sample());
  expect(Object.keys(JSON.parse(backup))).toEqual(["format", "version", "exportedAt", "data"]);
});

test("merges without replacing existing records and reimport is idempotent", () => {
  const current = { ...emptyWorkData(), dossiers: [entry] };
  const incoming = { ...sample(), dossiers: [{ ...entry, title: "Client modifié" }] };
  const merged = mergeWorkBackup(current, incoming);
  expect(merged.conflicts).toBe(1);
  expect(merged.data.dossiers[0]).toEqual(entry);
  expect(merged.data.dossiers[1]).toMatchObject({ title: "Client modifié" });
  expect(merged.data.dossiers[1].id).not.toBe(entry.id);
  expect(mergeWorkBackup(merged.data, incoming).added).toBe(0);
  expect(current.dossiers).toEqual([entry]);
});

test.each([
  "not json",
  JSON.stringify({ format: "other", version: 1, exportedAt: entry.createdAt, data: sample() }),
  JSON.stringify({ format: "sirius-work-modules", version: 2, exportedAt: entry.createdAt, data: sample() }),
  JSON.stringify({ format: "sirius-work-modules", version: 1, exportedAt: entry.createdAt, data: { ...sample(), planning: {} } }),
  JSON.stringify({ format: "sirius-work-modules", version: 1, exportedAt: entry.createdAt, data: { ...sample(), dossiers: [entry, entry] } }),
  JSON.stringify({ format: "sirius-work-modules", version: 1, exportedAt: entry.createdAt, data: { ...sample(), dossiers: [{ ...entry, title: {} }] } }),
])("rejects invalid backup: %s", (text) => expect(() => parseWorkBackup(text)).toThrow());

test("loads existing persisted data but does not silently replace corrupt data", () => {
  localStorage.setItem("work", JSON.stringify(sample()));
  expect(loadWorkData("work")).toEqual(sample());
  localStorage.setItem("work", "{broken");
  expect(() => loadWorkData("work")).toThrow();
  expect(localStorage.getItem("work")).toBe("{broken");
  expect(loadWorkData("new-account")).toEqual(emptyWorkData());
});

test("does not truncate the imported audit", () => {
  const incoming = { ...emptyWorkData(), audit: Array.from({ length: 510 }, (_, index) => ({
    id: `a${index}`, at: entry.createdAt, activity: `Action ${index}`,
  })) };
  expect(mergeWorkBackup(emptyWorkData(), incoming).data.audit).toHaveLength(510);
});

test("enforces the exact backup byte limit so an export remains importable", () => {
  const data = { ...emptyWorkData(), documents: [{ id: entry.id, title: entry.title, createdAt: entry.createdAt, content: "" }] };
  const overhead = new Blob([serializeWorkBackup(data)]).size;
  data.documents[0].content = "a".repeat(WORK_BACKUP_MAX_BYTES - overhead);
  expect(new Blob([serializeWorkBackup(data)]).size).toBe(WORK_BACKUP_MAX_BYTES);
  data.documents[0].content += "é";
  expect(() => serializeWorkBackup(data)).toThrow("5 Mo");
});
