import { act } from "react";
import { createRoot } from "react-dom/client";
import ArchiveGallery from "./ArchiveGallery";
import { API_BASE_URL } from "./lib/api";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
let host, root;

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

test("archives use the shared API base and distinguish an outage from an empty library", async () => {
  const json = jest.fn();
  global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, json })
    .mockResolvedValueOnce({ ok: true, json: async () => [] });
  await act(async () => root.render(<ArchiveGallery onClose={() => {}} />));
  expect(global.fetch).toHaveBeenCalledWith(`${API_BASE_URL}/archive/list`);
  expect(json).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Impossible de charger");
  expect(host.textContent).not.toContain("Aucune archive pour l'instant");
  await act(async () => host.querySelector('[data-testid="archive-gallery-refresh"]').click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("Aucune archive pour l'instant");
});
