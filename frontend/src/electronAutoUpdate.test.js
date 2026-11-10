const mockLoadUpdater = jest.fn();
const mockAutoUpdater = {
  on: jest.fn(),
  checkForUpdates: jest.fn(),
};

jest.mock("electron-updater", () => {
  mockLoadUpdater();
  return { autoUpdater: mockAutoUpdater };
});

const originalWindowsStore = Object.getOwnPropertyDescriptor(process, "windowsStore");
let handlers;
let events;
let app;
let ipcMain;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.useFakeTimers();
  handlers = {};
  events = {};
  app = { getVersion: jest.fn(() => "1.0.70"), on: jest.fn() };
  ipcMain = { handle: jest.fn((name, handler) => { handlers[name] = handler; }) };
  mockAutoUpdater.on.mockImplementation((name, handler) => { events[name] = handler; });
  mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: "1.0.70" } });
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  if (originalWindowsStore) Object.defineProperty(process, "windowsStore", originalWindowsStore);
  else delete process.windowsStore;
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("MSIX delegates updates without loading the GitHub updater or scheduling checks", async () => {
  Object.defineProperty(process, "windowsStore", { configurable: true, value: true });
  const { setupAutoUpdater } = require("../public/electron/auto_update");
  setupAutoUpdater({ app, ipcMain });

  const state = { phase: "managed-externally", channel: "msix" };
  expect(handlers["sirius-update-status"]()).toEqual(state);
  await expect(handlers["sirius-update-check"]()).resolves.toEqual({ ok: true, ...state });
  expect(mockLoadUpdater).not.toHaveBeenCalled();
  expect(app.on).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test("ordinary Windows installs retain scheduled checks and the download lifecycle", async () => {
  Object.defineProperty(process, "windowsStore", { configurable: true, value: undefined });
  const { setupAutoUpdater } = require("../public/electron/auto_update");
  setupAutoUpdater({ app, ipcMain });

  expect(mockLoadUpdater).toHaveBeenCalledTimes(1);
  expect(mockAutoUpdater.autoDownload).toBe(true);
  expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(true);
  await expect(handlers["sirius-update-check"]()).resolves.toEqual({
    ok: true, available: false, phase: "idle", version: null, percent: 0,
  });

  events["update-available"]({ version: "1.0.71" });
  events["download-progress"]({ percent: 38.2 });
  expect(handlers["sirius-update-status"]()).toEqual({
    phase: "downloading", version: "1.0.71", percent: 38,
  });
  events["update-downloaded"]({ version: "1.0.71" });
  await expect(handlers["sirius-update-check"]()).resolves.toEqual({
    ok: true, available: true, phase: "ready", version: "1.0.71", percent: 100,
  });

  jest.advanceTimersByTime(15 * 1000);
  expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  jest.advanceTimersByTime(4 * 60 * 60 * 1000 - 15 * 1000);
  expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
  const quitHandler = app.on.mock.calls.find(([event]) => event === "will-quit")[1];
  quitHandler();
  jest.advanceTimersByTime(4 * 60 * 60 * 1000);
  expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
});

test("ordinary Windows installs report a failed manual check", async () => {
  Object.defineProperty(process, "windowsStore", { configurable: true, value: undefined });
  const { setupAutoUpdater } = require("../public/electron/auto_update");
  setupAutoUpdater({ app, ipcMain });
  mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error("hors ligne"));
  await expect(handlers["sirius-update-check"]()).resolves.toEqual({ ok: false, message: "hors ligne" });
});
