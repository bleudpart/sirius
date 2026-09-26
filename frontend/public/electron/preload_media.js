const { contextBridge, ipcRenderer } = require("electron");

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
});

contextBridge.exposeInMainWorld("siriusFiles", {
  selectFolder: () => ipcRenderer.invoke("sirius-files-select-folder"),
  openFolder: (folderPath) => ipcRenderer.invoke("sirius-files-open-folder", folderPath),
});

contextBridge.exposeInMainWorld("siriusDesktop", {
  captureInterface: () => ipcRenderer.invoke("sirius-capture-interface"),
  captureScreen: () => ipcRenderer.invoke("sirius-capture-screen"),
});

