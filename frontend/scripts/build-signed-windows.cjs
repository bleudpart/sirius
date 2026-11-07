const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const signingScript = path.resolve(__dirname, "../../scripts/windows-code-signing.ps1");

function checkEnvironment(env = process.env, platform = process.platform) {
  if (platform !== "win32") throw new Error("La signature Windows exige Windows et son SDK.");
  for (const name of ["SIRIUS_SIGNTOOL_PATH", "SIRIUS_SIGNING_THUMBPRINT", "SIRIUS_SIGNING_PUBLISHER"]) {
    if (!env[name]) throw new Error(`Signature obligatoire : variable ${name} absente.`);
  }
  if (!/^[a-f0-9]{40}$/i.test(env.SIRIUS_SIGNING_THUMBPRINT)) {
    throw new Error("Empreinte du certificat invalide.");
  }
}

function invokeSigning(action, target, env = process.env, run = spawnSync, report, exclude = []) {
  checkEnvironment(env);
  const result = run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", signingScript, "-Action", action, "-TargetPath", target,
    ...(report ? ["-ReportPath", report] : []),
    ...(exclude.length ? ["-Exclude", exclude.join(",")] : []),
  ], { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Signature ${action} echouee : ${target} (code ${result.status}).`);
}

// electron-builder merges these overrides with package.json "build" itself: repeating
// package.json values here would merge "publish" into itself and fail schema validation.
function signedConfig(env = process.env, sign = invokeSigning) {
  checkEnvironment(env);
  return {
    forceCodeSigning: true,
    // The main executable is excluded: electron-builder edits its resources with resedit
    // (which rejects signed PE files) and then signs it through signtoolOptions.sign.
    afterPack: async (context) => sign("Sign", context.appOutDir, env, undefined, undefined,
      [`${context.packager.appInfo.productFilename}.exe`]),
    win: {
      verifyUpdateCodeSignature: true,
      signtoolOptions: {
        signingHashAlgorithms: ["sha256"],
        publisherName: env.SIRIUS_SIGNING_PUBLISHER,
        sign: async (task) => sign("Sign", task.path, env),
      },
    },
  };
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} a echoue (code ${result.status}).`);
}

async function main(args) {
  checkEnvironment();
  if (args.length === 1 && args[0] === "--check") return;
  const publish = args.length === 0 ? "never" :
    args.length === 2 && args[0] === "--publish" && args[1] === "always" ? "always" : null;
  if (!publish) throw new Error("Arguments attendus : --check ou --publish always.");
  const { build, Platform, Arch } = require("electron-builder");
  const manifest = require("../package.json");
  await build({
    projectDir: path.resolve(__dirname, ".."),
    config: signedConfig(),
    targets: Platform.WINDOWS.createTarget(["nsis", "portable"], Arch.x64),
    publish: "never",
  });
  const dist = path.resolve(__dirname, "../dist");
  const report = path.join(dist, "windows-signatures.json");
  invokeSigning("Verify", dist, process.env, spawnSync, report);
  if (publish === "always") {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sirius-signed-release-"));
    const assets = path.join(temporary, "assets");
    try {
      runCommand("python", [
        path.resolve(__dirname, "../../scripts/stage_windows_release.py"),
        "--source", dist, "--destination", assets, "--version", manifest.version, "--report", report,
      ]);
      runCommand("gh", [
        "release", "create", `v${manifest.version}`, "--repo", "bleudpart/sirius",
        "--verify-tag", "--draft", "--generate-notes",
        ...fs.readdirSync(assets).map((name) => path.join(assets, name)),
      ]);
      runCommand("gh", ["release", "edit", `v${manifest.version}`, "--repo", "bleudpart/sirius", "--draft=false"]);
    } finally {
      fs.rmSync(temporary, { recursive: true });
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { checkEnvironment, invokeSigning, signedConfig };
