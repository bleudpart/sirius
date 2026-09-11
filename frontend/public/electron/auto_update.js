// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
// Mises à jour automatiques via GitHub Releases (electron-updater).
// Silencieux et jamais bloquant : vérification au démarrage puis toutes les 4 h,
// téléchargement en arrière-plan, l'utilisateur choisit quand redémarrer.

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function setupAutoUpdater({ app, dialog }) {
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (error) {
    console.warn("electron-updater indisponible :", error.message);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // installée à la fermeture si l'utilisateur refuse le redémarrage

  autoUpdater.on("error", (error) => {
    // Hors-ligne ou release absente : silencieux, on réessaiera au prochain cycle.
    console.warn("[UPDATE] vérification impossible :", error == null ? "?" : error.message);
  });

  autoUpdater.on("update-available", (info) => {
    console.log(`[UPDATE] nouvelle version détectée : ${info.version} (téléchargement en cours)`);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "SIRIUS — mise à jour prête",
      message: `La version ${info.version} de SIRIUS est téléchargée.`,
      detail: "Redémarrer maintenant pour l'installer ? Sinon elle s'installera à la prochaine fermeture.",
      buttons: ["Redémarrer maintenant", "Plus tard"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch(() => {
      /* déjà couvert par l'événement error */
    });
  };

  // Première vérification différée : ne jamais ralentir le démarrage du HUD.
  setTimeout(check, 15 * 1000);
  const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  app.on("will-quit", () => clearInterval(timer));
}

module.exports = { setupAutoUpdater };
