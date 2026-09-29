const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dryRun = process.argv.includes("--dry-run");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!match) {
    throw new Error(`Version semver invalide : ${version}`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

const packageJsonPath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");
const frontendVersionPath = path.join(root, "src", "version.js");
const backendVersionPath = path.join(root, "..", "backend", "version_info.py");
const packageJson = readJson(packageJsonPath);
const newVersion = nextPatch(packageJson.version);

if (!dryRun) {
  packageJson.version = newVersion;
  writeJson(packageJsonPath, packageJson);

  if (fs.existsSync(packageLockPath)) {
    const packageLock = readJson(packageLockPath);
    packageLock.version = newVersion;
    if (packageLock.packages && packageLock.packages[""]) {
      packageLock.packages[""].version = newVersion;
    }
    writeJson(packageLockPath, packageLock);
  }

  for (const file of [frontendVersionPath, backendVersionPath]) {
    let source = fs.readFileSync(file, "utf8");
    source = source.replace(/APP_VERSION\s*=\s*["']([^"']+)["']/, `APP_VERSION = "${newVersion}"`);
    source = source.replace(/APP_RELEASE\s*=\s*["']([^"']+)["']/, `APP_RELEASE = "ΣIRIUS ${newVersion}"`);
    fs.writeFileSync(file, source, "utf8");
  }
}

console.log(`${packageJson.version} -> ${newVersion}`);
