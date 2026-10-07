import { act } from "react";
import { createRoot } from "react-dom/client";
import ConsultPanel from "./ConsultPanel";
import { BACKEND_BASE_URL } from "./lib/api";

jest.mock("./MythosBackdrop", () => () => null);
jest.mock("./voice", () => ({
  speakAsCharacter: jest.fn(),
  cancelSpeech: jest.fn(),
}));

const originalFetch = global.fetch;
let host;
let root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ history: [] }),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  global.fetch = originalFetch;
});

test.each([["SOLON#", "solon"], ["PROMÉTHÉE#", "promethee"]])(
  "%s loads its portrait from the backend rather than the Android WebView",
  async (module, slug) => {
    await act(async () => root.render(<ConsultPanel module={module} onClose={() => {}} />));
    expect(host.querySelector(`[data-testid="${slug}-portrait"]`).getAttribute("src")).toBe(
      `${BACKEND_BASE_URL}/api/mythos/img/${slug}.jpg`,
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `${BACKEND_BASE_URL}/api/mythos/consult/history?module=${encodeURIComponent(module)}`,
    );
  },
);
