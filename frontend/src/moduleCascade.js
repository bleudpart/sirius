export function startModuleCascade(items) {
  const timers = items.map((item, index) => setTimeout(() => {
    try {
      item.run();
    } catch (error) {
      console.error(`[SIRIUS] Ouverture du module ${item.id} impossible`, error);
    }
  }, index * 280));

  return () => timers.forEach(clearTimeout);
}
