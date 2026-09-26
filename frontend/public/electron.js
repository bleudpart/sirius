// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
const { app, BrowserWindow, session, shell, Menu, globalShortcut, ipcMain, dialog, desktopCapturer } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const {
  closeMediaHudWindow,
  sendMediaCommand,
  toggleMediaHudWindow,
} = require("./electron/hud_windows");
const { startBackend, stopBackend } = require("./electron/backend_process");
const { setupAutoUpdater } = require("./electron/auto_update");

// SIRIUS — Application de bureau Windows (Electron)
// Charge le HUD React compilé (dossier build) et accorde l'accès au micro.

const isDev = !app.isPackaged;
let mainWindow = null;
let overlayWindow = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // Avant, l'application se fermait ici sans aucun message : si une instance restait
  // bloquée en arrière-plan après un redémarrage (processus zombie, fenêtre masquée…),
  // cliquer sur l'icône ne provoquait strictement rien à l'écran — symptôme rapporté
  // comme « ça ne démarre pas ». On affiche désormais un message explicite (utilisable
  // avant même que l'app soit "ready") pour que l'utilisateur sache quoi faire.
  dialog.showErrorBox(
    "SIRIUS — déjà en cours d'exécution",
    "Une autre instance de SIRIUS semble déjà active (peut-être masquée ou bloquée en arrière-plan après un redémarrage).\n\n" +
      "Ouvrez le Gestionnaire des tâches (Ctrl+Maj+Échap), cherchez un processus « SIRIUS » ou « electron.exe », terminez-le, puis relancez l'application."
  );
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
const mediaPreload = path.join(__dirname, "electron", "preload_media.js");

function baseUrl() {
  return isDev ? "http://localhost:3000" : "http://127.0.0.1:8001";
}

function mediaWindowOptions() {
  const { screen } = require("electron");
  return {
    BrowserWindow,
    screen,
    baseUrl,
    icon: path.join(__dirname, "icon.ico"),
    openExternal: shell.openExternal,
    preload: mediaPreload,
  };
}

function toggleMediaHud() {
  return toggleMediaHudWindow(mediaWindowOptions());
}

function sendMediaShortcut(action) {
  sendMediaCommand({ action }, mainWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#061321",
    title: "SIRIUS",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: mediaPreload,
      // Autorise l'accès aux ressources locales (ws://localhost:8765)
      webSecurity: true,
    },
  });

  // Accorde automatiquement l'accès au microphone (reconnaissance vocale)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowedPermissions = new Set([
      "audioCapture",
      "geolocation",
      "media",
      "microphone",
      "notifications",
    ]);
    const requestingUrl = details?.requestingUrl || webContents.getURL();
    let trustedOrigin = false;
    try {
      trustedOrigin = new URL(requestingUrl).origin === new URL(baseUrl()).origin;
    } catch {
      trustedOrigin = false;
    }
    callback(trustedOrigin && allowedPermissions.has(permission));
  });

  // Démarre en plein écran immersif pour l'effet HUD
  mainWindow.maximize();

  mainWindow.loadURL(baseUrl());

  // Ouvre les liens externes dans le navigateur par défaut
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin === new URL(baseUrl()).origin) return;
    } catch {
      // Invalid navigation targets are blocked below.
    }
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Mode Overlay transparent : fenêtre discrète toujours au-dessus (type Spotlight)
function toggleOverlay() {
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
    return;
  }
  const { screen } = require("electron");
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow = new BrowserWindow({
    width: 620,
    height: 200,
    x: Math.round((width - 620) / 2),
    y: 90,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: "#00000000",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  overlayWindow.setAlwaysOnTop(true, "screen-saver"); // par-dessus les jeux plein écran
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const sep = baseUrl().includes("?") ? "&" : "?";
  overlayWindow.loadURL(baseUrl() + sep + "overlay=1");
  overlayWindow.on("blur", () => { if (overlayWindow) { overlayWindow.close(); overlayWindow = null; } });
  overlayWindow.on("closed", () => { overlayWindow = null; });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;

  if (!isDev) {
    try {
      await startBackend({
        resourcesPath: process.resourcesPath,
        userDataPath: app.getPath("userData"),
      });
    } catch (error) {
      dialog.showErrorBox(
        "SIRIUS — démarrage impossible",
        `${error.message}\n\nConsultez backend.log dans ${app.getPath("userData")}.`
      );
      app.quit();
      return;
    }
    // Mises à jour automatiques via GitHub Releases (jamais bloquant).
    setupAutoUpdater({ app, dialog, ipcMain });
  }

  // Active les raccourcis Couper/Copier/Coller/Tout sélectionner (Ctrl+X/C/V/A)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Édition",
        submenu: [
          { role: "undo", label: "Annuler" },
          { role: "redo", label: "Rétablir" },
          { type: "separator" },
          { role: "cut", label: "Couper" },
          { role: "copy", label: "Copier" },
          { role: "paste", label: "Coller" },
          { role: "selectAll", label: "Tout sélectionner" },
        ],
      },
    ])
  );

  createWindow();

  // Raccourci global : Alt+Espace ouvre/ferme l'overlay (barre rapide type Spotlight)
  globalShortcut.register("Alt+Space", toggleOverlay);
  // Le HUD media peut etre ouvert sans quitter l'application principale.
  globalShortcut.register("Alt+Shift+M", toggleMediaHud);
  for (const [accelerator, action] of [
    ["MediaPlayPause", "toggle"],
    ["MediaStop", "stop"],
  ]) {
    if (!globalShortcut.register(accelerator, () => sendMediaShortcut(action))) {
      console.warn(`Raccourci media indisponible : ${accelerator}`);
    }
  }
  // L'overlay demande sa propre fermeture (touche Échap ou commande envoyée)
  ipcMain.on("sirius-close-overlay", () => {
    if (overlayWindow) { overlayWindow.close(); overlayWindow = null; }
  });
  ipcMain.handle("sirius-media-toggle-hud", () => {
    const window = toggleMediaHud();
    return { visible: !!window };
  });
  ipcMain.handle("sirius-media-close-hud", () => ({ closed: closeMediaHudWindow() }));
  ipcMain.handle("sirius-files-select-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choisir un dossier Windows",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { path: result.filePaths[0] };
  });
  ipcMain.handle("sirius-files-open-folder", async (_event, folderPath) => {
    if (typeof folderPath !== "string" || !folderPath.trim()) return { ok: false, error: "Dossier invalide." };
    const error = await shell.openPath(folderPath);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle("sirius-capture-interface", async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: "Fenêtre SIRIUS indisponible." };
    try {
      const image = await mainWindow.webContents.capturePage();
      const captureFolder = path.join(app.getPath("pictures"), "SIRIUS Captures");
      await fs.mkdir(captureFolder, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const capturePath = path.join(captureFolder, `SIRIUS-${timestamp}.png`);
      await fs.writeFile(capturePath, image.toPNG());
      shell.showItemInFolder(capturePath);
      return { ok: true, path: capturePath };
    } catch (error) {
      return { ok: false, error: error.message || "Capture impossible." };
    }
  });
  ipcMain.handle("sirius-capture-screen", async () => {
    try {
      const { width, height } = require("electron").screen.getPrimaryDisplay().size;
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width, height },
      });
      const source = sources[0];
      if (!source?.thumbnail || source.thumbnail.isEmpty()) return { ok: false, error: "Aucun écran disponible." };
      return { ok: true, image: source.thumbnail.toDataURL().split(",", 2)[1] };
    } catch (error) {
      return { ok: false, error: error.message || "Capture impossible." };
    }
  });

  // Menu contextuel (clic droit) avec Copier / Coller
  if (mainWindow) {
    mainWindow.webContents.on("context-menu", (_e, params) => {
      const canEdit = params.isEditable;
      Menu.buildFromTemplate([
        { role: "cut", label: "Couper", enabled: canEdit && !!params.selectionText },
        { role: "copy", label: "Copier", enabled: !!params.selectionText },
        { role: "paste", label: "Coller", enabled: canEdit },
        { type: "separator" },
        { role: "selectAll", label: "Tout sélectionner" },
      ]).popup({ window: mainWindow });
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopBackend();
});
