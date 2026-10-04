export function createVoiceSession() {
  let current = new AbortController();
  let stopped = false;
  return {
    get signal() { return current.signal; },
    get stopped() { return stopped; },
    resume() {
      if (stopped) current = new AbortController();
      stopped = false;
      return current.signal;
    },
    stop() {
      stopped = true;
      current.abort();
    },
  };
}

export function linkAbortSignal(signal, controller) {
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return () => signal?.removeEventListener("abort", abort);
}
