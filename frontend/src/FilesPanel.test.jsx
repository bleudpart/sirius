import { act } from "react";
import { createRoot } from "react-dom/client";
import FilesPanel from "./FilesPanel";

jest.mock("./DropZone", () => ({ __esModule: true, default: () => null, autoAnalyze: jest.fn() }));
jest.mock("./FileViewer", () => ({ __esModule: true, default: () => null }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("file creation dates display as JJ/MM/AAAA", async () => {
  const originalFetch = global.fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => [{ id: "demo", original_filename: "Document fictif.txt", content_type: "text/plain", size: 100, created_at: "2026-10-04T23:30:00Z", dossier: "Documents" }],
  });
  try {
    await act(async () => root.render(<FilesPanel onClose={() => {}} />));
    expect(host.querySelector(".file-info").textContent).toContain("04/10/2026");
    expect(host.querySelector(".file-info").textContent).not.toContain("2026-10-04");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    global.fetch = originalFetch;
  }
});
