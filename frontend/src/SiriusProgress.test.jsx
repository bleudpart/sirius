import { act } from "react";
import { createRoot } from "react-dom/client";
import SiriusProgress, { progress } from "./SiriusProgress";

let root;
let host;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

test("journal-only mode records tasks and opens even when no progress panel is shown", async () => {
  await act(async () => root.render(<SiriusProgress journalOnly />));
  expect(host.querySelector('[data-testid="sirius-progress-panel"]')).toBeNull();
  await act(async () => {
    const id = progress.start("Mon dossier");
    progress.done(id, "Dossier enregistré");
    window.dispatchEvent(new Event("sirius-journal-open"));
  });
  expect(host.querySelector('[data-testid="sirius-journal-panel"]')).not.toBeNull();
  expect(host.textContent).toContain("Dossier enregistré");
  await act(async () => host.querySelector('[data-testid="sirius-journal-close-btn"]').click());
  expect(host.querySelector('[data-testid="sirius-journal-panel"]')).toBeNull();
});
