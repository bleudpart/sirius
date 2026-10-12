const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

const LANGUAGE_SHA256 = "1c0916fac2dbd6f121ca8a57a92f08e4a119227602c7c984da986222eab6cd3b";

function validateLanguage(data) {
  if (createHash("sha256").update(data).digest("hex") !== LANGUAGE_SHA256) {
    throw new Error("Le modèle OCR français ne correspond pas au modèle vérifié.");
  }
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
  const language = path.join(target, "fra.traineddata.gz");
  try {
    await fs.access(language);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch("https://tessdata.projectnaptha.com/4.0.0/fra.traineddata.gz");
    if (!response.ok) throw new Error(`Modèle OCR français indisponible (HTTP ${response.status}).`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length < 1000 || data[0] !== 0x1f || data[1] !== 0x8b) {
      throw new Error("Modèle OCR français invalide.");
    }
    validateLanguage(data);
    await fs.writeFile(`${language}.tmp`, data);
    await fs.rename(`${language}.tmp`, language);
  }
  validateLanguage(await fs.readFile(language));
  console.log("OCR français préparé : moteur et modèle servis localement.");
}

prepare().catch((error) => { console.error(error); process.exitCode = 1; });
