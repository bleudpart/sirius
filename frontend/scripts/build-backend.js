const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..", "..");
const frontend = path.resolve(__dirname, "..");
const candidates = process.platform === "win32"
  ? [path.join(root, ".venv", "Scripts", "python.exe"), "python"]
  : [path.join(root, ".venv", "bin", "python"), "python3", "python"];
const python = candidates.find((candidate) => candidate.includes(path.sep) ? fs.existsSync(candidate) : true);
if (!python) {
  console.error("Aucun interpréteur Python disponible pour le backend.");
  process.exit(1);
}

const args = [
  "-m", "PyInstaller", "--noconfirm", "--clean",
  "--distpath", "../backend/dist",
  "--workpath", "../backend/build/desktop-sidecar",
  "../backend/sirius-backend.spec",
];
const build = spawnSync(python, args, { cwd: frontend, stdio: "inherit" });
if (build.error || build.status !== 0) process.exit(build.status || 1);

const verify = spawnSync(python, ["../scripts/verify_packaged_frontend.py"], { cwd: frontend, stdio: "inherit" });
process.exit(verify.status || 0);
