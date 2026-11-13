import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpEntries, { formatReceivedQuantity, validReceivedQuantity } from "./HaccpEntries";

global.IS_REACT_ACT_ENVIRONMENT = true;
const YEAR = Number(new Intl.DateTimeFormat("en", { timeZone: "Europe/Paris", year: "numeric" }).format(new Date()));
let host, root, oldFetch, downloads;
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text));
const field = (text) => [...host.querySelectorAll("label")].find((item) => item.textContent.startsWith(text)).querySelector("select");
const reply = (data, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: async () => data });
const csvReply = () => ({
  ok: true, status: 200, headers: { get: () => "text/csv; charset=utf-8" },
  blob: async () => new Blob(["\ufeffDate;Produit\r\n"], { type: "text/csv" }),
});
function pageFor(url, total = 1) {
  const params = new URL(url, "http://localhost").searchParams;
  const year = Number(params.get("annee"));
  const month = params.has("mois") ? Number(params.get("mois")) : null;
  const offset = Number(params.get("offset"));
  const establishment = params.get("restaurant_name");
  return {
    restaurant_name: establishment, annee: year, mois: month, annees: [...new Set([YEAR, YEAR - 1, year])],
    offset, limit: 25, total,
    items: Array.from({ length: Math.min(25, Math.max(0, total - offset)) }, (_, index) => ({
      id: `document:${offset + index}`, restaurant_name: establishment,
      date: `${year}-${String(month || 11).padStart(2, "0")}-13`, origine_date: "document",
      categorie: "Produits Laitiers", produit: `Crème TEST ${offset + index}`, quantite: "3.2500", unite: "kg",
      lot: "LOT-TEST", source: "bon_livraison", reference: "BL-TEST", fournisseur: "Fournisseur TEST",
    })),
  };
}
const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};
async function click(text) { await act(async () => button(text).click()); }
async function select(text, value) {
  await act(async () => {
    field(text).value = value;
    field(text).dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(() => {
  oldFetch = global.fetch;
  global.fetch = jest.fn(async (url) => url.includes("/export-csv") ? csvReply() : reply(pageFor(url)));
  downloads = [];
  URL.createObjectURL = jest.fn(() => "blob:entries");
  URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { downloads.push(this.download); });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = oldFetch; jest.restoreAllMocks(); jest.useRealTimers();
});

test("a simple annual table preserves decimal quantities and exposes the source, not a remaining stock", async () => {
  await act(async () => root.render(<HaccpEntries establishmentName="Chez TEST" />));
  const params = new URL(global.fetch.mock.calls[0][0]).searchParams;
  expect(params.get("restaurant_name")).toBe("Chez TEST");
  expect(params.get("annee")).toBe(String(YEAR));
  expect(params.has("mois")).toBe(false);
  expect(params.get("limit")).toBe("25");
  const row = host.querySelector("tbody tr");
  expect(row.children[1].textContent).toBe("Crémerie");
  expect(row.children[3].textContent).toBe("3,2500");
  expect(row.children[6].textContent).toContain("BL-TEST");
  expect(host.textContent).toContain("pas stock restant");
  expect(host.querySelector('section[aria-label="Registre des entrées"]').classList.contains("workspace-surface")).toBe(true);
});

test("year and month selections reset pagination and send the exact selected period", async () => {
  global.fetch.mockImplementation(async (url) => reply(pageFor(url, 30)));
  await act(async () => root.render(<HaccpEntries establishmentName="Chez TEST" />));
  expect(host.querySelectorAll("tbody tr")).toHaveLength(25);
  await click("Suivant");
  expect(host.querySelectorAll("tbody tr")).toHaveLength(5);
  expect(new URL(global.fetch.mock.calls[1][0]).searchParams.get("offset")).toBe("25");
  await select("Mois", "2");
  let params = new URL(global.fetch.mock.calls[2][0]).searchParams;
  expect(params.get("mois")).toBe("2");
  expect(params.get("offset")).toBe("0");
  await select("Année", String(YEAR - 1));
  params = new URL(global.fetch.mock.calls[3][0]).searchParams;
  expect(params.get("annee")).toBe(String(YEAR - 1));
  expect(params.get("mois")).toBe("2");
  expect(host.textContent).toContain(`Février ${YEAR - 1}`);
});

test("kitchen queries carry only the QR header and never offer a chef export", async () => {
  await act(async () => root.render(<HaccpEntries establishmentName="Chez TEST" kitchenToken="qr-test-token" />));
  expect(global.fetch.mock.calls[0][1]).toEqual(expect.objectContaining({
    credentials: "include", headers: { "X-Sirius-Cuisine": "qr-test-token" },
  }));
  expect(button("Exporter")).toBeUndefined();
  await select("Mois", "11");
  expect(global.fetch.mock.calls[1][1].headers["X-Sirius-Cuisine"]).toBe("qr-test-token");
});

test("chef CSV export requests the whole period rather than the displayed page", async () => {
  global.fetch.mockImplementation(async (url) => url.includes("/export-csv") ? csvReply() : reply(pageFor(url, 30)));
  await act(async () => root.render(<HaccpEntries establishmentName="Chez TEST" />));
  await select("Mois", "11");
  await click("Suivant");
  await click("Exporter");
  const call = global.fetch.mock.calls.find(([url]) => url.includes("/export-csv"));
  const params = new URL(call[0]).searchParams;
  expect(params.get("annee")).toBe(String(YEAR));
  expect(params.get("mois")).toBe("11");
  expect(params.get("restaurant_name")).toBe("Chez TEST");
  expect(params.has("offset")).toBe(false);
  expect(params.has("limit")).toBe(false);
  expect(downloads).toEqual([`entrees_${YEAR}-11.csv`]);
});

test("a failed or non-CSV export reports the problem without a success-shaped download", async () => {
  await act(async () => root.render(<HaccpEntries establishmentName="Chez TEST" />));
  global.fetch.mockResolvedValueOnce({ ...csvReply(), headers: { get: () => "text/html" } });
  await click("Exporter");
  expect(host.querySelector('[role="alert"]').textContent).toContain("fichier des entrées est invalide");
  expect(downloads).toHaveLength(0);
  global.fetch.mockResolvedValueOnce(reply({ detail: "Export réservé au chef." }, false, 403));
  await click("Exporter");
  expect(host.querySelector('[role="alert"]').textContent).toContain("Export réservé");
  expect(downloads).toHaveLength(0);
});

test("a late reply cannot show the previous period under a newly selected month", async () => {
  const first = deferred(), second = deferred();
  global.fetch.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  await act(async () => root.render(<HaccpEntries establishmentName="Chez TEST" />));
  await select("Mois", "12");
  expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(host.querySelector("table")).toBeNull();
  const recent = pageFor(global.fetch.mock.calls[1][0]);
  recent.items[0].produit = "Nouveau mois TEST";
  await act(async () => second.resolve(reply(recent)));
  const stale = pageFor(global.fetch.mock.calls[0][0]);
  stale.items[0].produit = "Ancien mois TEST";
  await act(async () => first.resolve(reply(stale)));
  expect(host.textContent).toContain("Nouveau mois TEST");
  expect(host.textContent).not.toContain("Ancien mois TEST");
});

test.each(["establishment", "period", "item-period", "count", "quantity", "zero", "date"])(
  "invalid %s data is rejected explicitly before showing or exporting it", async (invalid) => {
    global.fetch.mockImplementation(async (url) => {
      const data = pageFor(url);
      if (invalid === "establishment") data.restaurant_name = "Ailleurs";
      if (invalid === "period") data.annee += 1;
      if (invalid === "item-period") data.items[0].date = `${YEAR - 1}-11-13`;
      if (invalid === "count") data.total = 2;
      if (invalid === "quantity") data.items[0].quantite = 3.25;
      if (invalid === "zero") data.items[0].quantite = "0";
      if (invalid === "date") data.items[0].date = `${YEAR}-02-30`;
      return reply(data);
    });
    await act(async () => root.render(<HaccpEntries establishmentName="Chez TEST" />));
    expect(host.querySelector('[role="alert"]').textContent).toContain("registre des entrées invalide");
    expect(host.querySelector("table")).toBeNull();
    expect(button("Exporter").disabled).toBe(true);
  },
);

test("a line outside the selected month cannot appear under that month's heading", async () => {
  await act(async () => root.render(<HaccpEntries establishmentName="Chez TEST" />));
  global.fetch.mockImplementation(async (url) => {
    const data = pageFor(url);
    data.items[0].date = `${YEAR}-11-13`;
    return reply(data);
  });
  await select("Mois", "12");
  expect(host.querySelector('[role="alert"]').textContent).toContain("registre des entrées invalide");
  expect(host.querySelector("table")).toBeNull();
});

test("an emptied later page retains a way back instead of claiming the period has no entries", async () => {
  global.fetch.mockImplementation(async (url) => reply(pageFor(url, 30)));
  await act(async () => root.render(<HaccpEntries establishmentName="Chez TEST" />));
  global.fetch.mockImplementation(async (url) => reply(pageFor(url, 5)));
  await click("Suivant");
  expect(host.textContent).toContain("Actualisez le registre");
  expect(host.textContent).not.toContain("Aucune entrée pour cette période");
  expect(button("Précédent").disabled).toBe(false);
  await click("Actualiser");
  expect(host.querySelectorAll("tbody tr")).toHaveLength(5);
});

test("a pending export is single-flight and cannot download after leaving the register", async () => {
  const pending = deferred();
  await act(async () => root.render(<HaccpEntries establishmentName="Chez TEST" />));
  global.fetch.mockImplementationOnce(() => pending.promise);
  const exportButton = button("Exporter");
  await act(async () => { exportButton.click(); exportButton.click(); });
  expect(global.fetch.mock.calls.filter(([url]) => url.includes("/export-csv"))).toHaveLength(1);
  await act(async () => root.render(<div>Autre écran</div>));
  await act(async () => pending.resolve(csvReply()));
  expect(downloads).toHaveLength(0);
});

test("unknown quantities are not zero and exact values never go through Number", () => {
  expect(formatReceivedQuantity(null)).toBe("Non lue");
  expect(formatReceivedQuantity("999999999.9999")).toBe("999999999,9999");
  expect(validReceivedQuantity(null)).toBe(true);
  expect(validReceivedQuantity("0.0001")).toBe(true);
  expect(validReceivedQuantity(2)).toBe(false);
  expect(validReceivedQuantity("0.0000")).toBe(false);
});

test("a missing establishment cancels a pending read and leaves a clear choice instruction", async () => {
  const pending = deferred();
  global.fetch.mockImplementationOnce(() => pending.promise);
  await act(async () => root.render(<HaccpEntries establishmentName="Chez TEST" />));
  await act(async () => root.render(<HaccpEntries establishmentName="" />));
  expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(host.textContent).toContain("Choisissez d’abord l’établissement");
  expect(host.textContent).not.toContain("Lecture des entrées");
  await act(async () => pending.resolve(reply(pageFor(global.fetch.mock.calls[0][0]))));
  expect(host.querySelector("table")).toBeNull();
});

test("read errors are visible and Actualiser retries instead of showing an empty success", async () => {
  global.fetch.mockResolvedValueOnce(reply({ detail: "Registre indisponible." }, false));
  await act(async () => root.render(<HaccpEntries establishmentName="Chez TEST" />));
  expect(host.querySelector('[role="alert"]').textContent).toContain("Registre indisponible");
  expect(host.textContent).not.toContain("Aucune entrée");
  await click("Actualiser");
  expect(host.querySelector("table")).not.toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
