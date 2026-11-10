import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpModule from "./HaccpModule";

jest.mock("./HaccpWorkspace", () => ({
  __esModule: true,
  HACCP_CAPTURE_URL: "https://sirius-assistant.fr/haccp",
  default: ({ onDirtyChange }) => <button type="button" onClick={() => onDirtyChange(true)}>Saisie non enregistrée</button>,
}));

global.IS_REACT_ACT_ENVIRONMENT = true;

test("the HUD close and module navigation protect an unfinished kitchen record", async () => {
  const originalFetch = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }));
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
  const onClose = jest.fn();
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<HaccpModule onClose={onClose} />));
  await act(async () => [...host.querySelectorAll("button")].find((item) => item.textContent === "Saisie non enregistrée").click());
  await act(async () => host.querySelector('[data-testid="haccp-close-btn"]').click());
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="haccp-section-trace"]')).not.toBeNull();
  await act(async () => host.querySelector('[data-testid^="haccp-tab-"]:not([data-testid="haccp-tab-trace"])').click());
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[data-testid="haccp-section-trace"]')).not.toBeNull();
  confirm.mockReturnValue(true);
  await act(async () => host.querySelector('[data-testid="haccp-close-btn"]').click());
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  host.remove(); global.fetch = originalFetch; jest.restoreAllMocks();
});
