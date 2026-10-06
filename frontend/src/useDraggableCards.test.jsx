import { act } from "react";
import { createRoot } from "react-dom/client";
import useDraggableCards from "./useDraggableCards";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test.each([true, false])("card headings only intercept desktop dragging (mobile=%s)", async (mobile) => {
  const previous = window.matchMedia;
  window.matchMedia = jest.fn(() => ({ matches: mobile }));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  function Panel() {
    const ref = useDraggableCards();
    return <div ref={ref}><section className="prime-card"><h3>Notifications</h3></section></div>;
  }
  try {
    await act(async () => root.render(<Panel />));
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    host.querySelector("h3").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(!mobile);
    expect(host.querySelector(".prime-card").classList.contains("dragging")).toBe(!mobile);
    window.dispatchEvent(new MouseEvent("pointerup"));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.matchMedia = previous;
    localStorage.clear();
  }
});
