"use strict";

class ApiError extends Error {
  constructor(status) {
    super(`API SIRIUS indisponible (${status}).`);
    this.status = status;
  }
}

async function api(path, token, body, fetcher = fetch) {
  const base = new URL(process.env.SIRIUS_API_ORIGIN);
  if (base.protocol !== "https:" || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash) {
    throw new Error("SIRIUS_API_ORIGIN doit être une origine HTTPS sans chemin.");
  }
  if (typeof token !== "string" || !/^saa_[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(401);
  const target = new URL(path, base);
  if (!path.startsWith("/api/integrations/") || target.origin !== base.origin ||
      !target.pathname.startsWith("/api/integrations/")) throw new Error("Chemin API invalide.");
  const response = await fetcher(target, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(6500),
  });
  if (!response.ok) throw new ApiError(response.status);
  if (!response.body) throw new Error("Réponse SIRIUS vide.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 96000) throw new Error("Réponse SIRIUS trop volumineuse.");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

module.exports = { api, ApiError };
