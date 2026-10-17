import { API_BASE_URL } from "./lib/api";

export const normalizeSearch = (value) => String(value || "").normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function matchesSearch(query, ...values) {
  const text = normalizeSearch(values.join(" "));
  return normalizeSearch(query).split(/\s+/).filter(Boolean).every((word) => text.includes(word));
}

export async function readSearchSource(source, query, { signal, microsoftFetch, fetcher = fetch }) {
  const response = source === "dossiers"
    ? await fetcher(`${API_BASE_URL}/work-dossiers`, { credentials: "include", signal })
    : await microsoftFetch(`/microsoft/search?query=${encodeURIComponent(query)}&top=8`, { signal });
  if (!response.ok) {
    if (response.status === 401 || response.status === 409) {
      throw new Error(source === "dossiers" ? "Session du service expirée. Reconnectez-vous." : "Connectez ou reconnectez votre compte Microsoft.");
    }
    throw new Error(`Le service ne répond pas correctement (HTTP ${response.status}).`);
  }
  const data = await response.json();
  if (source === "dossiers") {
    if (!Array.isArray(data?.dossiers) || data.dossiers.some((item) => !item || typeof item.id !== "string" || typeof item.title !== "string"
      || [item.description, item.category].some((value) => value != null && typeof value !== "string"))) {
      throw new Error("La liste des dossiers reçue est incomplète.");
    }
    return { items: data.dossiers.filter((item) => matchesSearch(query, item.title, item.description, item.category))
      .map((item) => ({ kind: "dossier", id: item.id, title: item.title, detail: item.description || item.category })), warnings: [] };
  }
  if (!["contacts", "emails", "evenements"].every((key) => Array.isArray(data?.[key]))) {
    throw new Error("Les résultats Microsoft reçus sont incomplets.");
  }
  for (const [key, fields] of Object.entries({
    contacts: ["id", "nom", "email", "telephone"], emails: ["id", "sujet", "de", "recu", "apercu"], evenements: ["id", "titre", "debut"],
  })) {
    if (data[key].some((item) => !item || fields.some((field) => item[field] != null && typeof item[field] !== "string"))) {
      throw new Error("Le format des résultats Microsoft est invalide.");
    }
  }
  const labels = { contacts: "Contacts", emails: "Courriels", evenements: "Agenda" };
  const warnings = Object.entries(labels).flatMap(([key, label]) => {
    const state = data.sources?.[key];
    if (state?.status === "available") return [];
    if (state?.status === "unavailable") return [`${label} non consulté${state.http_status ? ` (HTTP ${state.http_status})` : ""}. Vérifiez les autorisations et la connexion Microsoft.`];
    return [`${label} : le serveur ne confirme pas l'état de cette source. Une liste vide ne prouve pas l'absence de résultat.`];
  });
  return { items: [
    ...data.contacts.map((item, index) => ({ kind: "contact", id: item.id || `contact-${index}`, title: item.nom, detail: [item.email, item.telephone].filter(Boolean).join(" · "), contact: item })),
    ...data.emails.map((item, index) => ({ kind: "email", id: item.id || `email-${index}`, title: item.sujet, detail: [item.de, item.recu, item.apercu].filter(Boolean).join(" · ") })),
    ...data.evenements.map((item, index) => ({ kind: "event", id: item.id || `event-${index}`, title: item.titre, detail: item.debut })),
  ], warnings };
}
