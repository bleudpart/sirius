// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
// Mises à jour automatiques via GitHub Releases (electron-updater).
// Silencieux et jamais bloquant : vérification au démarrage puis toutes les 4 h,
// téléchargement en arrière-plan, l'utilisateur choisit quand redémarrer.

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function setupAutoUpdater({ app, dialog, ipcMain }) {
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (error) {
    console.warn("electron-updater indisponible :", error.message);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // installée automatiquement à la fermeture

  autoUpdater.on("error", (error) => {
    // Hors-ligne ou release absente : silencieux, on réessaiera au prochain cycle.
    console.warn("[UPDATE] vérification impossible :", error == null ? "?" : error.message);
  });

  autoUpdater.on("update-available", (info) => {
    console.log(`[UPDATE] nouvelle version détectée : ${info.version} (téléchargement en cours)`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    // Aucun clic demandé : l'installation se fera à la prochaine fermeture.
    console.log(`[UPDATE] version ${info.version} prête, installation automatique à la fermeture`);
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch(() => {
      /* déjà couvert par l'événement error */
    });
  };

  ipcMain.handle("sirius-update-check", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, available: Boolean(result?.updateInfo && result.updateInfo.version !== app.getVersion()) };
    } catch (error) {
      return { ok: false, message: error?.message || "Vérification impossible." };
    }
  });

  // Première vérification différée : ne jamais ralentir le démarrage du HUD.
  setTimeout(check, 15 * 1000);
  const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  app.on("will-quit", () => clearInterval(timer));
}

module.exports = { setupAutoUpdater };
