const nodeFs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const SHORTCUT = "Control+Alt+S";

class NativeAutomation {
  constructor({ globalShortcut, powerMonitor, Notification, dialog, getWindow, home, fs = nodeFs }) {
    Object.assign(this, { globalShortcut, powerMonitor, Notification, dialog, getWindow, home, fs });
    this.token = null;
    this.watcher = null;
    this.notifications = new Set();
    this.listeners = [];
    this.events = [];
    this.options = { shortcut: false, notifications: false, resume: false };
    this.folder = null;
    this.generation = 0;
    this.lastEvents = new Map();
  }

  snapshot() {
    return { ...this.options, folder: this.folder, events: [...this.events], accelerator: SHORTCUT };
  }

  publish() {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("sirius-native-event", this.snapshot());
  }

  record(kind, message, name = null) {
    this.events.unshift({ id: randomUUID(), at: new Date().toISOString(), kind, message, name });
    this.events = this.events.slice(0, 100);
    this.publish();
  }

  focus() {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  }

  notify() {
    if (!this.options.notifications) return;
    const token = this.token;
    const notification = new this.Notification({
      title: "SIRIUS", body: "Un événement attend votre consultation dans les automatisations Windows.",
    });
    this.notifications.add(notification);
    notification.on("click", () => {
      if (token !== this.token) return;
      this.focus(); this.record("review", "Ouvrir les automatisations et consulter les rappels.");
    });
    notification.on("close", () => this.notifications.delete(notification));
    notification.on("failed", () => {
      this.notifications.delete(notification);
      if (token === this.token) this.record("error", "Windows n'a pas pu afficher la notification.");
    });
    notification.show();
  }

  assertToken(token) {
    if (!this.token || token !== this.token) throw new Error("Session d'automatisation expirée. Rouvrez le panneau.");
  }

  begin() {
    this.reset();
    this.token = randomUUID();
    return { token: this.token, state: this.snapshot() };
  }

  configure(token, options) {
    this.assertToken(token);
    const keys = ["shortcut", "notifications", "resume"];
    if (!options || Object.keys(options).length !== keys.length ||
        keys.some((key) => typeof options[key] !== "boolean")) throw new Error("Options d'automatisation invalides.");
    if (options.notifications && !this.Notification.isSupported()) throw new Error("Notifications Windows indisponibles.");
    if (options.shortcut && !this.options.shortcut) {
      const registered = this.globalShortcut.register(SHORTCUT, () => {
        this.focus(); this.record("shortcut", "SIRIUS appelé par Ctrl+Alt+S.");
      });
      if (!registered) throw new Error("Ctrl+Alt+S est déjà utilisé. Le raccourci n'a pas été activé.");
    } else if (!options.shortcut && this.options.shortcut) this.globalShortcut.unregister(SHORTCUT);
    for (const [event, callback] of this.listeners) this.powerMonitor.removeListener(event, callback);
    this.listeners = [];
    this.options = { ...options };
    if (!options.notifications) {
      for (const notification of this.notifications) notification.close();
      this.notifications.clear();
    }
    if (options.resume) {
      let last = 0;
      const wake = () => {
        if (Date.now() - last < 10000) return;
        last = Date.now();
        this.record("resume", "Session reprise : consultez les rappels et tâches en attente.");
        this.notify();
      };
      for (const event of ["resume", "unlock-screen"]) {
        this.powerMonitor.on(event, wake);
        this.listeners.push([event, wake]);
      }
    }
    this.record("settings", "Options Windows mises à jour pour cette session uniquement.");
    return this.snapshot();
  }

  async chooseFolder(token) {
    this.assertToken(token);
    const generation = this.generation;
    const choice = await this.dialog.showOpenDialog(this.getWindow(), {
      title: "Choisir le seul dossier à surveiller (sans sous-dossiers ni lecture des fichiers)",
      properties: ["openDirectory"],
    });
    this.assertToken(token);
    if (choice.canceled || !choice.filePaths[0]) return this.snapshot();
    const folder = await this.fs.promises.realpath(choice.filePaths[0]);
    const stat = await this.fs.promises.stat(folder);
    this.assertToken(token);
    if (generation !== this.generation) throw new Error("Sélection annulée car la surveillance a changé.");
    const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
    if (!stat.isDirectory() || samePath(folder, path.parse(folder).root) || samePath(folder, this.home))
      throw new Error("Choisissez un dossier précis, pas la racine du disque ni tout votre dossier personnel.");
    this.stopWatching();
    this.publish();
    const watcher = this.fs.watch(folder, { recursive: false, persistent: false }, (_event, filename) => {
      if (this.watcher !== watcher || !this.token) return;
      const name = filename ? path.basename(String(filename)).slice(0, 240) : null;
      const now = Date.now();
      if (now - (this.lastEvents.get(name) || 0) < 2000) return;
      this.lastEvents.set(name, now);
      if (this.lastEvents.size > 100) this.lastEvents.delete(this.lastEvents.keys().next().value);
      this.record("folder-change", "Changement détecté ; vérifiez le dossier. Aucun contenu lu ni classé.", name);
      // Avoid a notification storm during bulk copies.
      if (now - (this.lastNotification || 0) >= 10000) { this.lastNotification = now; this.notify(); }
    });
    watcher.on("error", () => {
      if (this.watcher !== watcher) return;
      this.stopWatching();
      this.record("error", "Surveillance interrompue : dossier inaccessible. Choisissez-le de nouveau.");
    });
    this.watcher = watcher;
    this.folder = folder;
    this.record("settings", "Surveillance du dossier choisi activée, sans lecture ni transfert.");
    return this.snapshot();
  }

  stopWatching() {
    this.generation += 1;
    if (this.watcher) this.watcher.close();
    this.watcher = null; this.folder = null;
    this.lastEvents.clear();
  }

  reset() {
    this.token = null;
    this.stopWatching();
    if (this.options.shortcut) this.globalShortcut.unregister(SHORTCUT);
    for (const [event, callback] of this.listeners) this.powerMonitor.removeListener(event, callback);
    this.listeners = [];
    for (const notification of this.notifications) notification.close();
    this.notifications.clear();
    this.options = { shortcut: false, notifications: false, resume: false };
    this.events = []; this.lastNotification = 0;
  }
}

function installNativeAutomation({ ipcMain, manager, getWindow, origin }) {
  const channels = {
    "sirius-native-begin": () => manager.begin(),
    "sirius-native-configure": (token, options) => manager.configure(token, options),
    "sirius-native-folder": (token) => manager.chooseFolder(token),
    "sirius-native-unwatch": (token) => {
      manager.assertToken(token); manager.stopWatching();
      manager.record("settings", "Surveillance du dossier arrêtée.");
      return manager.snapshot();
    },
    "sirius-native-stop": (token) => {
      manager.assertToken(token); manager.reset(); manager.publish();
      return manager.snapshot();
    },
  };
  for (const [channel, action] of Object.entries(channels)) {
    ipcMain.handle(channel, async (event, ...args) => {
      const win = getWindow();
      if (!win || win.isDestroyed() || event.sender !== win.webContents ||
          !event.senderFrame || event.senderFrame !== win.webContents.mainFrame ||
          new URL(event.senderFrame.url).origin !== origin()) throw new Error("Accès natif refusé.");
      return action(...args);
    });
  }
}

module.exports = { NativeAutomation, installNativeAutomation, SHORTCUT };
