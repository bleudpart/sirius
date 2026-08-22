let mediaHudWindow = null;

function withMediaHudQuery(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}mediaHud=1`;
}

function createMediaHudWindow({ BrowserWindow, screen, baseUrl, icon, openExternal, preload }) {
  if (mediaHudWindow && !mediaHudWindow.isDestroyed()) {
    mediaHudWindow.show();
    mediaHudWindow.focus();
    return mediaHudWindow;
  }

  const { width } = screen.getPrimaryDisplay().workAreaSize;
  mediaHudWindow = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 520,
    minHeight: 440,
    x: Math.max(20, Math.round((width - 760) / 2)),
    y: 110,
    title: "SIRIUS MEDIA",
    backgroundColor: "#03121f",
    autoHideMenuBar: true,
    alwaysOnTop: true,
    icon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload,
    },
  });
  mediaHudWindow.setAlwaysOnTop(true, "floating");
  mediaHudWindow.loadURL(withMediaHudQuery(baseUrl()));
  mediaHudWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url).catch((error) => {
      console.error("Impossible d'ouvrir le lien multimedia externe.", error);
    });
    return { action: "deny" };
  });
  mediaHudWindow.on("closed", () => {
    mediaHudWindow = null;
  });
  return mediaHudWindow;
}

function toggleMediaHudWindow(options) {
  if (mediaHudWindow && !mediaHudWindow.isDestroyed()) {
    mediaHudWindow.close();
    return null;
  }
  return createMediaHudWindow(options);
}

function closeMediaHudWindow() {
  if (!mediaHudWindow || mediaHudWindow.isDestroyed()) return false;
  mediaHudWindow.close();
  return true;
}

function getMediaHudWindow() {
  return mediaHudWindow && !mediaHudWindow.isDestroyed() ? mediaHudWindow : null;
}

function sendMediaCommand(command, fallbackWindow) {
  const target = getMediaHudWindow() || fallbackWindow;
  if (!target || target.isDestroyed()) return false;
  target.webContents.send("sirius-media-command", command);
  return true;
}

module.exports = {
  closeMediaHudWindow,
  createMediaHudWindow,
  getMediaHudWindow,
  sendMediaCommand,
  toggleMediaHudWindow,
};
