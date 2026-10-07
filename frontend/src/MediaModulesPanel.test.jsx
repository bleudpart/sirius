import { act } from "react";
import { createRoot } from "react-dom/client";
import MediaModulesPanel from "./MediaModulesPanel";

jest.mock("./ModulesMedia", () => () => <div data-testid="media-catalogue">Catalogue</div>);

test("the media catalogue has its own module window and close action", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = jest.fn();
  try {
    await act(async () => root.render(<MediaModulesPanel onClose={close} />));
    expect(host.querySelector('[data-testid="media-modules-panel"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="media-catalogue"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="sirius-display"]')).toBeNull();
    await act(async () => host.querySelector("button").click());
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
