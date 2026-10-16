import { API_BASE_URL } from "./lib/api";

export function newChronosRequestId() {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("Ce navigateur ne permet pas de créer une requête sûre. Utilisez une version récente de l’application.");
  }
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function chronosConfirmation(text, token) {
  if (!/^[a-f0-9]{12}$/.test(token || "")) return null;
  const value = String(text).toLowerCase().replace(/[,.!?]/g, "").replace(/\s+/g, " ").trim();
  if (/^(oui|oui je confirme|je confirme|confirme|ok)$/.test(value)) return `confirme agenda ${token}`;
  if (/^(non|annule|non annule|annuler)$/.test(value)) return `annule agenda ${token}`;
  return null;
}

export const isChronosCommand = (text) => {
  const value = String(text || "");
  if (/\b(outlook|google|gmail)\b/i.test(value)) return false;
  return /\b(agenda|rendez[- ]vous|rdv|cr[ée]neaux?|emploi du temps)\b/i.test(value)
    || /\bqu['’]ai[- ]je pr[ée]vu\b|\b(?:mon planning|programme du jour|mes r[ée]unions)\b/i.test(value)
    || /\b(ajoute|cr[ée]e|programme|d[ée]cale|reporte|supprime|modifie|annule)\b.{0,50}\br[ée]union\b/i.test(value);
};

export const localDateTime = (value = new Date()) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function localTimeCandidates(value) {
  const first = new Date(value);
  if (!Number.isFinite(first.getTime()) || localDateTime(first) !== value) return [];
  const wall = first.getTime() - first.getTimezoneOffset() * 60000;
  const offsets = new Set([-86400000, 0, 86400000].map((shift) => new Date(first.getTime() + shift).getTimezoneOffset()));
  return Array.from(offsets, (offset) => new Date(wall + offset * 60000))
    .filter((candidate) => localDateTime(candidate) === value).sort((a, b) => a - b);
}

export function agendaPayload(form, timezone, original = null) {
  const resolve = (field) => {
    const candidates = localTimeCandidates(form[field]);
    if (!form[`${field}Occurrence`] && original && localDateTime(original[field]) === form[field]) {
      return new Date(original[field]);
    }
    if (candidates.length > 1 && !["0", "1"].includes(form[`${field}Occurrence`])) {
      throw new Error("Cette heure existe deux fois lors du changement d’heure. Choisissez son occurrence.");
    }
    return candidates[Number(form[`${field}Occurrence`] || 0)] || new Date(NaN);
  };
  const start = resolve("start");
  const end = resolve("end");
  if (!form.title.trim() || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
    || localDateTime(start) !== form.start || localDateTime(end) !== form.end || end <= start) {
    throw new Error("Indiquez un titre et des horaires valides, avec une fin après le début.");
  }
  const withOffset = (value) => {
    const minutes = -value.getTimezoneOffset();
    const offset = `${minutes >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
    return `${localDateTime(value)}:00${offset}`;
  };
  return { title: form.title.trim(), start: withOffset(start), end: withOffset(end),
    timezone, notes: form.notes.trim(), allow_conflicts: !!form.allow_conflicts };
}

export async function chronosRequest(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const response = await fetch(`${API_BASE_URL}/chronos${path}`, {
      ...options, credentials: "include", signal: controller.signal,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    const data = await response.json();
    if (!response.ok) {
      const detail = data.detail;
      const message = typeof detail === "string" ? detail : detail?.message
        || (response.status === 422 ? "Horaires ou données invalides." : "Agenda indisponible. Réessayez.");
      const error = new Error(message);
      error.status = response.status;
      error.conflicts = detail?.conflicts;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError" && !options.signal?.aborted) {
      throw new Error("L'agenda ne répond pas. Vérifiez la connexion au backend avant de réessayer.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
