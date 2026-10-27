const nodeFs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const CONFIG_FILE = "haccp-printer.json";
const JOURNAL_FILE = "haccp-print-journal.json";
const PRINT_PARTITION = "haccp-printer-isolated";
const MAX_HTML_LENGTH = 100000;
const PRINT_TIMEOUT_MS = 30000;
const WIDTH_RANGE = [20, 150];
const HEIGHT_RANGE = [20, 300];
const CONFIG_KEYS = ["deviceName", "enabled", "heightMm", "widthMm"];
const JOB_KEYS = ["heightMm", "html", "id", "widthMm"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_HTML_RE =
  /<\s*\/?\s*(?:!doctype|html|head|body|script|meta|base|link|iframe|frame|frameset|object|embed|applet|portal|webview)\b/i;
const EVENT_HANDLER_RE = /<[^>]*\son[a-z]+\s*=/i;
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const CSS_DPI = 96;
const OVERFLOW_TOLERANCE_PX = 2;
const LABEL_ID = "sirius-haccp-label";
// Commande fixe (aucune donnée concaténée) exécutée par Electron, pas par la page (CSP script-src 'none').
const MEASURE_SCRIPT =
  '(() => { const label = document.getElementById("sirius-haccp-label"); const body = document.body;' +
  " if (!label || !body) return null;" +
  " return { labelWidth: label.scrollWidth, labelHeight: label.scrollHeight," +
  " bodyWidth: body.scrollWidth, bodyHeight: body.scrollHeight }; })()";
const CHANNELS = {
  getConfig: "sirius-haccp-printer-get-config",
  listPrinters: "sirius-haccp-printer-list",
  configure: "sirius-haccp-printer-configure",
  printJob: "sirius-haccp-printer-print",
};

function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function checkDimension(value, [min, max], label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} invalide : nombre attendu entre ${min} et ${max} mm.`);
  }
  return value;
}

function checkDeviceName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Nom d'imprimante invalide.");
  }
  return value;
}

function validateConfig(config) {
  if (!hasExactKeys(config, CONFIG_KEYS)) {
    throw new Error("Configuration d'imprimante invalide : champs attendus deviceName, widthMm, heightMm, enabled.");
  }
  if (typeof config.enabled !== "boolean") throw new Error("Configuration d'imprimante invalide : enabled doit être true ou false.");
  return {
    deviceName: checkDeviceName(config.deviceName),
    widthMm: checkDimension(config.widthMm, WIDTH_RANGE, "Largeur d'étiquette"),
    heightMm: checkDimension(config.heightMm, HEIGHT_RANGE, "Hauteur d'étiquette"),
    enabled: config.enabled,
  };
}

function validateJob(job) {
  if (job && typeof job === "object" && !Array.isArray(job) &&
      ["deviceName", "printer", "printerName"].some((key) => Object.prototype.hasOwnProperty.call(job, key))) {
    throw new Error("Le travail d'impression ne peut pas choisir l'imprimante : la configuration locale est utilisée.");
  }
  if (!hasExactKeys(job, JOB_KEYS)) throw new Error("Travail d'impression invalide : champs attendus id, html, widthMm, heightMm.");
  if (typeof job.id !== "string" || !UUID_RE.test(job.id)) throw new Error("Identifiant de travail d'impression invalide (UUID attendu).");
  if (typeof job.html !== "string" || !job.html.trim()) throw new Error("Contenu d'étiquette vide.");
  if (job.html.length > MAX_HTML_LENGTH) throw new Error(`Contenu d'étiquette trop long (maximum ${MAX_HTML_LENGTH} caractères).`);
  if (FORBIDDEN_HTML_RE.test(job.html) || EVENT_HANDLER_RE.test(job.html)) {
    throw new Error("Contenu d'étiquette refusé : fragment HTML sans doctype, document, script, gestionnaire d'événement, meta, lien ni cadre attendu.");
  }
  return {
    id: job.id.toLowerCase(),
    html: job.html,
    widthMm: checkDimension(job.widthMm, WIDTH_RANGE, "Largeur du travail"),
    heightMm: checkDimension(job.heightMm, HEIGHT_RANGE, "Hauteur du travail"),
  };
}

function mmToPx(mm) {
  return (mm * CSS_DPI) / 25.4;
}

function checkMeasurement(measure, { widthMm, heightMm }) {
  const keys = ["bodyHeight", "bodyWidth", "labelHeight", "labelWidth"];
  if (!hasExactKeys(measure, keys) || keys.some((key) => typeof measure[key] !== "number" || !Number.isFinite(measure[key]))) {
    throw new Error("Mesure du contenu d'étiquette impossible : impression annulée.");
  }
  const maxWidth = mmToPx(widthMm), maxHeight = mmToPx(heightMm);
  const width = Math.max(measure.labelWidth, measure.bodyWidth);
  const height = Math.max(measure.labelHeight, measure.bodyHeight);
  if (width > maxWidth + OVERFLOW_TOLERANCE_PX || height > maxHeight + OVERFLOW_TOLERANCE_PX) {
    throw new Error(
      `Contenu trop grand pour l'étiquette ${widthMm}×${heightMm} mm (mesuré ${Math.ceil(width)}×${Math.ceil(height)} px, ` +
      `maximum ${Math.round(maxWidth)}×${Math.round(maxHeight)} px) : agrandissez le format d'étiquette ou raccourcissez le contenu.`
    );
  }
}

function buildPrintDocument({ html, widthMm, heightMm }) {
  const document =
    '<!doctype html><html lang="fr"><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<style>@page{size:${widthMm}mm ${heightMm}mm;margin:0}` +
    `html,body{margin:0;padding:0;width:${widthMm}mm;height:${heightMm}mm;overflow:hidden}` +
    `#${LABEL_ID}{position:relative;box-sizing:border-box;width:${widthMm}mm;height:${heightMm}mm;overflow:hidden}</style>` +
    `</head><body><div id="${LABEL_ID}">${html}</div></body></html>`;
  return `data:text/html;charset=utf-8;base64,${Buffer.from(document, "utf8").toString("base64")}`;
}

class HaccpPrinter {
  constructor({ app, BrowserWindow, getWindow, fs = nodeFs, timeoutMs = PRINT_TIMEOUT_MS }) {
    Object.assign(this, { app, BrowserWindow, getWindow, fs, timeoutMs });
    this.busy = false;
  }

  file(name) {
    return path.join(this.app.getPath("userData"), name);
  }

  async readJson(name) {
    let raw;
    try {
      raw = await this.fs.readFile(this.file(name), "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Fichier ${name} illisible : corrigez-le ou supprimez-le manuellement.`);
    }
  }

  async writeJsonAtomic(name, value) {
    const target = this.file(name);
    await this.fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await this.fs.open(temp, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fs.rename(temp, target);
    } catch (error) {
      await this.fs.unlink(temp).catch((cleanupError) => {
        if (cleanupError?.code !== "ENOENT") error.message += ` (fichier temporaire non supprimé : ${cleanupError.message})`;
      });
      throw error;
    }
  }

  async getConfig() {
    const stored = await this.readJson(CONFIG_FILE);
    if (stored === null) return null;
    try {
      return validateConfig(stored);
    } catch (error) {
      throw new Error(`Configuration d'imprimante HACCP enregistrée invalide : ${error.message}`);
    }
  }

  async listPrinters() {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) throw new Error("Fenêtre SIRIUS indisponible pour lister les imprimantes.");
    const printers = await win.webContents.getPrintersAsync();
    if (!Array.isArray(printers)) throw new Error("Liste des imprimantes Windows indisponible.");
    return printers
      .filter((printer) => printer && typeof printer.name === "string" && printer.name)
      .map((printer) => ({
        name: printer.name,
        displayName: typeof printer.displayName === "string" && printer.displayName ? printer.displayName : printer.name,
        description: typeof printer.description === "string" ? printer.description : "",
        isDefault: printer.isDefault === true,
      }));
  }

  async assertPrinterExists(deviceName) {
    const printers = await this.listPrinters();
    if (!printers.some((printer) => printer.name === deviceName)) {
      throw new Error(`Imprimante « ${deviceName} » introuvable sur ce poste.`);
    }
  }

  async exclusive(action) {
    if (this.busy) throw new Error("Une opération d'impression HACCP est déjà en cours.");
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }

  configure(config) {
    const next = validateConfig(config);
    return this.exclusive(async () => {
      if (next.enabled) await this.assertPrinterExists(next.deviceName);
      await this.writeJsonAtomic(CONFIG_FILE, next);
      return { ...next };
    });
  }

  async readJournal() {
    const stored = await this.readJson(JOURNAL_FILE);
    if (stored === null) return { version: 1, jobs: {} };
    if (!stored || stored.version !== 1 || !stored.jobs || typeof stored.jobs !== "object" || Array.isArray(stored.jobs)) {
      throw new Error("Journal d'impression HACCP invalide : impression bloquée pour éviter un doublon.");
    }
    let recovered = false;
    for (const entry of Object.values(stored.jobs)) {
      if (entry && entry.state === "submitted") {
        Object.assign(entry, { state: "uncertain", updatedAt: new Date().toISOString(),
          error: "Application interrompue pendant l'impression." });
        recovered = true;
      }
    }
    if (recovered) await this.writeJsonAtomic(JOURNAL_FILE, stored);
    return stored;
  }

  async markJob(journal, id, state, error) {
    Object.assign(journal.jobs[id], { state, updatedAt: new Date().toISOString() }, error ? { error } : {});
    await this.writeJsonAtomic(JOURNAL_FILE, journal);
  }

  printJob(job) {
    const request = validateJob(job);
    return this.exclusive(async () => {
      const config = await this.getConfig();
      if (!config || !config.enabled) throw new Error("Imprimante HACCP non configurée ou désactivée.");
      if (request.widthMm !== config.widthMm || request.heightMm !== config.heightMm) {
        throw new Error(
          `Format d'étiquette ${request.widthMm}×${request.heightMm} mm différent de la configuration ` +
          `${config.widthMm}×${config.heightMm} mm.`
        );
      }
      await this.assertPrinterExists(config.deviceName);
      const journal = await this.readJournal();
      const previous = journal.jobs[request.id];
      if (previous) {
        throw new Error(`Travail d'impression ${request.id} déjà soumis (état : ${previous.state}) ; aucune réimpression automatique.`);
      }
      const now = new Date().toISOString();
      journal.jobs[request.id] = {
        state: "submitted", submittedAt: now, updatedAt: now,
        deviceName: config.deviceName, widthMm: config.widthMm, heightMm: config.heightMm,
      };
      await this.writeJsonAtomic(JOURNAL_FILE, journal);

      try {
        await this.spool(request, config);
      } catch (error) {
        await this.markJob(journal, request.id, "uncertain", error.message);
        throw error;
      }
      try {
        await this.markJob(journal, request.id, "accepted");
      } catch (error) {
        throw new Error(
          `Impression acceptée par Windows, mais journal non mis à jour (${error.message}). ` +
          "Vérifiez l'étiquette avant toute nouvelle impression."
        );
      }
      return { accepted: true, id: request.id };
    });
  }

  spool(request, config) {
    const dataUrl = buildPrintDocument(request);
    const widthPx = Math.ceil(mmToPx(request.widthMm));
    const heightPx = Math.ceil(mmToPx(request.heightMm));
    const win = new this.BrowserWindow({
      show: false,
      frame: false,
      useContentSize: true,
      width: widthPx,
      height: heightPx,
      webPreferences: {
        partition: PRINT_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        // Requis par executeJavaScript (mesure) ; les scripts de la page restent bloqués par la CSP script-src 'none'.
        javascript: true,
        webSecurity: true,
        webviewTag: false,
        plugins: false,
        devTools: false,
        spellcheck: false,
        navigateOnDragDrop: false,
      },
    });
    const contents = win.webContents;
    const printSession = contents.session;
    printSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    printSession.setPermissionCheckHandler(() => false);
    printSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== dataUrl }));
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const block = (event) => event.preventDefault();
    contents.on("will-navigate", block);
    contents.on("will-redirect", block);
    contents.on("will-attach-webview", block);

    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        `Délai d'impression dépassé (${Math.round(this.timeoutMs / 1000)} s) : résultat incertain, aucune nouvelle tentative automatique.`
      )), this.timeoutMs);
    });
    const work = (async () => {
      await win.loadURL(dataUrl);
      win.setContentSize(widthPx, heightPx);
      checkMeasurement(await contents.executeJavaScript(MEASURE_SCRIPT, false), request);
      await new Promise((resolve, reject) => {
        contents.print({
          silent: true,
          printBackground: true,
          deviceName: config.deviceName,
          pageSize: { width: Math.round(config.widthMm * 1000), height: Math.round(config.heightMm * 1000) },
          margins: { marginType: "none" },
        }, (success, failureReason) => {
          if (success) resolve();
          else reject(new Error(`Impression refusée par Windows : ${failureReason || "raison inconnue"}.`));
        });
      });
    })();
    return Promise.race([work, timeout]).finally(() => {
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
    });
  }
}

function installHaccpPrinter({ ipcMain, app, BrowserWindow, getWindow, origin, fs, timeoutMs }) {
  const printer = new HaccpPrinter({ app, BrowserWindow, getWindow, fs, timeoutMs });
  const actions = {
    [CHANNELS.getConfig]: () => printer.getConfig(),
    [CHANNELS.listPrinters]: () => printer.listPrinters(),
    [CHANNELS.configure]: (config) => printer.configure(config),
    [CHANNELS.printJob]: (job) => printer.printJob(job),
  };
  for (const [channel, action] of Object.entries(actions)) {
    ipcMain.handle(channel, async (event, ...args) => {
      const win = getWindow();
      let senderOrigin = null;
      try {
        senderOrigin = new URL(event?.senderFrame?.url).origin;
      } catch {
        senderOrigin = null;
      }
      if (!win || win.isDestroyed() || event.sender !== win.webContents || !event.senderFrame ||
          event.senderFrame !== win.webContents.mainFrame || senderOrigin !== origin()) {
        throw new Error("Accès à l'imprimante HACCP refusé.");
      }
      if (args.length > 1) throw new Error("Arguments d'impression HACCP inattendus.");
      return action(...args);
    });
  }
  return printer;
}

module.exports = {
  CHANNELS, CONFIG_FILE, JOURNAL_FILE, MAX_HTML_LENGTH, PRINT_TIMEOUT_MS, MEASURE_SCRIPT, CSP,
  HaccpPrinter, installHaccpPrinter, buildPrintDocument, validateConfig, validateJob,
};