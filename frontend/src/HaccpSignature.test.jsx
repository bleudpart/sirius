import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpSignature from "./HaccpSignature";

global.IS_REACT_ACT_ENVIRONMENT = true;

test("the canvas draws with a pointer and can be cleared", async () => {
  const context = {
    beginPath: jest.fn(), moveTo: jest.fn(), lineTo: jest.fn(), stroke: jest.fn(), clearRect: jest.fn(),
  };
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  jest.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,c2lnbg==");
  jest.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 600, height: 150,
  });
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  const change = jest.fn();
  await act(async () => root.render(<HaccpSignature onChange={change} />));
  const canvas = host.querySelector("canvas");
  await act(async () => {
    canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    canvas.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, button: 0, clientX: 50, clientY: 30 }));
    canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
  });
  expect(context.lineTo).toHaveBeenCalled();
  expect(change).toHaveBeenLastCalledWith("data:image/png;base64,c2lnbg==");
  await act(async () => host.querySelector("button").click());
  expect(context.clearRect).toHaveBeenCalled();
  expect(change).toHaveBeenLastCalledWith("");
  await act(async () => root.unmount());
  host.remove();
  jest.restoreAllMocks();
});
