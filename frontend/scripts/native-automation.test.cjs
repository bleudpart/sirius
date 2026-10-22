const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { NativeAutomation, installNativeAutomation, SHORTCUT } = require("../public/electron/native_automation");

function harness() {
  const powerMonitor = new EventEmitter();
  const shortcuts = new Map(), notifications = [], calls = [], watchers = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { this.shown = true; }
    close() { this.emit("close"); }
  }
  const win = {
    isDestroyed: () => false, isMinimized: () => true, restore: () => calls.push("restore"),
    show: () => calls.push("show"), focus: () => calls.push("focus"),
    webContents: { send: (channel, state) => calls.push([channel, state]), mainFrame: { url: "http://localhost:3000/" } },
  };
  const fs = {
    promises: { realpath: async (folder) => folder, stat: async () => ({ isDirectory: () => true }) },
    watch(folder, options, callback) {
      assert.equal(options.recursive, false);
      const watcher = new EventEmitter();
      watcher.folder = folder; watcher.callback = callback; watcher.closed = false;
      watcher.close = () => { watcher.closed = true; };
      watchers.push(watcher); return watcher;
    },
  };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [path.resolve("chosen-folder")] }) };
  const manager = new NativeAutomation({
    powerMonitor, Notification, dialog, getWindow: () => win, home: path.resolve("home"), fs,
    globalShortcut: { register: (key, callback) => {
      if (shortcuts.has(key)) return false;
      shortcuts.set(key, callback); return true;
    }, unregister: (key) => shortcuts.delete(key) },
  });
  return { manager, powerMonitor, shortcuts, notifications, calls, watchers, dialog, win };
}

test("session starts disabled; opt-in shortcut wakes without microphone or shell", () => {
  const { manager, shortcuts, calls } = harness();
  const { token, state } = manager.begin();
  assert.equal(state.shortcut, false);
  assert.equal(state.folder, null);
  assert.equal(shortcuts.size, 0);
  manager.configure(token, { shortcut: true, notifications: false, resume: false });
  shortcuts.get(SHORTCUT)();
  assert.ok(calls.includes("restore") && calls.includes("focus"));
  manager.reset();
  assert.equal(shortcuts.size, 0);
  assert.throws(() => manager.configure(token, {}), /expirée/);
});

test("shortcut collision is explicit; existing OS registrations are preserved", () => {
  const { manager, shortcuts } = harness();
  const external = () => {};
  shortcuts.set(SHORTCUT, external);
  const { token } = manager.begin();
  assert.throws(() => manager.configure(token, { shortcut: true, notifications: false, resume: false }), /déjà utilisé/);
  assert.equal(manager.snapshot().shortcut, false);
  manager.reset();
  assert.equal(shortcuts.get(SHORTCUT), external);
});

test("resume/unlock are opt-in, deduplicated; notifications contain no file names", async () => {
  const { manager, powerMonitor, notifications } = harness();
  const { token } = manager.begin();
  powerMonitor.emit("resume");
  assert.equal(manager.events.length, 0);
  manager.configure(token, { shortcut: false, notifications: true, resume: true });
  powerMonitor.emit("resume"); powerMonitor.emit("unlock-screen");
  assert.equal(manager.events.filter((event) => event.kind === "resume").length, 1);
  assert.equal(notifications.length, 1);
  notifications[0].emit("click");
  assert.equal(manager.events[0].kind, "review");
  manager.reset();
  assert.equal(powerMonitor.listenerCount("resume"), 0);
  assert.equal(powerMonitor.listenerCount("unlock-screen"), 0);
});

test("only the chosen folder is watched without content reads; errors stop it", async () => {
  const { manager, watchers } = harness();
  const { token } = manager.begin();
  await manager.chooseFolder(token);
  const first = watchers[0];
  first.callback("rename", "document.txt");
  first.callback("change", "document.txt");
  assert.equal(manager.events.filter((event) => event.kind === "folder-change").length, 1);
  assert.equal(manager.events[0].name, "document.txt");
  await manager.chooseFolder(token);
  assert.equal(first.closed, true);
  watchers[1].emit("error", new Error("offline"));
  assert.equal(manager.folder, null);
  assert.equal(manager.events[0].kind, "error");
  assert.equal(watchers[1].closed, true);
});

test("dialog cancellation preserves watcher; expired selection cannot restart monitoring", async () => {
  const { manager, dialog, watchers } = harness();
  const { token } = manager.begin();
  await manager.chooseFolder(token);
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  await manager.chooseFolder(token);
  assert.equal(watchers[0].closed, false);
  let resolve;
  dialog.showOpenDialog = () => new Promise((done) => { resolve = done; });
  const selection = manager.chooseFolder(token);
  manager.reset();
  resolve({ canceled: false, filePaths: [path.resolve("chosen-folder")] });
  await assert.rejects(selection, /expirée/);
  assert.equal(manager.folder, null);
  assert.equal(watchers.length, 1);
});

test("no root/home watch, bounded log and token-scoped stop", async () => {
  const { manager, dialog } = harness();
  const { token } = manager.begin();
  for (const folder of [path.parse(process.cwd()).root, manager.home]) {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    await assert.rejects(manager.chooseFolder(token), /dossier précis/);
  }
  for (let i = 0; i < 120; i++) manager.record("test", "Event");
  assert.equal(manager.events.length, 100);
  const next = manager.begin();
  assert.throws(() => manager.assertToken(token), /expirée/);
  manager.assertToken(next.token);
});

test("IPC rejects subframes, foreign origins and secondary windows", async () => {
  const { manager, win } = harness();
  const handlers = {};
  installNativeAutomation({ manager, getWindow: () => win, origin: () => "http://localhost:3000",
    ipcMain: { handle: (name, callback) => { handlers[name] = callback; } } });
  const begin = handlers["sirius-native-begin"];
  for (const event of [
    { sender: {}, senderFrame: win.webContents.mainFrame },
    { sender: win.webContents, senderFrame: { url: "http://localhost:3000/" } },
  ]) await assert.rejects(begin(event), /refusé/);
  win.webContents.mainFrame.url = "https://untrusted.invalid";
  await assert.rejects(begin({ sender: win.webContents, senderFrame: win.webContents.mainFrame }), /refusé/);
  win.webContents.mainFrame.url = "http://localhost:3000/";
  const result = await begin({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  assert.ok(result.token);
  await assert.rejects(handlers["sirius-native-stop"]({
    sender: win.webContents, senderFrame: win.webContents.mainFrame,
  }, "bad-token"), /expirée/);
});

test("notification failures are journaled; old-session notifications cannot reopen a new account", () => {
  const { manager, notifications } = harness();
  const { token } = manager.begin();
  manager.configure(token, { shortcut: false, notifications: true, resume: false });
  manager.notify();
  notifications[0].emit("failed");
  assert.equal(manager.events[0].kind, "error");
  manager.begin();
  notifications[0].emit("click");
  notifications[0].emit("failed");
  assert.equal(manager.events.length, 0);
});

test("failure to create the replacement watcher does not leave a false active folder", async () => {
  const { manager, watchers } = harness();
  const { token } = manager.begin();
  await manager.chooseFolder(token);
  manager.fs.watch = () => { throw new Error("Access denied"); };
  await assert.rejects(manager.chooseFolder(token), /Access denied/);
  assert.equal(watchers[0].closed, true);
  assert.equal(manager.snapshot().folder, null);
});

test("real Windows filesystem watcher detects a synthetic file and is closed on stop", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sirius-native-watch-test-"));
  const file = path.join(folder, "synthetic.txt");
  const { manager, dialog } = harness();
  manager.fs = fs;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  t.after(() => {
    manager.reset();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  });
  const { token } = manager.begin();
  await manager.chooseFolder(token);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No filesystem event received")), 5000);
    const previous = manager.record.bind(manager);
    manager.record = (...args) => {
      previous(...args);
      if (args[0] === "folder-change") { clearTimeout(timer); resolve(); }
    };
    fs.writeFileSync(file, "synthetic data only", "utf8");
  });
  assert.equal(manager.events[0].name, "synthetic.txt");
  const watcher = manager.watcher;
  let closed = false;
  watcher.once("close", () => { closed = true; });
  manager.reset();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
  assert.equal(manager.folder, null);
});
