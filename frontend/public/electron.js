// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
const { app, BrowserWindow, session, shell, Menu, globalShortcut, ipcMain } = require("electron");
const path = require("path");

// SIRIUS — Application de bureau Windows (Electron)
// Charge le HUD React compilé (dossier build) et accorde l'accès au micro.

const isDev = !app.isPackaged;
let mainWindow = null;
let overlayWindow = null;

function baseUrl() {
  return isDev ? "http://localhost:3000" : "file://" + path.join(__dirname, "..", "build", "index.html");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#000000",
    title: "SIRIUS",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Autorise l'accès aux ressources locales (ws://localhost:8765)
      webSecurity: true,
    },
  });

  // Accorde automatiquement l'accès au microphone (reconnaissance vocale)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "media" || permission === "microphone" || permission === "audioCapture") {
      callback(true);
    } else {
      callback(true);
    }
  });

  // Démarre en plein écran immersif pour l'effet HUD
  mainWindow.maximize();

  if (isDev) {
    mainWindow.loadURL("http://localhost:3000");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "build", "index.html"));
  }

  // Ouvre les liens externes dans le navigateur par défaut
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
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

app.whenReady().then(() => {
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
  // L'overlay demande sa propre fermeture (touche Échap ou commande envoyée)
  ipcMain.on("sirius-close-overlay", () => {
    if (overlayWindow) { overlayWindow.close(); overlayWindow = null; }
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
});
