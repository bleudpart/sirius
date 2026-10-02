import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpModule from "./HaccpModule";
import ThemisPanel from "./ThemisPanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function renderPanel(Component, initialSource, responseFor) {
  const originalFetch = global.fetch;
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    json: async () => responseFor(String(url)),
  }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<Component initialSource={initialSource} onClose={() => {}} />);
    });
    return { container, root, originalFetch };
  } catch (error) {
    act(() => root.unmount());
    container.remove();
    global.fetch = originalFetch;
    throw error;
  }
}

function cleanup({ container, root, originalFetch }) {
  act(() => root.unmount());
  container.remove();
  global.fetch = originalFetch;
}

test("HACCP opens the referenced non-conformity without changing its status", async () => {
  const mounted = await renderPanel(HaccpModule, { kind: "haccp_nonconformity", id: "nc-42" }, (url) => {
    if (url.endsWith("/nc")) return {
      items: [{ id: "nc-42", type: "température", gravite: "mineure", description: "Réfrigérateur", statut: "ouverte" }],
    };
    return {};
  });
  try {
    expect(mounted.container.querySelector('[data-testid="haccp-tab-nc"].on')).not.toBeNull();
    expect(mounted.container.querySelector("#haccp-source-nc-42")?.classList.contains("hc-source-focus")).toBe(true);
    expect(global.fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  } finally {
    cleanup(mounted);
  }
});

test("THÉMIS opens the referenced low-stock article without changing stock", async () => {
  const mounted = await renderPanel(ThemisPanel, { kind: "stock", id: "item-42" }, (url) => {
    if (url.endsWith("/mythos/characters")) return { characters: [] };
    if (url.endsWith("/items")) return { items: [{ id: "item-42", name: "Papier", ref: "P42", price: 1, stock: 2, alert: 3 }] };
    const type = url.split("/").pop();
    if (["docs", "orders", "clients", "payments", "pieces", "templates"].includes(type)) return { [type]: [] };
    return {};
  });
  try {
    expect(mounted.container.querySelector('[data-testid="themis-tab-stock"].active')).not.toBeNull();
    expect(mounted.container.querySelector("#themis-source-item-42")?.classList.contains("th-source-focus")).toBe(true);
    expect(global.fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  } finally {
    cleanup(mounted);
  }
});
