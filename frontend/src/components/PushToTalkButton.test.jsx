import React, { act } from "react";
import { createRoot } from "react-dom/client";
import PushToTalkButton from "./PushToTalkButton";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("press captures the pointer, survives leaving the button and stops on release or cancellation", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onStart = jest.fn();
  const onStop = jest.fn();
  try {
    act(() => root.render(<PushToTalkButton active={false} onStart={onStart} onStop={onStop} />));
    const button = container.querySelector("button");
    button.setPointerCapture = jest.fn();
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "pointerId", { value: 7 });
    act(() => button.dispatchEvent(down));
    expect(button.setPointerCapture).toHaveBeenCalledWith(7);
    expect(onStart).toHaveBeenCalledTimes(1);
    act(() => button.dispatchEvent(new Event("pointerout", { bubbles: true })));
    expect(onStop).not.toHaveBeenCalled();
    act(() => button.dispatchEvent(new Event("pointerup", { bubbles: true })));
    expect(onStop).toHaveBeenCalledTimes(1);
    act(() => button.dispatchEvent(new Event("pointercancel", { bubbles: true })));
    expect(onStop).toHaveBeenCalledTimes(2);
    act(() => button.dispatchEvent(new Event("lostpointercapture", { bubbles: true })));
    expect(onStop).toHaveBeenCalledTimes(3);
  } finally {
    act(() => root.unmount());
  }
});
