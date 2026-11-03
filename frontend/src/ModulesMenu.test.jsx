import { act } from "react";
import { createRoot } from "react-dom/client";
import { BookOpen } from "lucide-react";
import ModulesMenu from "./ModulesMenu";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const items = [
  { id: "prime", label: "ΣIRIUS PRIME — mémoire", group: "OUTILS", Icon: BookOpen, run: jest.fn() },
  { id: "odysseia", label: "ODYSSEIA — récits", group: "OUTILS", Icon: BookOpen, run: jest.fn() },
];

test("la recherche « sirius » retrouve les modules dont le nom commence par Σ", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ModulesMenu open onClose={jest.fn()} items={items} />));
    const search = document.querySelector('[data-testid="modules-menu-search"]');
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    await act(async () => { setValue.call(search, "sirius"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(document.querySelector('[data-testid="modules-menu-item-prime"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="modules-menu-item-odysseia"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
