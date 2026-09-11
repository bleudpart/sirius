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
}

console.log(`${packageJson.version} -> ${newVersion}`);
