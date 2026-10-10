import { API_BASE_URL } from "./api";
import { linkAbortSignal } from "./abortSignal";

export async function withBackendResponse(path, options, consume, { signal, timeoutMs, fetchImpl = fetch }) {
  const controller = new AbortController();
  const unlink = linkAbortSignal(signal, controller);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const checkCancelled = () => {
    if (controller.signal.aborted) throw new DOMException("Requête annulée.", "AbortError");
  };
  try {
    checkCancelled();
    // Use the current fetch so AuthGate can apply cookies, bearer and session refresh.
    const response = await fetchImpl(`${API_BASE_URL}${path}`, {
      ...options,
      credentials: "include",
      signal: controller.signal,
    });
    checkCancelled();
    // Keep the deadline active while consuming JSON or the entire SSE body.
    const result = await consume(response);
    checkCancelled();
    return result;
  } finally {
    clearTimeout(timeout);
    unlink();
  }
}
