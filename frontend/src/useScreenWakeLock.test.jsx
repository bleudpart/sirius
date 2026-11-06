import { act } from "react";
import { createRoot } from "react-dom/client";
import useScreenWakeLock from "./useScreenWakeLock";

global.IS_REACT_ACT_ENVIRONMENT = true;

let host, root, oldWakeLock, oldVisibility, visibility;

function Probe({ enabled }) {
  const wakeLock = useScreenWakeLock(enabled);
  return <p data-status={wakeLock.status}>{wakeLock.message}</p>;
}

function makeLock() {
  let onRelease;
  const lock = {
    released: false,
    addEventListener: jest.fn((_event, listener) => { onRelease = listener; }),
    release: jest.fn(async () => {
      lock.released = true;
      onRelease?.();
    }),
  };
  return lock;
}

function setVisibility(value) {
  visibility = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  oldWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
  oldVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (oldWakeLock) Object.defineProperty(navigator, "wakeLock", oldWakeLock);
  else delete navigator.wakeLock;
  if (oldVisibility) Object.defineProperty(document, "visibilityState", oldVisibility);
  else delete document.visibilityState;
  jest.restoreAllMocks();
});

test("releases the screen when hidden and reacquires it on return", async () => {
  const first = makeLock();
  const second = makeLock();
  const request = jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });

  await act(async () => root.render(<Probe enabled />));
  expect(request).toHaveBeenCalledWith("screen");
  expect(host.querySelector("p").dataset.status).toBe("active");

  await act(async () => setVisibility("hidden"));
  expect(first.release).toHaveBeenCalledTimes(1);
  expect(host.querySelector("p").dataset.status).toBe("released");

  await act(async () => setVisibility("visible"));
  expect(request).toHaveBeenCalledTimes(2);
  expect(host.querySelector("p").dataset.status).toBe("active");

  await act(async () => root.render(<Probe enabled={false} />));
  expect(second.release).toHaveBeenCalledTimes(1);
  expect(host.querySelector("p").dataset.status).toBe("idle");
});

test("reports an unexpected release and reacquires on return", async () => {
  const first = makeLock();
  const second = makeLock();
  const request = jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });

  await act(async () => root.render(<Probe enabled />));
  await act(async () => first.release());
  expect(host.querySelector("p").dataset.status).toBe("released");

  await act(async () => setVisibility("visible"));
  expect(request).toHaveBeenCalledTimes(2);
  expect(host.querySelector("p").dataset.status).toBe("active");
});

test("releases a lock that arrives after the page is closed", async () => {
  let finishRequest;
  const lock = makeLock();
  const request = jest.fn(() => new Promise((resolve) => { finishRequest = resolve; }));
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });

  await act(async () => root.render(<Probe enabled />));
  await act(async () => root.render(<div>Fermé</div>));
  await act(async () => { finishRequest(lock); });
  expect(lock.release).toHaveBeenCalledTimes(1);
});

test("retries when the page becomes visible during a pending release", async () => {
  let finishRequest, finishRelease;
  const first = makeLock();
  first.release.mockImplementation(() => new Promise((resolve) => { finishRelease = resolve; }));
  const second = makeLock();
  const request = jest.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { finishRequest = resolve; }))
    .mockResolvedValueOnce(second);
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });

  await act(async () => root.render(<Probe enabled />));
  await act(async () => setVisibility("hidden"));
  await act(async () => { finishRequest(first); });
  expect(first.release).toHaveBeenCalledTimes(1);

  await act(async () => setVisibility("visible"));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => { finishRelease(); });
  expect(request).toHaveBeenCalledTimes(2);
  expect(host.querySelector("p").dataset.status).toBe("active");
});

test("reports unsupported browsers and rejected requests", async () => {
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: undefined });
  await act(async () => root.render(<Probe enabled />));
  expect(host.textContent).toContain("Ce navigateur ne permet pas de garder l’écran allumé.");

  await act(async () => root.render(<Probe enabled={false} />));
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request: jest.fn().mockRejectedValue(new Error("mode économie d’énergie")) },
  });
  await act(async () => root.render(<Probe enabled />));
  expect(host.querySelector("p").dataset.status).toBe("unavailable");
  expect(host.textContent).toContain("mode économie d’énergie");
});
