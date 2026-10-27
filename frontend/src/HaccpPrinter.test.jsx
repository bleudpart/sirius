import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpPrinter, { useHaccpPrinterRelay } from "./HaccpPrinter";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, oldFetch;
const config = { deviceName: "USB labels", widthMm: 60, heightMm: 50, enabled: true };
const reply = (data, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => data });
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text));
const field = (text) => [...host.querySelectorAll("label")].find((item) => item.textContent.trim().startsWith(text))?.querySelector("input,select");

beforeEach(() => {
  oldFetch = global.fetch;
  global.fetch = jest.fn(async () => reply({ configured: true }));
  window.siriusHaccpPrinter = {
    getConfig: jest.fn(async () => config),
    listPrinters: jest.fn(async () => [{ name: "USB labels", displayName: "USB labels" }]),
    configure: jest.fn(async (value) => value),
    printJob: jest.fn(async () => ({ accepted: true })),
  };
  localStorage.setItem("sirius_haccp_print_relay_id", "ed10a199-a945-4dd5-9851-e90ad5436d51");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = oldFetch;
  delete window.siriusHaccpPrinter;
  localStorage.clear(); jest.useRealTimers(); jest.restoreAllMocks();
});

test("Windows configuration detects printers and activates only after the scoped server accepts", async () => {
  await act(async () => root.render(<HaccpPrinter />));
  expect(field("Imprimante Windows").value).toBe("USB labels");
  expect(field("Largeur").value).toBe("60");
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(window.siriusHaccpPrinter.configure.mock.calls[0][0]).toEqual({ ...config, enabled: false });
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
    relay_id: "ed10a199-a945-4dd5-9851-e90ad5436d51", device_name: "USB labels", width_mm: 60, height_mm: 50,
  });
  expect(window.siriusHaccpPrinter.configure.mock.calls[1][0]).toEqual(config);
});

test("server refusal leaves the local station disabled and reports the cause", async () => {
  global.fetch.mockResolvedValue(reply({ detail: "Compte Cloud non relié" }, false));
  await act(async () => root.render(<HaccpPrinter />));
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(window.siriusHaccpPrinter.configure).toHaveBeenCalledTimes(1);
  expect(window.siriusHaccpPrinter.configure).toHaveBeenCalledWith({ ...config, enabled: false });
  expect(host.querySelector('[role="alert"]').textContent).toContain("Compte Cloud non relié");
});

test("mobile explains that the Windows relay must be configured and never touches desktop APIs", async () => {
  delete window.siriusHaccpPrinter;
  await act(async () => root.render(<HaccpPrinter />));
  expect(host.textContent).toContain("application Windows");
  expect(button("Détecter")).toBeUndefined();
  expect(global.fetch).not.toHaveBeenCalled();
});

function Relay() {
  const { error, status } = useHaccpPrinterRelay("user-one");
  return <div>{error ? <p role="alert">{error}</p> : <p>{status}</p>}</div>;
}
const job = { id: "c76e3188-786b-41a8-88e8-c50e9551f108", html: "<article>Label</article>", widthMm: 60, heightMm: 50 };

test("relay claims, sends only the server document to Electron and acknowledges spooler acceptance", async () => {
  global.fetch.mockResolvedValueOnce(reply({ job })).mockResolvedValueOnce(reply({ status: "accepted" }));
  await act(async () => root.render(<Relay />));
  expect(window.siriusHaccpPrinter.printJob).toHaveBeenCalledTimes(1);
  expect(window.siriusHaccpPrinter.printJob).toHaveBeenCalledWith(job);
  expect(JSON.parse(global.fetch.mock.calls[1][1].body).status).toBe("accepted");
  expect(host.textContent).toContain("Vérifiez la sortie papier");
});

test("printer error is acknowledged uncertain and automatically stops consuming instead of reprinting", async () => {
  window.siriusHaccpPrinter.printJob.mockRejectedValue(new Error("Papier absent"));
  global.fetch.mockResolvedValueOnce(reply({ job })).mockResolvedValueOnce(reply({ status: "uncertain" }));
  await act(async () => root.render(<Relay />));
  expect(JSON.parse(global.fetch.mock.calls[1][1].body).status).toBe("uncertain");
  expect(host.querySelector('[role="alert"]').textContent).toContain("Papier absent");
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(window.siriusHaccpPrinter.printJob).toHaveBeenCalledTimes(1);
});

test("lost acknowledgement never resubmits the physical print", async () => {
  global.fetch.mockResolvedValueOnce(reply({ job })).mockRejectedValueOnce(new Error("Connexion perdue"));
  await act(async () => root.render(<Relay />));
  expect(host.querySelector('[role="alert"]').textContent).toContain("Connexion perdue");
  expect(window.siriusHaccpPrinter.printJob).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("disabled station never claims a job", async () => {
  window.siriusHaccpPrinter.getConfig.mockResolvedValue({ ...config, enabled: false });
  await act(async () => root.render(<Relay />));
  expect(global.fetch).not.toHaveBeenCalled();
  expect(window.siriusHaccpPrinter.printJob).not.toHaveBeenCalled();
});
