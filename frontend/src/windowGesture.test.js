import { trackWindowGesture } from "./windowGesture";

let element;
let handle;
let frames;

beforeEach(() => {
  element = document.createElement("section");
  handle = document.createElement("header");
  element.appendChild(handle);
  document.body.appendChild(element);
  handle.setPointerCapture = jest.fn();
  handle.hasPointerCapture = jest.fn(() => true);
  handle.releasePointerCapture = jest.fn();
  frames = [];
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => {
    frames.push(fn); return frames.length;
  });
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => { element.remove(); jest.restoreAllMocks(); });

function pointer(type, id = 1, x = 10, y = 20) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: id, clientX: x, clientY: y, button: 0, isPrimary: true });
  return event;
}

function start(options = {}, eventProps = {}) {
  const onMove = jest.fn();
  const onEnd = jest.fn();
  let dispose;
  handle.addEventListener("pointerdown", (event) => {
    dispose = trackWindowGesture(event, { element, onMove, onEnd, ...options });
  }, { once: true });
  const event = pointer("pointerdown");
  Object.assign(event, eventProps);
  handle.dispatchEvent(event);
  return { onMove, onEnd, dispose, event };
}

test("captures one pointer and applies the latest coordinates only once per frame", () => {
  const { onMove, dispose, event } = start();
  expect(event.defaultPrevented).toBe(true);
  expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
  window.dispatchEvent(pointer("pointermove", 2, 900, 900));
  for (let i = 0; i < 100; i++) window.dispatchEvent(pointer("pointermove", 1, i, i + 1));
  expect(frames).toHaveLength(1);
  expect(onMove).not.toHaveBeenCalled();
  frames.shift()();
  expect(onMove).toHaveBeenCalledTimes(1);
  expect(onMove).toHaveBeenLastCalledWith({ clientX: 99, clientY: 100, pointerId: 1 });
  dispose();
});

test.each(["pointerup", "pointercancel", "lostpointercapture", "blur"])(
  "%s flushes the last movement and cleans up exactly once", (type) => {
    const { onMove, onEnd } = start();
    window.dispatchEvent(pointer("pointermove", 1, 30, 40));
    (type === "lostpointercapture" ? handle : window).dispatchEvent(pointer(type));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(element.classList.contains("window-gesture-active")).toBe(false);
    window.dispatchEvent(pointer("pointermove", 1, 80, 80));
    window.dispatchEvent(pointer("pointerup"));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  }
);

test("another finger cannot release the active drag", () => {
  const { onEnd, dispose } = start();
  window.dispatchEvent(pointer("pointerup", 2));
  expect(onEnd).not.toHaveBeenCalled();
  dispose();
});

test("unmount disposes pending frames without late movement or state updates", async () => {
  const { onMove, onEnd } = start();
  window.dispatchEvent(pointer("pointermove", 1, 30, 40));
  element.remove();
  await Promise.resolve();
  expect(window.cancelAnimationFrame).toHaveBeenCalled();
  expect(onMove).not.toHaveBeenCalled();
  expect(onEnd).not.toHaveBeenCalled();
});

test.each([{ button: 2 }, { isPrimary: false }])("rejects non-primary gestures: %j", (props) => {
  const { event, dispose } = start({}, props);
  expect(event.defaultPrevented).toBe(false);
  expect(handle.setPointerCapture).not.toHaveBeenCalled();
  dispose();
});
