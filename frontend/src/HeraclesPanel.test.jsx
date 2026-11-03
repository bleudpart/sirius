import { act } from "react";
import { createRoot } from "react-dom/client";
import HeraclesPanel from "./HeraclesPanel";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host;
let root;
let oldFetch;
let openWindow;

beforeEach(() => {
  oldFetch = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ characters: [] }) }));
  openWindow = jest.spyOn(window, "open").mockImplementation(() => null);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = oldFetch;
  jest.restoreAllMocks();
});

async function setValue(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("opens only explicitly authorized passive searches and never calls the stub analysis API", async () => {
  await act(async () => root.render(<HeraclesPanel initialInput="domain:example.com" />));
  expect(host.querySelector('[data-testid="heracles-domain-input"]').value).toBe("example.com");
  expect(host.querySelector('[data-testid="heracles-domain-open"]').disabled).toBe(true);

  await act(async () => host.querySelector('[data-testid="heracles-domain-authorized"]').click());
  await act(async () => host.querySelector('[data-testid="heracles-domain-open"]').click());

  expect(openWindow).toHaveBeenCalledTimes(3);
  expect(openWindow).toHaveBeenCalledWith(
    "https://crt.sh/?q=%25.example.com", "_blank", "noopener,noreferrer",
  );
  expect(openWindow).toHaveBeenCalledWith(
    "https://www.shodan.io/search?query=hostname%3Aexample.com", "_blank", "noopener,noreferrer",
  );
  expect(host.querySelectorAll(".her-domain-links a")).toHaveLength(3);
  expect(global.fetch).not.toHaveBeenCalledWith(
    expect.stringContaining("/heracles/check"), expect.anything(),
  );
});

test("does not open searches for an invalid target", async () => {
  await act(async () => root.render(<HeraclesPanel initialInput="domain:" />));
  await setValue(host.querySelector('[data-testid="heracles-domain-input"]'), "127.0.0.1");
  await act(async () => host.querySelector('[data-testid="heracles-domain-authorized"]').click());
  await act(async () => host.querySelector('[data-testid="heracles-domain-open"]').click());

  expect(openWindow).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="heracles-domain-error"]').textContent).toContain("domaine public valide");
});
