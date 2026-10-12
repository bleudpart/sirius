export const SCAN_FIELDS = {
  supplier: "", date: "", total_ttc: "", tva: "", currency: "EUR",
  fiscal_identifiers: "", ticket_number: "",
};

export function scanMoney(value) {
  const normalized = String(value ?? "").replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(normalized)) return null;
  return Number(normalized).toFixed(2);
}

export function extractScanFields(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const totals = [];
  const taxes = [];
  let date = "";
  for (const line of lines) {
    const match = line.match(/\b(\d{2})[/. -](\d{2})[/. -](\d{4})\b/);
    if (!date && match) {
      const iso = `${match[3]}-${match[2]}-${match[1]}`;
      const candidate = new Date(`${iso}T12:00:00Z`);
      if (!Number.isNaN(candidate.valueOf()) && candidate.toISOString().slice(0, 10) === iso) date = iso;
    }
    const amounts = line.replace(/\d+[,.]?\d*\s*%/g, "")
      .match(/\b\d+(?:[ \u00a0\u202f]\d{3})*[,.]\d{2}\b/g);
    const amount = amounts?.length ? scanMoney(amounts[amounts.length - 1]) : null;
    if (!amount) continue;
    if (/\b(?:total\s*(?:ttc|à payer|a payer)|net\s*[àa]\s*payer|montant\s*ttc)\b/i.test(line)
      || (/^\s*total\b/i.test(line) && !/\b(?:ht|tva|taxe|remise)\b/i.test(line))) totals.push(amount);
    if (/\b(?:total\s*tva|montant\s*tva)\b/i.test(line)) taxes.push(amount);
  }
  const unique = (values) => [...new Set(values)];
  return {
    ...SCAN_FIELDS,
    supplier: lines.find((line) => /[a-zà-ÿ]{3}/i.test(line)
      && !/\b(?:ticket|facture|total|tva|merci)\b/i.test(line))?.slice(0, 160) || "",
    date,
    total_ttc: unique(totals).length === 1 ? totals[0] : "",
    tva: unique(taxes).length === 1 ? taxes[0] : "",
    fiscal_identifiers: lines.filter((line) => /\b(?:siret|siren|rcs|nif|num[eé]ro fiscal|tva\s*(?:intracom|intra|n[°o]))/i.test(line)).join("\n").slice(0, 2000),
    ticket_number: lines.find((line) => /\b(?:ticket|facture|re[çc]u)\s*(?:n[°o]|num[eé]ro|#)/i.test(line))?.slice(0, 120) || "",
  };
}

export function buildReceiptDraft({ kind, fields, seller, customer, description }) {
  const sale = kind === "sale";
  return [
    sale ? "BROUILLON DE FACTURE CLIENT — NON ÉMIS" : "FICHE DE DÉPENSE — JUSTIFICATIF JOINT",
    "",
    sale ? `Vendeur : ${seller || "À compléter (raison sociale, adresse, identifiant légal)"}` : `Fournisseur : ${fields.supplier || "À compléter"}`,
    sale ? `Client : ${customer || "À compléter (nom et adresse)"}` : "",
    `Date du ticket : ${fields.date || "À vérifier"}`,
    `Référence d'origine : ${fields.ticket_number || "À vérifier"}`,
    `Identifiants fiscaux reproduits : ${fields.fiscal_identifiers || "À compléter d'après le justificatif"}`,
    "",
    "Description / articles (à relire) :",
    description || "À compléter d'après le ticket joint.",
    "",
    `Total TTC : ${scanMoney(fields.total_ttc) ?? "À vérifier"} ${fields.currency}`,
    `Montant TVA : ${scanMoney(fields.tva) ?? "Non identifié — à vérifier"} ${fields.currency}`,
    "",
    sale
      ? "Avant émission : vérifier les articles et taux de TVA, compléter les mentions obligatoires, attribuer le numéro dans le registre de facturation et vérifier qu'aucune facture n'existe déjà pour cette vente."
      : "Cette fiche ne remplace pas une facture fournisseur et n'atteste pas le droit à déduction de TVA.",
  ].filter((line) => line !== null).join("\n");
}

export async function readDocumentLocally(file, onProgress, { signal, timeoutMs = 90000 } = {}) {
  let worker;
  let finished = false;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  const abort = () => rejectStopped(new Error("Lecture annulée."));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => rejectStopped(new Error("La lecture a dépassé 90 secondes. Reprenez une photo plus nette.")), timeoutMs);
  const reading = (async () => {
    const { createWorker } = await import("tesseract.js");
    if (finished || signal?.aborted) throw new Error("Lecture annulée.");
    const base = new URL(`${process.env.PUBLIC_URL || "."}/ocr/`, document.baseURI).href;
    const created = await createWorker("fra", 1, {
      workerPath: `${base}worker.min.js`, corePath: base, langPath: base,
      logger: ({ status, progress }) => {
        if (!finished) onProgress(status === "recognizing text"
          ? `Lecture du document : ${Math.round(progress * 100)} %` : "Chargement du lecteur local…");
      },
    });
    worker = created;
    if (finished || signal?.aborted) { await created.terminate(); throw new Error("Lecture annulée."); }
    const result = await created.recognize(file);
    const text = result.data.text.trim();
    if (!text) throw new Error("Aucun texte lisible. Reprenez la photo, à plat et bien éclairée.");
    return { text, fields: extractScanFields(text) };
  })();
  try {
    return await Promise.race([reading, stopped]);
  } finally {
    finished = true;
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    if (worker) await worker.terminate();
  }
}
