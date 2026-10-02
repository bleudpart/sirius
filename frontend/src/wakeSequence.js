export function startWakeSequence({ announce, briefing, readMail, isSpeaking, isEnabled }) {
  let cancelled = false;
  let cancelDelay = null;
  const active = () => !cancelled && isEnabled();
  const delay = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      cancelDelay = null;
      resolve(active());
    }, ms);
    cancelDelay = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });

  const run = async () => {
    if (!active()) return;
    announce();
    if (!await delay(5000)) return;
    await briefing();
    if (!await delay(3000)) return;
    const started = Date.now();
    while (isSpeaking() && Date.now() - started < 240000) {
      if (!await delay(1000)) return;
    }
    if (!await delay(800)) return;
    if (active()) await readMail();
  };
  run().catch((error) => console.error("[SIRIUS] Réveil matinal interrompu", error));

  return () => {
    cancelled = true;
    cancelDelay?.();
    cancelDelay = null;
  };
}
