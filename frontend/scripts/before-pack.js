// Verrou d'empaquetage : electron-builder appelle ce hook quelle que soit la façon dont il est
// lancé (npm script, npx, .bat). Il refuse de produire un installateur dont le frontend embarqué
// ne correspond pas aux sources — la cause des installateurs « neufs » livrant une vieille version.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const frontend = path.resolve(__dirname, "..");
const root = path.resolve(frontend, "..");

const pythonCandidates = process.platform === "win32"
  ? [path.join(root, ".venv", "Scripts", "python.exe"), "python"]
  : [path.join(root, ".venv", "bin", "python"), "python3", "python"];

module.exports = async function beforePack() {
  const python = pythonCandidates.find((c) => (c.includes(path.sep) ? fs.existsSync(c) : true));
  if (!python) throw new Error("Aucun interpréteur Python pour vérifier le frontend embarqué.");

  const result = spawnSync(python, [path.join(root, "scripts", "verify_packaged_frontend.py")], {
    cwd: frontend,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      "Empaquetage interrompu : le frontend embarqué est périmé.\n" +
      "Lancez « npm run build » puis « npm run backend:build » avant de packager."
    );
  }
};
