import { API_BASE_URL } from "../lib/api";

export async function connectStreamingStt({ contentType, groqKey, signal }) {
  if (typeof WebSocket === "undefined") throw new Error("WebSocket indisponible.");
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const socket = new WebSocket(`${API_BASE_URL.replace(/^http/, "ws")}/stt/stream`);
  let ready = false;
  let finished = false;
  let resolveReady;
  let rejectReady;
  let resolveResult;
  let rejectResult;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  resultPromise.catch(() => {});

  const fail = (error, fromServer = false) => {
    if (!ready) rejectReady(error);
    if (!finished) {
      finished = true;
      if (fromServer) error.fromServer = true;
      rejectResult(error);
    }
  };
  const onAbort = () => {
    fail(new DOMException("Aborted", "AbortError"));
    socket.close();
  };
  const readyTimeout = window.setTimeout(
    () => fail(new Error("Le serveur audio ne répond pas.")),
    3000,
  );
  signal?.addEventListener("abort", onAbort, { once: true });
  socket.onopen = () => {
    try {
      socket.send(JSON.stringify({
        action: "start",
        content_type: contentType,
        groq_key: groqKey || "",
      }));
    } catch (error) {
      fail(error);
    }
  };
  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      fail(new Error("Réponse invalide du flux audio."), true);
      return;
    }
    if (message.type === "ready") {
      ready = true;
      window.clearTimeout(readyTimeout);
      resolveReady();
    } else if (message.type === "transcript") {
      finished = true;
      resolveResult(message.data || {});
      signal?.removeEventListener("abort", onAbort);
    } else if (message.type === "error") {
      fail(new Error(message.detail || "Transcription vocale impossible."), true);
      signal?.removeEventListener("abort", onAbort);
    } else {
      fail(new Error("Événement inattendu du flux audio."), true);
    }
  };
  socket.onerror = () => fail(new Error("Connexion au flux audio impossible."));
  socket.onclose = () => {
    if (!finished) fail(new Error("Le flux audio a été interrompu."));
    signal?.removeEventListener("abort", onAbort);
  };

  try {
    await readyPromise;
  } catch (error) {
    window.clearTimeout(readyTimeout);
    signal?.removeEventListener("abort", onAbort);
    socket.close();
    throw error;
  }

  return {
    send(chunk) {
      if (socket.readyState !== WebSocket.OPEN) return false;
      socket.send(chunk);
      return true;
    },
    finish() {
      if (!finished && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: "finish" }));
      }
      return resultPromise;
    },
    close() {
      signal?.removeEventListener("abort", onAbort);
      if (!finished) {
        finished = true;
        rejectResult(new DOMException("Aborted", "AbortError"));
      }
      socket.close();
    },
  };
}
