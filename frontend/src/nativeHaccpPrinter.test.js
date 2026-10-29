import { Capacitor, registerPlugin } from "@capacitor/core";
import { hasAndroidHaccpPrinter, printAndroidOpening, validateAndroidPrinter } from "./nativeHaccpPrinter";

jest.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: jest.fn(() => "android"), isPluginAvailable: jest.fn(() => true) },
  registerPlugin: jest.fn(() => ({ getConfig: jest.fn(), printJob: jest.fn() })),
}));
const plugin = registerPlugin.mock.results[0].value;
const config = { deviceId: "phone", ip: "192.168.1.50", enabled: true, model: "QL-820NWB", roll: "DK-22205", widthMm: 62, heightMm: 50 };
const state = { id: "job", label_id: 8, transport: "android", status: "pending" };
let request;
beforeEach(() => {
  jest.clearAllMocks();
  Capacitor.getPlatform.mockReturnValue("android");
  Capacitor.isPluginAvailable.mockReturnValue(true);
  plugin.getConfig.mockResolvedValue(config);
  plugin.printJob.mockResolvedValue({ accepted: true, detail: "SDK Brother sans erreur" });
  request = jest.fn().mockResolvedValueOnce(state)
    .mockResolvedValueOnce({ job: { id: "job", labelId: 8, product: "Saumon" } })
    .mockResolvedValueOnce({ ...state, status: "accepted" });
});

test("native path uses targeted server validation and acknowledgement without configuring or polling Windows", async () => {
  expect((await printAndroidOpening(8, request)).status).toBe("accepted");
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "/android/demandes", "/android/demandes/job/prise", "/android/demandes/job/confirmation",
  ]);
  expect(request.mock.calls[0][1]).toEqual({ device_id: "phone", label_id: 8, reviewed: true });
  expect(plugin.printJob).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[2][1].status).toBe("accepted");
});

test.each(["accepted", "uncertain", "claimed", "cancelled"])("duplicate %s never invokes the SDK again", async (status) => {
  request.mockReset().mockResolvedValue({ ...state, status });
  expect((await printAndroidOpening(8, request)).status).toBe(status);
  expect(plugin.printJob).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

test("a Windows job never becomes an Android job", async () => {
  request.mockReset().mockResolvedValue({ ...state, transport: "windows" });
  await printAndroidOpening(8, request);
  expect(plugin.printJob).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

test("another claimant or a lost claim response never triggers a print", async () => {
  request.mockReset().mockResolvedValueOnce(state).mockResolvedValueOnce({ job: null });
  expect((await printAndroidOpening(8, request)).status).toBe("uncertain");
  expect(plugin.printJob).not.toHaveBeenCalled();
});

test.each(["Papier absent", "Batterie faible", "Hors ligne", "TIMEOUT_45S", "Demande deja journalisee"])(
  "native failure %s is uncertain with no retries", async (message) => {
    plugin.printJob.mockRejectedValueOnce(new Error(message));
    await printAndroidOpening(8, request);
    expect(request.mock.calls[2][1]).toEqual({ device_id: "phone", status: "uncertain", detail: message });
    expect(plugin.printJob).toHaveBeenCalledTimes(1);
  },
);

test("a malformed native success is never accepted", async () => {
  plugin.printJob.mockResolvedValueOnce({ accepted: "true" });
  await printAndroidOpening(8, request);
  expect(request.mock.calls[2][1].status).toBe("uncertain");
});

test("lost acknowledgement is explicit and never resends", async () => {
  request.mockReset().mockResolvedValueOnce(state)
    .mockResolvedValueOnce({ job: { id: "job", labelId: 8 } }).mockRejectedValueOnce(new Error("offline"));
  await expect(printAndroidOpening(8, request)).rejects.toThrow("Confirmation serveur perdue");
  expect(plugin.printJob).toHaveBeenCalledTimes(1);
});

test.each(["8.8.8.8", "127.0.0.1", "169.254.1.1", "172.32.0.1", "192.168.1.255", "10.0.0.0",
  "192.168.01.1", "192.168.1.256", "http://192.168.1.1", "printer.local", "::1"])(
  "configuration rejects unsafe or ambiguous address %s", (ip) => {
    expect(() => validateAndroidPrinter({ ...config, ip })).toThrow("IPv4");
  },
);

test("unsupported model, roll or dimensions are rejected", () => {
  for (const change of [{ model: "QL-800" }, { roll: "DK-11202" }, { widthMm: 60 }, { heightMm: 51 }]) {
    expect(() => validateAndroidPrinter({ ...config, ...change })).toThrow("QL-820NWB");
  }
});

test("unavailable native plugin and disabled config stop before any server request", async () => {
  Capacitor.isPluginAvailable.mockReturnValue(false);
  expect(hasAndroidHaccpPrinter()).toBe(false);
  await expect(printAndroidOpening(8, request)).rejects.toThrow("compilation Android");
  Capacitor.isPluginAvailable.mockReturnValue(true);
  plugin.getConfig.mockResolvedValue({ ...config, enabled: false });
  await expect(printAndroidOpening(8, request)).rejects.toThrow("activez");
  expect(request).not.toHaveBeenCalled();
});
