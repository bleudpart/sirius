const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");

const LANGUAGE_SHA256 = "1c0916fac2dbd6f121ca8a57a92f08e4a119227602c7c984da986222eab6cd3b";

function validateLanguage(data) {
  if (createHash("sha256").update(data).digest("hex") !== LANGUAGE_SHA256) {
    throw new Error("Le modèle OCR français ne correspond pas au modèle vérifié.");
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

async function writeAtomic(file, data) {
  await fs.writeFile(`${file}.tmp`, data);
  await fs.rename(`${file}.tmp`, file);
}

async function prepare() {
  const target = path.join(__dirname, "..", "public", "ocr");
  await fs.mkdir(target, { recursive: true });
  await fs.copyFile(require.resolve("tesseract.js/dist/worker.min.js"), path.join(target, "worker.min.js"));
  const core = path.dirname(require.resolve("tesseract.js-core/package.json"));
  for (const name of await fs.readdir(core)) {
    if (/^tesseract-core.*\.wasm(?:\.js)?$/.test(name)) {
      await fs.copyFile(path.join(core, name), path.join(target, name));
    }
  }
  // Le Microsoft Store (WACK) refuse les archives .gz dans le paquet : le modèle est servi
  // décompressé partout, et seule l'archive vérifiée est gardée en cache hors de public/.
  const cacheDir = path.join(__dirname, "..", "node_modules", ".cache", "sirius-ocr");
  await fs.mkdir(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, "fra.traineddata.gz");
  const legacyArchive = path.join(target, "fra.traineddata.gz");
  if (!(await exists(archive)) && (await exists(legacyArchive))) {
    await fs.copyFile(legacyArchive, archive);
  }
  if (!(await exists(archive))) {
    const response = await fetch("https://tessdata.projectnaptha.com/4.0.0/fra.traineddata.gz");
    if (!response.ok) throw new Error(`Modèle OCR français indisponible (HTTP ${response.status}).`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length < 1000 || data[0] !== 0x1f || data[1] !== 0x8b) {
      throw new Error("Modèle OCR français invalide.");
    }
    validateLanguage(data);
    await writeAtomic(archive, data);
  }
  const compressed = await fs.readFile(archive);
  validateLanguage(compressed);
  const model = gunzipSync(compressed);
  const language = path.join(target, "fra.traineddata");
  const current = (await exists(language)) ? await fs.readFile(language) : null;
  if (!current || !current.equals(model)) await writeAtomic(language, model);
  await fs.rm(legacyArchive, { force: true });
  console.log("OCR français préparé : moteur et modèle servis localement.");
}

prepare().catch((error) => { console.error(error); process.exitCode = 1; });
