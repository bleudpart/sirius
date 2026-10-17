import { act } from "react";
import { createRoot } from "react-dom/client";
import EspacePanel from "./EspacePanel";
import FloorPlan from "./FloorPlan";
import KeraunosPanel from "./KeraunosPanel";

jest.mock("@react-three/fiber", () => ({
  Canvas: () => <div data-testid="mock-solar-canvas" />,
  useFrame: jest.fn(),
  useThree: jest.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host;
let root;
const originalFetch = global.fetch;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch;
});

test("solar controls stay grouped separately from close and preserve pause and recenter actions", async () => {
  const close = jest.fn();
  await act(async () => root.render(<EspacePanel onClose={close} />));
  const tools = host.querySelector('[aria-label="Commandes du système solaire"]');
  const pause = host.querySelector('[data-testid="espace-pause-btn"]');
  const recenter = host.querySelector('[data-testid="espace-recenter-btn"]');
  const closeButton = host.querySelector('[data-testid="espace-close-btn"]');
  expect(tools.contains(pause)).toBe(true);
  expect(tools.contains(recenter)).toBe(true);
  expect(tools.contains(closeButton)).toBe(false);
  await act(async () => pause.click());
  expect(pause.textContent).toContain("REPRENDRE");
  await act(async () => recenter.click());
  expect(close).not.toHaveBeenCalled();
  await act(async () => pause.click());
  expect(pause.textContent).toContain("PAUSE");
  await act(async () => closeButton.click());
  expect(close).toHaveBeenCalledTimes(1);
});

test("plan display controls do not submit or clear a description", async () => {
  const close = jest.fn();
  global.fetch = jest.fn();
  await act(async () => root.render(<FloorPlan onClose={close} />));
  const input = host.querySelector('[data-testid="floorplan-input"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "Un bureau de 4 m sur 3");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const tools = host.querySelector('[aria-label="Affichage du plan"]');
  await act(async () => tools.querySelectorAll("button")[1].click());
  expect(tools.querySelectorAll("button")[1].classList.contains("active")).toBe(true);
  expect(input.value).toBe("Un bureau de 4 m sur 3");
  expect(global.fetch).not.toHaveBeenCalled();
  await act(async () => host.querySelector('[data-testid="floorplan-close"]').click());
  expect(close).toHaveBeenCalledTimes(1);
});

test("home options still open configuration without issuing a device command", async () => {
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    json: async () => String(url).endsWith("/ha/config")
      ? { configured: true, base_url: "https://home.example.test" }
      : { entities: [{ entity_id: "light.bureau", name: "Bureau", domain: "light", state: "off", controllable: true }] },
  }));
  const close = jest.fn();
  await act(async () => root.render(<KeraunosPanel onClose={close} />));
  const tools = host.querySelector('[aria-label="Options de domotique"]');
  expect(tools.textContent).toContain("0 actif / 1");
  await act(async () => tools.querySelector('[data-testid="keraunos-settings-btn"]').click());
  expect(host.querySelector(".kr-config")).not.toBeNull();
  expect(global.fetch.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  await act(async () => host.querySelector('[data-testid="keraunos-close-btn"]').click());
  expect(close).toHaveBeenCalledTimes(1);
});
