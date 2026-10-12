import { act } from "react";
import { createRoot } from "react-dom/client";
import MobileNavigation from "./MobileNavigation";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let navigate;
let handle;
let drawer;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  navigate = jest.fn();
  act(() => root.render(<MobileNavigation active="home" onNavigate={navigate} />));
  handle = host.querySelector(".mobile-navigation-handle");
  drawer = host.querySelector("nav");
  handle.setPointerCapture = jest.fn();
  handle.hasPointerCapture = jest.fn().mockReturnValue(true);
  handle.releasePointerCapture = jest.fn();
  handle.getBoundingClientRect = () => ({ height: 44 });
  drawer.getBoundingClientRect = () => ({ height: 116 });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function pointer(type, y, extra = {}) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { clientY: y, pointerId: 1, isPrimary: true, button: 0, ...extra });
  act(() => handle.dispatchEvent(event));
}

test("starts retracted and can be opened and closed with the handle", () => {
  expect(handle.getAttribute("aria-expanded")).toBe("false");
  expect(drawer.classList.contains("is-collapsed")).toBe(true);
  act(() => handle.click());
  expect(handle.getAttribute("aria-expanded")).toBe("true");
  act(() => handle.click());
  expect(handle.getAttribute("aria-expanded")).toBe("false");
});

test("follows the thumb and snaps open upwards or closed downwards", () => {
  pointer("pointerdown", 700);
  pointer("pointermove", 650);
  expect(drawer.style.getPropertyValue("--mobile-nav-offset")).toBe("22px");
  pointer("pointerup", 650);
  expect(handle.getAttribute("aria-expanded")).toBe("true");
  act(() => handle.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  expect(handle.getAttribute("aria-expanded")).toBe("true");
  pointer("pointerdown", 650);
  pointer("pointermove", 700);
  pointer("pointerup", 700);
  expect(handle.getAttribute("aria-expanded")).toBe("false");
  expect(navigate).not.toHaveBeenCalled();
});

test("cancelled or short drags preserve the original position", () => {
  pointer("pointerdown", 700);
  pointer("pointermove", 650);
  pointer("pointercancel", 650);
  expect(handle.getAttribute("aria-expanded")).toBe("false");
  expect(drawer.style.getPropertyValue("--mobile-nav-offset")).toBe("");
  pointer("pointerdown", 700);
  pointer("pointermove", 690);
  pointer("pointerup", 690);
  expect(handle.getAttribute("aria-expanded")).toBe("false");
});

test("all five destinations remain available and selecting one retracts the drawer", () => {
  for (const id of ["home", "info", "assistant", "modules", "profile"]) {
    act(() => handle.click());
    act(() => host.querySelector(`[data-testid="mobile-nav-${id}"]`).click());
    expect(navigate).toHaveBeenLastCalledWith(id);
    expect(handle.getAttribute("aria-expanded")).toBe("false");
  }
  expect(host.querySelector('[data-testid="mobile-nav-home"]').getAttribute("aria-current")).toBe("page");
});

test("ignores secondary pointers", () => {
  pointer("pointerdown", 700, { isPrimary: false });
  pointer("pointermove", 600);
  pointer("pointerup", 600);
  expect(handle.getAttribute("aria-expanded")).toBe("false");
  expect(handle.setPointerCapture).not.toHaveBeenCalled();
});
