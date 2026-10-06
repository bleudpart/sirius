import { act } from "react";
import { createRoot } from "react-dom/client";
import useTouchNav from "./useTouchNav";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test.each([
  [true, "prime-screen"],
  [true, "media-hud-window"],
  [false, "prime-screen"],
  [true, "hud-background"],
  [true, "modwheel-overlay"],
])("module gestures stay local on mobile (mobile=%s, class=%s)", async (mobile, className) => {
  const previous = window.matchMedia;
  window.matchMedia = jest.fn(() => ({ matches: mobile }));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const handlers = { onSwipeLeft: jest.fn(), onPinchStart: jest.fn(), onPinch: jest.fn() };
  function Panel() {
    useTouchNav(handlers);
    return <div className={className}>Contenu</div>;
  }
  const touch = (type, points) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: type === "touchend" ? [] : points },
      changedTouches: { value: points },
    });
    host.firstChild.dispatchEvent(event);
    return event;
  };
  try {
    await act(async () => root.render(<Panel />));
    touch("touchstart", [{ clientX: 300, clientY: 100 }]);
    touch("touchend", [{ clientX: 60, clientY: 110 }]);
    const blocked = mobile && ["prime-screen", "media-hud-window"].includes(className);
    expect(handlers.onSwipeLeft).toHaveBeenCalledTimes(blocked ? 0 : 1);
    touch("touchstart", [{ clientX: 40, clientY: 100 }, { clientX: 140, clientY: 100 }]);
    const move = touch("touchmove", [{ clientX: 40, clientY: 100 }, { clientX: 200, clientY: 100 }]);
    expect(handlers.onPinchStart).toHaveBeenCalledTimes(blocked ? 0 : 1);
    expect(handlers.onPinch).toHaveBeenCalledTimes(blocked ? 0 : 1);
    expect(move.defaultPrevented).toBe(!blocked);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.matchMedia = previous;
  }
});
