export async function checkHaccpResponse(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = typeof body?.detail === "string" ? body.detail
      : Array.isArray(body?.detail) ? body.detail
        .filter((item) => typeof item?.msg === "string")
        .map((item) => item.msg.replace(/^Value error,\s*/, "")).join(" ") : "";
    const error = new Error(detail || `Opération refusée (${response.status}). Vérifiez la saisie et votre connexion.`);
    error.status = response.status;
    throw error;
  }
  return response;
}

export async function haccpFetch(url, options = {}, readResponse = (response) => response) {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, credentials: "include" });
    return await readResponse(response);
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error("Délai dépassé. Vérifiez le registre ou l’état d’impression avant tout nouvel envoi.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}
