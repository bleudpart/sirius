import { API_BASE_URL } from "./lib/api";
import { decimalToScaled, parseDecimalInput } from "./companyFinance";

export async function supplierOrdersRequest(path = "", { token, body, method = "GET", signal } = {}) {
  const response = await fetch(`${API_BASE_URL}${token ? "/public" : ""}/supplier-orders${path}`, {
    method, signal, credentials: token ? "omit" : "include",
    headers: {
      ...(token ? { "X-Sirius-Order-Client": token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error("Réponse du portail illisible. La commande a peut-être été enregistrée : réessayez la même validation."); }
  if (!response.ok) {
    const detail = Array.isArray(data.detail)
      ? data.detail.map((row) => row.msg).join(" · ") : data.detail;
    const error = new Error(typeof detail === "string" ? detail : `Portail indisponible (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function orderDecimal(text, positive = false) {
  const parsed = parseDecimalInput(text, { scale: 4, maxWhole: 9, max: "999999999.9999" });
  if (parsed.error) throw new Error(parsed.error);
  if (positive && decimalToScaled(parsed.value) <= BigInt(0)) throw new Error("La quantité doit être supérieure à zéro.");
  return parsed.value;
}

const centsText = (cents) => {
  const digits = cents.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

export function supplierCart(suppliers, quantities) {
  const groups = [];
  for (const supplier of suppliers) {
    const lines = [];
    let total = BigInt(0);
    for (const product of supplier.products) {
      const text = quantities[product.id] || "";
      if (!text.trim()) continue;
      let quantity;
      try { quantity = orderDecimal(text, true); }
      catch (error) { throw new Error(`${supplier.name} — ${product.name} : ${error.message}`); }
      const cents = (decimalToScaled(product.price) * decimalToScaled(quantity) + BigInt(500000)) / BigInt(1000000);
      lines.push({ ...product, quantity, total: centsText(cents) });
      total += cents;
    }
    if (lines.length) groups.push({ ...supplier, lines, total: centsText(total) });
  }
  if (groups.reduce((sum, group) => sum + group.lines.length, 0) > 200) throw new Error("Le panier est limité à 200 produits.");
  return groups;
}

export const orderAmount = (value) => `${value.replace(".", ",")} €`;
