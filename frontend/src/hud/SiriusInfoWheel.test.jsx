import { act } from "react";
import { createRoot } from "react-dom/client";
import { SiriusInfoWheel } from "./SiriusHudPanels";

let host;
let root;
const originalFetch = global.fetch;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  global.fetch = originalFetch;
});

const wheel = () => document.querySelector('[data-testid="info-wheel"]');

test("info wheel stays closed until requested", async () => {
  await act(async () => root.render(<SiriusInfoWheel open={false} onClose={jest.fn()} />));
  expect(wheel()).toBeNull();
});

test("info wheel switches sections and closes with Escape or the close button", async () => {
  const onClose = jest.fn();
  await act(async () => root.render(<SiriusInfoWheel open onClose={onClose} connected ecoMode={false} setEcoMode={jest.fn()} />));
  expect(wheel()).not.toBeNull();
  expect(document.querySelectorAll('[data-testid^="info-wheel-section-"]')).toHaveLength(8);
  expect(document.querySelector(".infowheel-content").textContent).toContain("Agenda");
  await act(async () => document.querySelector('[data-testid="info-wheel-section-heure"]').click());
  expect(document.querySelector(".infowheel-content").textContent).toContain("UTC");
  await act(async () => wheel().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => document.querySelector('[data-testid="info-wheel-close"]').click());
  expect(onClose).toHaveBeenCalledTimes(2);
});
