import React, { act } from "react";
import { createRoot } from "react-dom/client";
import PortusNummarius from "./PortusNummarius";
import { loadApiKeys, lockApiKeys, saveApiKeys, setKeyAccount } from "./apiKeyStorage";
import { API_BASE_URL } from "./lib/api";

jest.mock("./voice", () => ({ speakAsCharacter: jest.fn() }));
jest.mock("recharts", () => ({
  AreaChart: () => null, Area: () => null, XAxis: () => null, YAxis: () => null,
  Tooltip: () => null, ResponsiveContainer: () => null, CartesianGrid: () => null,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("market, history and alerts use the unlocked personal key in headers, and refresh respects locking", async () => {
  const originalFetch = global.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  setKeyAccount("market-test");
  saveApiKeys({ alphavantage: "personal-market-test-key", groq_key: "not-for-markets" });
  global.fetch = jest.fn((url) => Promise.resolve({
    ok: true, json: async () => String(url).includes("/history/")
      ? { type: "stock", points: [] }
      : String(url).endsWith("/alerts") ? { alerts: [] }
        : { assets: [{ id: "AAPL", label: "Apple", type: "stock", price: 100, change: 1 }], errors: [] },
  }));
  try {
    await act(async () => root.render(<PortusNummarius onClose={jest.fn()} />));
    const calls = global.fetch.mock.calls;
    for (const endpoint of ["/market", "/history/AAPL?range=1m", "/alerts"]) {
      const call = calls.find(([url]) => String(url).endsWith(endpoint));
      expect(call[0]).toContain(`${API_BASE_URL}/nummarius/`);
      expect(call[0]).not.toContain(loadApiKeys().alphavantage);
      expect(call[1]).toEqual({
        credentials: "include", headers: { "X-Sirius-Alphavantage-Key": "personal-market-test-key" },
      });
    }
    lockApiKeys();
    global.fetch.mockClear();
    await act(async () => container.querySelector('[data-testid="nummarius-refresh-btn"]').click());
    expect(global.fetch.mock.calls.every(([, options]) => Object.keys(options.headers).length === 0)).toBe(true);
  } finally {
    act(() => root.unmount()); setKeyAccount(""); global.fetch = originalFetch;
  }
});
