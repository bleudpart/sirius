import { act } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor, registerPlugin } from "@capacitor/core";
import HaccpPrinter, { printHaccpOpening } from "./HaccpPrinter";

jest.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: jest.fn(() => "android"), isPluginAvailable: jest.fn(() => true) },
  registerPlugin: jest.fn(() => ({ getConfig: jest.fn(), configure: jest.fn(), printTest: jest.fn(), requestNetworkAccess: jest.fn() })),
}));
global.IS_REACT_ACT_ENVIRONMENT = true;
const plugin = registerPlugin.mock.results[0].value;
const config = { deviceId: "phone", ip: "192.168.1.50", enabled: true, model: "QL-820NWB", roll: "DK-22205", widthMm: 62, heightMm: 50 };
let host, root, oldFetch;
beforeEach(() => {
  jest.clearAllMocks();
  Capacitor.getPlatform.mockReturnValue("android");
  Capacitor.isPluginAvailable.mockReturnValue(true);
  plugin.getConfig.mockResolvedValue(config);
  plugin.configure.mockImplementation(async (value) => value);
  plugin.requestNetworkAccess.mockResolvedValue({ granted: true });
  plugin.printTest.mockResolvedValue({ accepted: true });
  oldFetch = global.fetch; global.fetch = jest.fn();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = oldFetch;
});

test("Android configuration is saved natively and never assigns a Windows station", async () => {
  await act(async () => root.render(<HaccpPrinter />));
  expect(host.textContent).toContain("DK-22205");
  expect(host.querySelector('input[inputmode="decimal"]').value).toBe(config.ip);
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(plugin.configure).toHaveBeenCalledWith(config);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Aucun poste Windows modifié");
});

test("TEST is explicit, out of registry and does not create any server label or job", async () => {
  await act(async () => root.render(<HaccpPrinter />));
  await act(async () => [...host.querySelectorAll("button")].find((item) => item.textContent.includes("TEST")).click());
  expect(plugin.printTest).toHaveBeenCalledTimes(1);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain("TEST hors registre");
  expect(host.textContent).toContain("Vérifiez le papier");
});

test("test errors are not disguised as success or retried", async () => {
  plugin.printTest.mockResolvedValueOnce({ accepted: false, detail: "Papier absent" });
  await act(async () => root.render(<HaccpPrinter />));
  await act(async () => [...host.querySelectorAll("button")].find((item) => item.textContent.includes("TEST")).click());
  expect(host.querySelector('[role="alert"]').textContent).toBe("Papier absent");
  expect(plugin.printTest).toHaveBeenCalledTimes(1);
});

test("refused local network permission does not activate the printer", async () => {
  plugin.requestNetworkAccess.mockResolvedValueOnce({ granted: false });
  await act(async () => root.render(<HaccpPrinter />));
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(plugin.configure).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Permission réseau local refusée");
});

test("older native APK does not pretend the Brother SDK exists", async () => {
  Capacitor.isPluginAvailable.mockReturnValue(false);
  await act(async () => root.render(<HaccpPrinter />));
  expect(host.querySelector('[role="alert"]').textContent).toContain("nouvelle compilation Android");
  expect(plugin.getConfig).not.toHaveBeenCalled();
  expect(host.querySelector("form")).toBeNull();
});

test.each([false, true])("Windows remains available before opting into native printing (plugin missing: %s)", async (missing) => {
  Capacitor.isPluginAvailable.mockReturnValue(!missing);
  plugin.getConfig.mockResolvedValue({ ...config, enabled: false });
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ status: "pending", transport: "windows" }) });
  expect((await printHaccpOpening(8)).transport).toBe("windows");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/impression\/demandes$/);
});

test("native configuration read failure never silently switches to Windows", async () => {
  plugin.getConfig.mockRejectedValue(new Error("Configuration illisible"));
  await expect(printHaccpOpening(8)).rejects.toThrow("Configuration illisible");
  expect(global.fetch).not.toHaveBeenCalled();
});

test("enabled native printing does not fall back to Windows after a server error", async () => {
  global.fetch.mockRejectedValue(new Error("Serveur indisponible"));
  await expect(printHaccpOpening(8)).rejects.toThrow("Serveur indisponible");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/android\/demandes$/);
});
