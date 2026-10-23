const baseUrl = (value) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname.replace(/\/$/, "") !== "/api" || url.port && url.port !== "443") {
    throw new Error("URL HTTPS publique terminee par /api requise.");
  }
  return url.toString().replace(/\/$/, "") + "/integrations/zapier";
};

const request = async (z, bundle, path, options = {}) => {
  const response = await z.request({
    url: baseUrl(bundle.authData.apiUrl) + path,
    method: options.method || "GET",
    headers: {
      "X-Sirius-Api-Key": bundle.authData.apiKey,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...options,
    redirect: "error",
    skipThrowForStatus: true,
  });
  if (response.status === 401) {
    throw new z.errors.ExpiredAuthError("Cle SIRIUS expiree ou revoquee ; reconnectez ce compte Zapier.");
  }
  if (response.status === 429) {
    throw new z.errors.ThrottledError("Limite SIRIUS atteinte.", 60);
  }
  response.throwForStatus();
  return response.json;
};

module.exports = { baseUrl, request };
