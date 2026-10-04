import { withBackendResponse } from "../lib/backendRequest";

export const MAIL_CACHE_PROVIDERS = {
  google: { label: "Gmail", status: "/calendar/status", messages: "/gmail/messages?top=25", limit: 25 },
  microsoft: { label: "Outlook", status: "/microsoft/status", messages: "/microsoft/mail?top=50", limit: 50 },
};
export const MAIL_CACHE_EVENT = "sirius-mail-cache-updated";
const PREFIX = "sirius_mail_cache_v1:";
const empty = () => ({ version: 1, revision: 0, enabled: false, email: "", syncedAt: "", mails: [] });
const text = (value, max) => typeof value === "string" ? value.slice(0, max) : "";

export function mailCacheAccount(user) {
  return String(user?.id || user?._id || user?.user_id || user?.email || "");
}

function key(account, provider) {
  if (!account || !MAIL_CACHE_PROVIDERS[provider]) throw new Error("Compte ou fournisseur du cache mail invalide.");
  return `${PREFIX}${encodeURIComponent(account)}:${provider}`;
}

function sanitizeMail(mail) {
  if (!mail || typeof mail.id !== "string" || !mail.id) throw new Error("Message du cache mail invalide.");
  return {
    id: text(mail.id, 2048), de: text(mail.de, 512), de_email: text(mail.de_email, 320),
    sujet: text(mail.sujet, 512), apercu: text(mail.apercu, 140),
    recu: text(mail.recu, 64), lu: mail.lu === true,
  };
}

export function readMailCache(account, provider) {
  const raw = localStorage.getItem(key(account, provider));
  if (raw === null) return empty();
  const data = JSON.parse(raw);
  if (data?.version !== 1 || !Number.isInteger(data.revision) || data.revision < 0
      || typeof data.enabled !== "boolean" || typeof data.email !== "string"
      || typeof data.syncedAt !== "string" || !Array.isArray(data.mails)
      || data.mails.length > MAIL_CACHE_PROVIDERS[provider].limit
      || (data.enabled && !data.email)) throw new Error("Cache mail illisible. Effacez-le avant de le réactiver.");
  return { ...data, mails: data.mails.map(sanitizeMail) };
}

function write(account, provider, data) {
  localStorage.setItem(key(account, provider), JSON.stringify(data));
  window.dispatchEvent(new CustomEvent(MAIL_CACHE_EVENT, { detail: { account, provider } }));
  return data;
}

export function clearMailCache(account, provider) {
  // A tombstone prevents a response started before erasure from restoring messages.
  return write(account, provider, { ...empty(), revision: Date.now() });
}

async function getJson(path, signal) {
  return withBackendResponse(path, {}, async (response) => {
    if (!response.ok) {
      const error = new Error(`Synchronisation mail refusée (HTTP ${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }, { signal, timeoutMs: 20000 });
}

async function mailboxEmail(provider, signal) {
  const status = await getJson(MAIL_CACHE_PROVIDERS[provider].status, signal);
  if (!status.connected || typeof status.email !== "string" || !status.email.trim()) {
    const error = new Error("Connectez ce compte mail avant d'activer ou de synchroniser le cache.");
    error.code = "MAIL_ACCOUNT_DISCONNECTED";
    throw error;
  }
  return status.email.trim().toLowerCase();
}

export async function enableMailCache(account, provider, signal) {
  const previous = readMailCache(account, provider);
  const email = await mailboxEmail(provider, signal);
  if (signal?.aborted) throw new DOMException("Activation annulée.", "AbortError");
  if (readMailCache(account, provider).revision !== previous.revision) throw new Error("Le cache a changé pendant l'activation. Réessayez.");
  return write(account, provider, { ...empty(), enabled: true, email, revision: previous.revision + 1 });
}

export async function syncMailCache(account, provider, signal) {
  const before = readMailCache(account, provider);
  if (!before.enabled) throw new Error("Le cache mail n'est pas activé.");
  const invalidate = () => {
    const current = readMailCache(account, provider);
    if (current.revision === before.revision && current.enabled && current.email === before.email) clearMailCache(account, provider);
  };
  let email;
  try {
    email = await mailboxEmail(provider, signal);
  } catch (error) {
    if ([401, 403, 409].includes(error.status) || error.code === "MAIL_ACCOUNT_DISCONNECTED") {
      invalidate();
    }
    throw error;
  }
  if (email !== before.email) {
    invalidate();
    throw new Error("Le compte mail connecté a changé. Cache effacé ; une nouvelle activation est nécessaire.");
  }
  let result;
  try {
    result = await getJson(MAIL_CACHE_PROVIDERS[provider].messages, signal);
  } catch (error) {
    if ([401, 403, 409].includes(error.status)) invalidate();
    throw error;
  }
  if (!Array.isArray(result?.mails)) throw new Error("Réponse mail invalide : messages absents.");
  const mails = result.mails.slice(0, MAIL_CACHE_PROVIDERS[provider].limit).map(sanitizeMail);
  if (signal?.aborted) throw new DOMException("Synchronisation annulée.", "AbortError");
  const current = readMailCache(account, provider);
  if (!current.enabled || current.revision !== before.revision || current.email !== email) {
    throw new Error("Synchronisation abandonnée : le cache a été effacé ou modifié.");
  }
  return write(account, provider, { ...before, mails, syncedAt: new Date().toISOString(), revision: before.revision + 1 });
}
