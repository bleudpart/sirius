const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const nodeFs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  CHANNELS, CONFIG_FILE, JOURNAL_FILE, MAX_HTML_LENGTH, MEASURE_SCRIPT, installHaccpPrinter, buildPrintDocument,
} = require("../public/electron/haccp_printer");

const USER_DATA = path.resolve("haccp-user-data");
const ORIGIN = "http://localhost:3000";
const CONFIG = { deviceName: "Zebra ZD421", widthMm: 50, heightMm: 30, enabled: true };

function memoryFs(files = new Map()) {
  const writes = [], ops = [];
  const missing = (file) => Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
  const fs = {
    files, writes, ops,
    async mkdir() {},
    async readFile(file) { if (!files.has(file)) throw missing(file); return files.get(file); },
    async writeFile(file, data) { writes.push(file); files.set(file, data); },
    async open(file, flags) {
      assert.equal(flags, "wx");
      if (files.has(file)) throw Object.assign(new Error(`EEXIST ${file}`), { code: "EEXIST" });
      writes.push(file); files.set(file, ""); ops.push(["open", file]);
      return {
        writeFile: async (data) => { await fs.writeFile(file, data); writes.pop(); ops.push(["write", file]); },
        sync: async () => { ops.push(["sync", file]); },
        close: async () => { ops.push(["close", file]); },
      };
    },
    async rename(from, to) {
      if (!files.has(from)) throw missing(from);
      ops.push(["rename", from, to]); files.set(to, files.get(from)); files.delete(from);
    },
    async unlink(file) { if (!files.has(file)) throw missing(file); files.delete(file); },
  };
  return fs;
}

const fitting = (options) => {
  const px = (mm) => Math.ceil((mm * 96) / 25.4);
  const doc = Buffer.from(options.url.split(",")[1], "base64").toString("utf8");
  const [, w, h] = doc.match(/@page\{size:([\d.]+)mm ([\d.]+)mm/);
  return { labelWidth: px(+w), labelHeight: px(+h), bodyWidth: px(+w), bodyHeight: px(+h) };
};

function harness({ fs = memoryFs(), printers = [{ name: "Zebra ZD421", displayName: "Zebra", isDefault: true }],
  printBehavior = (_options, callback) => callback(true, ""), timeoutMs = 1000, measure = fitting } = {}) {
  const handlers = new Map();
  const windows = [];
  const mainFrame = { url: `${ORIGIN}/haccp` };
  const main = {
    isDestroyed: () => false,
    webContents: { mainFrame, getPrintersAsync: async () => printers },
  };
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options; this.destroyed = false; this.prints = []; this.requests = []; this.scripts = [];
      this.contentSize = [options.width, options.height];
      const contents = new EventEmitter();
      contents.session = {
        setPermissionRequestHandler: (handler) => { this.permissionHandler = handler; },
        setPermissionCheckHandler: (handler) => { this.permissionCheck = handler; },
        webRequest: { onBeforeRequest: (handler) => { this.requestHandler = handler; } },
      };
      contents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
      contents.print = (printOptions, callback) => { this.prints.push(printOptions); printBehavior(printOptions, callback, this); };
      contents.executeJavaScript = async (code, userGesture) => {
        this.scripts.push([code, userGesture, [...this.contentSize]]);
        return measure(this);
      };
      this.webContents = contents;
      windows.push(this);
    }
    async loadURL(url) { this.url = url; }
    setContentSize(width, height) { this.contentSize = [width, height]; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const app = { getPath: (name) => { assert.equal(name, "userData"); return USER_DATA; } };
  const printer = installHaccpPrinter({ ipcMain, app, BrowserWindow: FakeBrowserWindow, getWindow: () => main,
    origin: () => ORIGIN, fs, timeoutMs });
  const event = { sender: main.webContents, senderFrame: mainFrame };
  const invoke = (channel, ...args) => handlers.get(channel)(event, ...args);
  return { printer, handlers, windows, main, fs, invoke, event, FakeBrowserWindow };
}

const configPath = path.join(USER_DATA, CONFIG_FILE);
const journalPath = path.join(USER_DATA, JOURNAL_FILE);
const job = (overrides = {}) => ({ id: randomUUID(), html: "<p>Poulet</p>", widthMm: 50, heightMm: 30, ...overrides });
const journal = (fs) => JSON.parse(fs.files.get(journalPath));

async function configured(options = {}) {
  const h = harness(options);
  await h.invoke(CHANNELS.configure, { ...CONFIG });
  return h;
}

test("installe les quatre canaux et expose une configuration non secrète", async () => {
  const h = harness();
  assert.deepEqual([...h.handlers.keys()].sort(), Object.values(CHANNELS).sort());
  assert.equal(await h.invoke(CHANNELS.getConfig), null);
  assert.deepEqual(await h.invoke(CHANNELS.configure, { ...CONFIG }), CONFIG);
  assert.deepEqual(await h.invoke(CHANNELS.getConfig), CONFIG);
  assert.deepEqual(JSON.parse(h.fs.files.get(configPath)), CONFIG);
  assert.deepEqual(await h.invoke(CHANNELS.listPrinters),
    [{ name: "Zebra ZD421", displayName: "Zebra", description: "", isDefault: true }]);
});

test("refuse les appels hors frame principal, autre fenêtre ou autre origine", async () => {
  const h = harness();
  const handler = h.handlers.get(CHANNELS.getConfig);
  const denied = /Accès à l'imprimante HACCP refusé/;
  await assert.rejects(handler({ sender: h.main.webContents, senderFrame: { url: `${ORIGIN}/frame` } }), denied);
  await assert.rejects(handler({ sender: {}, senderFrame: h.main.webContents.mainFrame }), denied);
  await assert.rejects(handler({ sender: h.main.webContents, senderFrame: null }), denied);
  h.main.webContents.mainFrame.url = "https://evil.example/";
  await assert.rejects(handler(h.event), denied);
  h.main.webContents.mainFrame.url = "not a url";
  await assert.rejects(handler(h.event), denied);
  h.main.webContents.mainFrame.url = `${ORIGIN}/`;
  await assert.rejects(handler(h.event, 1, 2), /Arguments/);
});

test("valide strictement la configuration", async () => {
  const h = harness();
  const bad = [
    null, {}, { ...CONFIG, enabled: "true" }, { ...CONFIG, enabled: undefined }, { ...CONFIG, extra: 1 },
    { deviceName: "Zebra ZD421", widthMm: 50, heightMm: 30 }, { ...CONFIG, widthMm: 19 }, { ...CONFIG, widthMm: 151 },
    { ...CONFIG, heightMm: 301 }, { ...CONFIG, heightMm: Infinity }, { ...CONFIG, widthMm: NaN },
    { ...CONFIG, widthMm: "50" }, { ...CONFIG, deviceName: "" }, { ...CONFIG, deviceName: "a\nb" },
  ];
  for (const config of bad) await assert.rejects(h.invoke(CHANNELS.configure, config), Error, JSON.stringify(config));
  await assert.rejects(h.invoke(CHANNELS.configure, { ...CONFIG, deviceName: "Absente" }), /introuvable/);
  await assert.rejects(h.invoke(CHANNELS.configure, { ...CONFIG, deviceName: "zebra zd421" }), /introuvable/);
  assert.equal(h.fs.files.has(configPath), false);
  assert.deepEqual(await h.invoke(CHANNELS.configure, { ...CONFIG, deviceName: "Absente", enabled: false, widthMm: 150, heightMm: 300 }),
    { deviceName: "Absente", enabled: false, widthMm: 150, heightMm: 300 });
});

test("écrit la configuration par fichier temporaire unique puis renommage", async () => {
  const h = harness();
  await h.invoke(CHANNELS.configure, { ...CONFIG });
  await h.invoke(CHANNELS.configure, { ...CONFIG, widthMm: 60 });
  assert.equal(h.fs.writes.length, 2);
  assert.notEqual(h.fs.writes[0], h.fs.writes[1]);
  for (const file of h.fs.writes) assert.match(file, /haccp-printer\.json\.\d+\.[0-9a-f-]{36}\.tmp$/);
  const temp = h.fs.writes[0];
  assert.deepEqual(h.fs.ops.slice(0, 5),
    [["open", temp], ["write", temp], ["sync", temp], ["close", temp], ["rename", temp, configPath]]);
  assert.deepEqual([...h.fs.files.keys()], [configPath]);
});

test("une configuration enregistrée corrompue produit une erreur explicite", async () => {
  const h = harness();
  h.fs.files.set(configPath, "{oops");
  await assert.rejects(h.invoke(CHANNELS.getConfig), /illisible/);
  h.fs.files.set(configPath, JSON.stringify({ ...CONFIG, widthMm: 999 }));
  await assert.rejects(h.invoke(CHANNELS.getConfig), /enregistrée invalide/);
});

test("imprime en fenêtre cachée isolée avec les options silencieuses du pilote configuré", async () => {
  const h = await configured();
  const request = job({ id: randomUUID().toUpperCase() });
  assert.deepEqual(await h.invoke(CHANNELS.printJob, request), { accepted: true, id: request.id.toLowerCase() });
  const [win] = h.windows;
  assert.equal(win.options.show, false);
  assert.deepEqual(
    Object.fromEntries(["sandbox", "contextIsolation", "nodeIntegration", "javascript", "webSecurity", "nodeIntegrationInSubFrames"].map((k) => [k, win.options.webPreferences[k]])),
    { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, webSecurity: true, nodeIntegrationInSubFrames: false });
  assert.deepEqual([win.options.show, win.options.frame, win.options.useContentSize, win.options.width, win.options.height],
    [false, false, true, 189, 114]);
  assert.deepEqual(win.scripts, [[MEASURE_SCRIPT, false, [189, 114]]]);
  assert.equal(win.options.webPreferences.preload, undefined);
  assert.ok(!win.options.webPreferences.partition.startsWith("persist:"));
  assert.deepEqual(win.prints, [{ silent: true, printBackground: true, deviceName: "Zebra ZD421",
    pageSize: { width: 50000, height: 30000 }, margins: { marginType: "none" } }]);
  assert.equal(win.destroyed, true);
  assert.equal(journal(h.fs).jobs[request.id.toLowerCase()].state, "accepted");

  const html = Buffer.from(win.url.split(",")[1], "base64").toString("utf8");
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<p>Poulet</p>"));
  assert.match(html, /content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'/);
  assert.match(html, /<body><div id="sirius-haccp-label"><p>Poulet<\/p><\/div><\/body>/);
  assert.match(html, /#sirius-haccp-label\{[^}]*width:50mm;height:30mm;overflow:hidden\}/);
  assert.match(html, /@page\{size:50mm 30mm;margin:0\}/);

  const decisions = [];
  win.requestHandler({ url: win.url }, (result) => decisions.push(result.cancel));
  win.requestHandler({ url: "https://evil.example/pixel.png" }, (result) => decisions.push(result.cancel));
  win.requestHandler({ url: "file:///C:/secret" }, (result) => decisions.push(result.cancel));
  assert.deepEqual(decisions, [false, true, true]);
  win.permissionHandler(null, "media", (allowed) => assert.equal(allowed, false));
  assert.equal(win.permissionCheck(), false);
  assert.deepEqual(win.openHandler({ url: "https://evil.example" }), { action: "deny" });
  for (const name of ["will-navigate", "will-redirect", "will-attach-webview"]) {
    let prevented = false;
    win.webContents.emit(name, { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, name);
  }
});

test("le travail ne peut ni choisir l'imprimante ni contenir un HTML non borné", async () => {
  const h = await configured();
  const cases = [
    [job({ deviceName: "Autre" }), /ne peut pas choisir l'imprimante/],
    [job({ printerName: "Autre" }), /ne peut pas choisir l'imprimante/],
    [job({ id: "pas-un-uuid" }), /UUID/],
    [job({ html: "" }), /vide/],
    [job({ html: 5 }), /vide/],
    [job({ html: "x".repeat(MAX_HTML_LENGTH + 1) }), /trop long/],
    [job({ html: "<!DOCTYPE html><p>x</p>" }), /refusé/],
    [job({ html: "<p>x</p><SCRIPT>alert(1)</SCRIPT>" }), /refusé/],
    [job({ html: '<meta http-equiv="refresh" content="0;url=https://evil">' }), /refusé/],
    [job({ html: '<iframe src="https://evil"></iframe>' }), /refusé/],
    [job({ html: '<base href="https://evil/">' }), /refusé/],
    [job({ html: '<img src="x" onerror="alert(1)">' }), /refusé/],
    [job({ html: '<p\nONCLICK = "x">a</p>' }), /refusé/],
    [job({ widthMm: "50" }), /Largeur/],
    [job({ heightMm: NaN }), /Hauteur/],
    [{ id: randomUUID(), html: "<p>x</p>", widthMm: 50 }, /champs attendus/],
  ];
  for (const [request, error] of cases) await assert.rejects(h.invoke(CHANNELS.printJob, request), error);
  assert.equal(h.windows.length, 0);
  assert.equal(h.fs.files.has(journalPath), false);
  assert.ok(buildPrintDocument(job({ html: "x".repeat(MAX_HTML_LENGTH) })).startsWith("data:text/html;charset=utf-8;base64,"));
});

test("refuse les dimensions différentes de la configuration et une imprimante désactivée ou disparue", async () => {
  const h = await configured();
  await assert.rejects(h.invoke(CHANNELS.printJob, job({ widthMm: 51 })), /différent de la configuration/);
  await assert.rejects(h.invoke(CHANNELS.printJob, job({ heightMm: 31 })), /différent de la configuration/);
  h.main.webContents.getPrintersAsync = async () => [{ name: "Autre" }];
  await assert.rejects(h.invoke(CHANNELS.printJob, job()), /introuvable/);
  await h.invoke(CHANNELS.configure, { ...CONFIG, enabled: false });
  await assert.rejects(h.invoke(CHANNELS.printJob, job()), /non configurée ou désactivée/);
  assert.equal(h.windows.length, 0);
  assert.equal(h.fs.files.has(journalPath), false);
  const fresh = harness();
  await assert.rejects(fresh.invoke(CHANNELS.printJob, job()), /non configurée/);
});

test("rejette explicitement un identifiant déjà soumis, quel que soit son état", async () => {
  let succeed = true;
  const h = await configured({ printBehavior: (_options, callback) => callback(succeed, "Printer offline") });
  const request = job();
  await h.invoke(CHANNELS.printJob, request);
  await assert.rejects(h.invoke(CHANNELS.printJob, { ...request, id: request.id.toUpperCase() }), /déjà soumis \(état : accepted\)/);
  succeed = false;
  const failed = job();
  await assert.rejects(h.invoke(CHANNELS.printJob, failed), /Impression refusée par Windows : Printer offline/);
  assert.equal(journal(h.fs).jobs[failed.id].state, "uncertain");
  await assert.rejects(h.invoke(CHANNELS.printJob, failed), /déjà soumis \(état : uncertain\)/);
  assert.equal(h.windows.length, 2);
  assert.ok(h.windows.every((win) => win.destroyed));
});

test("journalise submitted avant l'appel d'impression et reste bloquant après un crash", async () => {
  const fs = memoryFs();
  let seenState = null;
  const h = await configured({ fs, printBehavior: () => {
    seenState = journal(fs).jobs[request.id].state;
    throw new Error("crash simulé après spool");
  } });
  const request = job();
  await assert.rejects(h.invoke(CHANNELS.printJob, request), /crash simulé/);
  assert.equal(seenState, "submitted");

  const stored = journal(fs);
  stored.jobs[request.id].state = "submitted";
  delete stored.jobs[request.id].error;
  fs.files.set(journalPath, JSON.stringify(stored));
  const restarted = harness({ fs });
  await assert.rejects(restarted.invoke(CHANNELS.printJob, request), /déjà soumis \(état : uncertain\)/);
  assert.equal(journal(fs).jobs[request.id].state, "uncertain");
  assert.match(journal(fs).jobs[request.id].error, /interrompue/);
  assert.equal(restarted.windows.length, 0);
});

test("un journal illisible ou un échec d'écriture empêche toute impression", async () => {
  const h = await configured();
  h.fs.files.set(journalPath, "not json");
  await assert.rejects(h.invoke(CHANNELS.printJob, job()), /illisible/);
  h.fs.files.set(journalPath, JSON.stringify({ version: 1, jobs: [] }));
  await assert.rejects(h.invoke(CHANNELS.printJob, job()), /Journal d'impression HACCP invalide/);
  h.fs.files.delete(journalPath);
  h.fs.writeFile = async () => { throw new Error("disque plein"); };
  const before = h.fs.files.size;
  await assert.rejects(h.invoke(CHANNELS.printJob, job()), /disque plein/);
  assert.equal(h.windows.length, 0);
  assert.equal(h.fs.files.size, before, "fichier temporaire supprimé");
});

test("fsync échoué : fichier fermé, temporaire supprimé, rien renommé", async () => {
  const h = harness();
  const open = h.fs.open;
  h.fs.open = async (...args) => {
    const handle = await open(...args);
    return { ...handle, sync: async () => { throw new Error("fsync impossible"); } };
  };
  await assert.rejects(h.invoke(CHANNELS.configure, { ...CONFIG }), /fsync impossible/);
  assert.ok(h.fs.ops.some(([op]) => op === "close"));
  assert.ok(!h.fs.ops.some(([op]) => op === "rename"));
  assert.equal(h.fs.files.size, 0);
});

test("contenu trop grand : refus explicite sans impression, état incertain, aucune réémission", async () => {
  for (const overflow of [{ labelHeight: 116 }, { labelWidth: 192 }, { bodyHeight: 400 }]) {
    const h = await configured({ measure: (win) => ({ ...fitting(win), ...overflow }) });
    const request = job();
    await assert.rejects(h.invoke(CHANNELS.printJob, request),
      /Contenu trop grand pour l'étiquette 50×30 mm .*agrandissez le format/);
    assert.equal(h.windows[0].prints.length, 0);
    assert.equal(h.windows[0].destroyed, true);
    assert.equal(journal(h.fs).jobs[request.id].state, "uncertain");
    assert.match(journal(h.fs).jobs[request.id].error, /Contenu trop grand/);
    await assert.rejects(h.invoke(CHANNELS.printJob, request), /déjà soumis \(état : uncertain\)/);
    assert.equal(h.windows.length, 1);
  }
});

test("tolérance de 2 px et mesure invalide", async () => {
  const ok = await configured({ measure: (win) => ({ ...fitting(win), labelWidth: 190.9, labelHeight: 115.3 }) });
  assert.equal((await ok.invoke(CHANNELS.printJob, job())).accepted, true);
  for (const value of [null, { labelWidth: 1 }, { labelWidth: NaN, labelHeight: 1, bodyWidth: 1, bodyHeight: 1 }]) {
    const h = await configured({ measure: () => value });
    await assert.rejects(h.invoke(CHANNELS.printJob, job()), /Mesure du contenu d'étiquette impossible/);
    assert.equal(h.windows[0].prints.length, 0);
  }
});

test("expiration : fenêtre fermée, état incertain, rappel tardif ignoré, sans nouvelle tentative", async () => {
  let late = null;
  const h = await configured({ timeoutMs: 20, printBehavior: (_options, callback) => { late = callback; } });
  const request = job();
  await assert.rejects(h.invoke(CHANNELS.printJob, request), /Délai d'impression dépassé .*incertain/);
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(journal(h.fs).jobs[request.id].state, "uncertain");
  late(true, "");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(journal(h.fs).jobs[request.id].state, "uncertain");
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].prints.length, 1);
});

test("sérialise les opérations : un second travail concurrent est refusé", async () => {
  let release = null;
  const h = await configured({ printBehavior: (_options, callback) => { release = () => callback(true, ""); } });
  const first = h.invoke(CHANNELS.printJob, job());
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(h.invoke(CHANNELS.printJob, job()), /déjà en cours/);
  await assert.rejects(h.invoke(CHANNELS.configure, { ...CONFIG }), /déjà en cours/);
  release();
  assert.equal((await first).accepted, true);
  assert.equal(h.windows.length, 1);
});

test("écriture atomique réelle dans un dossier userData de test", async () => {
  const dir = path.join(__dirname, `.haccp-printer-test-${randomUUID()}`);
  try {
    const h = harness({ fs: nodeFs });
    h.printer.app = { getPath: () => dir };
    await h.invoke(CHANNELS.configure, { ...CONFIG });
    const request = job();
    await h.invoke(CHANNELS.printJob, request);
    assert.deepEqual((await nodeFs.readdir(dir)).sort(), [JOURNAL_FILE, CONFIG_FILE].sort());
    assert.deepEqual(JSON.parse(await nodeFs.readFile(path.join(dir, CONFIG_FILE), "utf8")), CONFIG);
    assert.equal(JSON.parse(await nodeFs.readFile(path.join(dir, JOURNAL_FILE), "utf8")).jobs[request.id].state, "accepted");
  } finally {
    await nodeFs.rm(dir, { recursive: true, force: true });
  }
});