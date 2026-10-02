import { act } from "react";
import { createRoot } from "react-dom/client";
import { ModeBanner } from "./SystemModes";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test.each([
  ["local", "Mode local · connexion en cours"],
  ["confirmed", "Serveur joint"],
  ["unavailable", "Serveur indisponible · mode local"],
])("shows the %s server status without hiding the local mode", (connection, expected) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ModeBanner mode="frugal" connection={connection} onExit={() => {}} />));
    expect(container.querySelector('[data-testid="frugal-mode-banner"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]').textContent).toBe(expected);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
