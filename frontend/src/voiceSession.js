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

export { linkAbortSignal } from "./lib/abortSignal";
