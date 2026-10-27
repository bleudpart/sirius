const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("siriusNative", {
  begin: () => ipcRenderer.invoke("sirius-native-begin"),
  configure: (token, options) => ipcRenderer.invoke("sirius-native-configure", token, options),
  chooseFolder: (token) => ipcRenderer.invoke("sirius-native-folder", token),
  unwatch: (token) => ipcRenderer.invoke("sirius-native-unwatch", token),
  stop: (token) => ipcRenderer.invoke("sirius-native-stop", token),
  onEvent: (callback) => {
    if (typeof callback !== "function") throw new TypeError("Gestionnaire natif invalide.");
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("sirius-native-event", listener);
    return () => ipcRenderer.removeListener("sirius-native-event", listener);
  },
});

contextBridge.exposeInMainWorld("siriusMedia", {
  closeHud: () => ipcRenderer.invoke("sirius-media-close-hud"),
  toggleHud: () => ipcRenderer.invoke("sirius-media-toggle-hud"),
  onCommand: (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("Le gestionnaire multimedia doit etre une fonction.");
    }
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("sirius-media-command", listener);
    return () => ipcRenderer.removeListener("sirius-media-command", listener);
  },
});

contextBridge.exposeInMainWorld("siriusUpdates", {
  check: () => ipcRenderer.invoke("sirius-update-check"),
  status: () => ipcRenderer.invoke("sirius-update-status"),
});

contextBridge.exposeInMainWorld("siriusFiles", {
  selectFolder: () => ipcRenderer.invoke("sirius-files-select-folder"),
  openFolder: (folderPath) => ipcRenderer.invoke("sirius-files-open-folder", folderPath),
});

contextBridge.exposeInMainWorld("siriusDesktop", {
  captureInterface: (region) => ipcRenderer.invoke("sirius-capture-interface", region),
  captureScreen: () => ipcRenderer.invoke("sirius-capture-screen"),
  openCaptureFolder: () => ipcRenderer.invoke("sirius-open-capture-folder"),
  toggleFullscreen: () => ipcRenderer.invoke("sirius-window-toggle-fullscreen"),
  isFullscreen: () => ipcRenderer.invoke("sirius-window-is-fullscreen"),
});

contextBridge.exposeInMainWorld("siriusHaccpPrinter", {
  getConfig: () => ipcRenderer.invoke("sirius-haccp-printer-get-config"),
  listPrinters: () => ipcRenderer.invoke("sirius-haccp-printer-list"),
  configure: (config) => ipcRenderer.invoke("sirius-haccp-printer-configure", config),
  printJob: (job) => ipcRenderer.invoke("sirius-haccp-printer-print", job),
});
