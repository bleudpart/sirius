import { act } from "react";
import { createRoot } from "react-dom/client";
import { ModeBanner, VisionModule } from "./SystemModes";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("Vision offers facial recognition separately and releases its camera before opening FACE ID", async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const stop = jest.fn();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
  } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const open = jest.fn(() => expect(stop).toHaveBeenCalled());
  try {
    await act(async () => root.render(<VisionModule onClose={() => {}} onOpenFaceId={open} />));
    expect(container.textContent).toContain("L'analyse caméra décrit une image");
    await act(async () => container.querySelector('[data-testid="vision-faceid-btn"]').click());
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount()); container.remove();
    if (original) Object.defineProperty(navigator, "mediaDevices", original);
    else delete navigator.mediaDevices;
  }
});

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
