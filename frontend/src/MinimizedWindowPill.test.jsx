import { act } from "react";
import { createRoot } from "react-dom/client";
import MinimizedWindowPill from "./MinimizedWindowPill";
import ModulesMenu from "./ModulesMenu";
import { BookOpen } from "lucide-react";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("restaurer et fermer sont deux boutons indépendants, accessibles au clavier", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onRestore = jest.fn();
  const onClose = jest.fn();
  try {
    await act(async () => root.render(<MinimizedWindowPill label="MODULES" onRestore={onRestore} onClose={onClose} />));
    const buttons = host.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    expect(host.querySelector("button button")).toBeNull();
    await act(async () => buttons[1].click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
    await act(async () => buttons[0].click());
    expect(onRestore).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("la roue MODULES se ferme depuis sa pastille réduite", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onClose = jest.fn();
  try {
    await act(async () => root.render(<ModulesMenu open onClose={onClose}
      items={[{ id: "odysseia", label: "ODYSSEIA", group: "OUTILS", Icon: BookOpen, run: jest.fn() }]} />));
    await act(async () => document.querySelector(".modwheel-min").click());
    expect(document.querySelector('[data-testid="modules-menu-restore"]')).not.toBeNull();
    await act(async () => document.querySelector('[aria-label="Fermer MODULES"]').click());
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
