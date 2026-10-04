import { z } from "zod";

export const WORK_BACKUP_MAX_BYTES = 5 * 1024 * 1024;
const dateTime = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const base = { id: z.string().min(1), title: z.string().min(1), createdAt: dateTime };
const optionalText = z.string().optional();
const schemas = {
  workflows: z.object({ ...base, dossier: optionalText, steps: z.array(z.object({ text: z.string(), done: z.boolean() }).strict()) }).strict(),
  pricing: z.object({ ...base, supplier: z.string(), price: z.number().finite().nonnegative(), unit: optionalText }).strict(),
  dossiers: z.object({ ...base, contact: optionalText, details: optionalText }).strict(),
  documents: z.object({ ...base, dossier: optionalText, content: optionalText }).strict(),
  planning: z.object({ ...base, dossier: optionalText, due: z.string(), done: z.boolean() }).strict(),
  audit: z.object({ id: z.string().min(1), at: dateTime, activity: z.string() }).strict(),
};
const dataSchema = z.object(Object.fromEntries(Object.entries(schemas).map(([key, schema]) => [
  key, z.array(schema).refine((items) => new Set(items.map((item) => item.id)).size === items.length),
]))).strict();
const backupSchema = z.object({
  format: z.literal("sirius-work-modules"),
  version: z.literal(1),
  exportedAt: dateTime,
  data: dataSchema,
}).strict();

export const emptyWorkData = () => Object.fromEntries(Object.keys(schemas).map((key) => [key, []]));
export const newWorkId = () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export function loadWorkData(storageKey) {
  const raw = localStorage.getItem(storageKey);
  if (raw === null) return emptyWorkData();
  const result = dataSchema.safeParse(JSON.parse(raw));
  if (!result.success) throw new Error("Les données locales sont invalides. Aucune modification ne sera enregistrée.");
  return result.data;
}

export function serializeWorkBackup(data) {
  const result = dataSchema.safeParse(data);
  if (!result.success) throw new Error("Sauvegarde impossible : les données métier sont invalides.");
  const text = JSON.stringify({
    format: "sirius-work-modules", version: 1,
    exportedAt: new Date().toISOString(), data: result.data,
  }, null, 2);
  if (new Blob([text]).size > WORK_BACKUP_MAX_BYTES) {
    throw new Error("Sauvegarde trop volumineuse (5 Mo maximum). Aucun fichier n'a été généré et vos données restent intactes.");
  }
  return text;
}

export function parseWorkBackup(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Ce fichier n'est pas une sauvegarde JSON lisible.");
  }
  const result = backupSchema.safeParse(value);
  if (!result.success) throw new Error("Sauvegarde incompatible ou invalide. Les données actuelles restent intactes.");
  return result.data.data;
}

const contentKey = (item) => JSON.stringify(Object.keys(item).filter((key) => key !== "id").sort().map((key) => [key, item[key]]));

export function mergeWorkBackup(current, incoming) {
  let added = 0;
  let conflicts = 0;
  const data = Object.fromEntries(Object.keys(schemas).map((key) => {
    const items = [...current[key]];
    const ids = new Set(items.map((item) => item.id));
    const contents = new Set(items.map(contentKey));
    for (const item of incoming[key]) {
      const content = contentKey(item);
      if (contents.has(content)) continue;
      let id = item.id;
      if (ids.has(id)) {
        conflicts += 1;
        do { id = newWorkId(); } while (ids.has(id));
      }
      items.push({ ...item, id });
      ids.add(id);
      contents.add(content);
      added += 1;
    }
    return [key, items];
  }));
  data.audit.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  return { data, added, conflicts };
}

export function downloadWorkJson(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
