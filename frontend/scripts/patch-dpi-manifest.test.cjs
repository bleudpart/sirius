const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { NtExecutable, NtExecutableResource } = require("resedit");
const patchDpiManifest = require("./patch-dpi-manifest.cjs");
const { patchManifestText } = patchDpiManifest;

const manifest = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"
>
  <asmv3:application xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
    <asmv3:windowsSettings xmlns="http://schemas.microsoft.com/SMI/2011/WindowsSettings">
      <disableWindowFiltering xmlns="http://schemas.microsoft.com/SMI/2011/WindowsSettings">true</disableWindowFiltering>
    </asmv3:windowsSettings>
    <asmv3:windowsSettings xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">
      <dpiAware>true/pm</dpiAware>
    </asmv3:windowsSettings>
  </asmv3:application>
</assembly>`;

test("configure Per-Monitor V2 sans perdre les autres ressources du manifeste", () => {
  const patched = patchManifestText(manifest);
  assert.match(patched, /<dpiAware xmlns="http:\/\/schemas\.microsoft\.com\/SMI\/2005\/WindowsSettings">true\/pm<\/dpiAware>/);
  assert.match(patched, /<dpiAwareness xmlns="http:\/\/schemas\.microsoft\.com\/SMI\/2016\/WindowsSettings">PerMonitorV2<\/dpiAwareness>/);
  assert.match(patched, /<disableWindowFiltering xmlns="http:\/\/schemas\.microsoft\.com\/SMI\/2011\/WindowsSettings">true<\/disableWindowFiltering>/);
  assert.match(patched, /manifestVersion="1\.0"/);
  assert.equal((patched.match(/asmv3:application/g) || []).length, 2);
  assert.equal((patched.match(/<asmv3:windowsSettings\b/g) || []).length, 1);
  assert.equal((patched.match(/<dpiAware\b/g) || []).length, 1);
  assert.equal((patched.match(/<dpiAwareness\b/g) || []).length, 1);
  assert.equal(patchManifestText(patched), patched);
});

test("ajoute le manifeste DPI à l’exécutable avant la signature", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sirius-dpi-manifest-"));
  const executablePath = path.join(directory, "SIRIUS.exe");
  try {
    const executable = NtExecutable.createEmpty(false, false);
    const resources = NtExecutableResource.from(executable);
    resources.replaceResourceEntryFromString(24, 1, 1033, manifest);
    resources.outputResource(executable);
    fs.writeFileSync(executablePath, Buffer.from(executable.generate()));

    patchDpiManifest({
      electronPlatformName: "win32",
      appOutDir: directory,
      packager: { appInfo: { productFilename: "SIRIUS" } },
    });

    const patchedExecutable = NtExecutable.from(fs.readFileSync(executablePath));
    const patchedManifest = NtExecutableResource.from(patchedExecutable)
      .getResourceEntriesAsString(24, 1)[0][1];
    assert.match(patchedManifest, /PerMonitorV2/);
    assert.match(patchedManifest, /true\/pm/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("ne modifie pas les exécutables des autres plateformes", () => {
  assert.doesNotThrow(() => patchDpiManifest({ electronPlatformName: "darwin" }));
});
