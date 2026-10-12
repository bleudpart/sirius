import { buildReceiptDraft, extractScanFields, fiscalIdentifierWarnings, prepareOcrImage, readDocumentLocally, scanMoney } from "./documentScan";
import { createWorker } from "tesseract.js";

jest.mock("tesseract.js", () => ({ createWorker: jest.fn() }));

const originalBitmap = global.createImageBitmap;
beforeEach(() => {
  jest.clearAllMocks();
  global.createImageBitmap = jest.fn().mockResolvedValue({ width: 900, height: 650, close: jest.fn() });
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillRect: jest.fn(), drawImage: jest.fn(),
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  global.createImageBitmap = originalBitmap;
});

test("checks fiscal identifier lengths and keys without changing the original digits", () => {
  const text = "SIRET 12345678900812\nSIREN O3282932O";
  expect(fiscalIdentifierWarnings(text)).toHaveLength(2);
  expect(text).toContain("12345678900812");
  expect(fiscalIdentifierWarnings("SIRET 732 829 320 00074\nSIREN 732829320")).toEqual([]);
  expect(fiscalIdentifierWarnings("TVA intracom FR123456789")).toEqual([]);
});

test("large native photos are bounded for OCR and their bitmap is released", async () => {
  const bitmap = { width: 8000, height: 6000, close: jest.fn() };
  global.createImageBitmap.mockResolvedValue(bitmap);
  const file = new Blob(["original"]);
  const image = await prepareOcrImage(file);
  expect(image.width).toBe(2400);
  expect(image.height).toBe(1800);
  expect(bitmap.close).toHaveBeenCalledTimes(1);
  expect(file.size).toBe(8);
});

test("small scans are enlarged for recognition and retain their aspect ratio", async () => {
  global.createImageBitmap.mockResolvedValue({ width: 900, height: 600, close: jest.fn() });
  const image = await prepareOcrImage(new Blob(["original"]));
  expect(image.width).toBe(1800);
  expect(image.height).toBe(1200);
});

test("bitmap cleanup is guaranteed when canvas preparation fails", async () => {
  const bitmap = { width: 900, height: 650, close: jest.fn() };
  global.createImageBitmap.mockResolvedValue(bitmap);
  HTMLCanvasElement.prototype.getContext.mockReturnValue(null);
  await expect(prepareOcrImage(new Blob(["image"]))).rejects.toThrow("traitement local");
  expect(bitmap.close).toHaveBeenCalledTimes(1);
});

test("extracts conservative amounts and preserves fiscal references from a receipt", () => {
  expect(extractScanFields("BOULANGERIE MARTIN\nSIRET 123 456 789 00012\nTVA intracom FR123456789\nTicket n° 0042\n12/10/2026\nPain 2,50\nTOTAL TTC 12,40\nTOTAL TVA 1,10"))
    .toEqual(expect.objectContaining({
      supplier: "BOULANGERIE MARTIN", date: "2026-10-12", total_ttc: "12.40", tva: "1.10",
      fiscal_identifiers: "SIRET 123 456 789 00012\nTVA intracom FR123456789", ticket_number: "Ticket n° 0042",
    }));
});

test("ambiguous totals, invalid dates and missing VAT stay blank rather than invented", () => {
  const fields = extractScanFields("COMMERCE\n31/02/2026\nTOTAL TTC 12,40\nTOTAL TTC 14,40\nTVA 20 %");
  expect(fields.total_ttc).toBe("");
  expect(fields.tva).toBe("");
  expect(fields.date).toBe("");
});

test.each([["1 234,56", "1234.56"], ["0", "0.00"], ["12.4", "12.40"], ["", null], ["-1", null], ["12.999", null], ["NaN", null]])(
  "normalizes %s without substituting missing amounts", (value, expected) => expect(scanMoney(value)).toBe(expected),
);

test("sales drafts never issue an invoice or turn missing amounts into zero", () => {
  const fields = extractScanFields("SIRET 12345678900012\nTicket n° 0009");
  const draft = buildReceiptDraft({ kind: "sale", fields, seller: "Mon commerce", customer: "Client", description: "Pain" });
  expect(draft).toContain("BROUILLON DE FACTURE CLIENT — NON ÉMIS");
  expect(draft).toContain("SIRET 12345678900012");
  expect(draft).toContain("Ticket n° 0009");
  expect(draft).toContain("Total TTC : À vérifier");
  expect(draft).not.toContain("0.00");
});

test("expense drafts do not pretend to be supplier invoices", () => {
  const draft = buildReceiptDraft({ kind: "purchase", fields: extractScanFields("COMMERCE\nTOTAL 5,00") });
  expect(draft).toContain("FICHE DE DÉPENSE");
  expect(draft).toContain("ne remplace pas une facture fournisseur");
});

test("OCR uses bundled same-origin resources and always releases its worker", async () => {
  const worker = { recognize: jest.fn().mockResolvedValue({ data: { text: "COMMERCE\nTOTAL TTC 5,00" } }), terminate: jest.fn().mockResolvedValue() };
  createWorker.mockResolvedValue(worker);
  const result = await readDocumentLocally(new Blob(["image"]), jest.fn());
  const options = createWorker.mock.calls[0][2];
  expect(new URL(options.workerPath).origin).toBe(window.location.origin);
  expect(new URL(options.langPath).origin).toBe(window.location.origin);
  expect(options.gzip).toBe(true);
  expect(result.fields.total_ttc).toBe("5.00");
  expect(worker.recognize).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), { rotateAuto: true });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

test("Android can request the uncompressed model actually packaged by AAPT", async () => {
  const worker = { recognize: jest.fn().mockResolvedValue({ data: { text: "TOTAL TTC 5,00" } }), terminate: jest.fn().mockResolvedValue() };
  createWorker.mockResolvedValue(worker);
  await readDocumentLocally(new Blob(["image"]), jest.fn(), { gzip: false });
  expect(createWorker.mock.calls[0][2].gzip).toBe(false);
});

test("cancel stops a pending OCR without waiting forever for recognition", async () => {
  const started = {};
  started.promise = new Promise((resolve) => { started.resolve = resolve; });
  const worker = { recognize: jest.fn(() => { started.resolve(); return new Promise(() => {}); }), terminate: jest.fn().mockResolvedValue() };
  createWorker.mockResolvedValue(worker);
  const controller = new AbortController();
  const pending = readDocumentLocally(new Blob(["image"]), jest.fn(), { signal: controller.signal });
  const rejection = expect(pending).rejects.toThrow("Lecture annulée");
  await started.promise;
  controller.abort();
  await rejection;
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
