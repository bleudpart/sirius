const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const MARKER_FILE = "ui-build-fingerprint.txt";

// Reinstalling ΣIRIUS keeps the Chromium profile, whose HTTP cache and service worker could keep
// rendering the previous interface. Clear both once whenever the bundled index.html changes.
async function refreshUiCacheOnBuildChange({ session, indexPath, userDataPath }) {
  let fingerprint;
  try {
    fingerprint = crypto.createHash("sha256").update(await fs.readFile(indexPath)).digest("hex");
  } catch {
    return false;
  }
  const markerPath = path.join(userDataPath, MARKER_FILE);
  const previous = await fs.readFile(markerPath, "utf8").catch(() => "");
  if (previous.trim() === fingerprint) return false;

  await session.clearCache();
  await session.clearStorageData({ storages: ["serviceworkers", "cachestorage"] });
  await fs.writeFile(markerPath, fingerprint, "utf8");
  return true;
}

module.exports = { refreshUiCacheOnBuildChange, MARKER_FILE };
