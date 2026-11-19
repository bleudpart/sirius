const fs = require("node:fs");
const path = require("node:path");
const { NtExecutable, NtExecutableResource } = require("resedit");

const DPI_AWARE_NAMESPACE = "http://schemas.microsoft.com/SMI/2005/WindowsSettings";
const DPI_AWARENESS_NAMESPACE = "http://schemas.microsoft.com/SMI/2016/WindowsSettings";
const ASM_V3_NAMESPACE = "urn:schemas-microsoft-com:asm.v3";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function upsertSetting(xml, name, namespace, value) {
  const pattern = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}\\s*>|<${name}\\b([^>]*)\\/>`, "i");
  const match = xml.match(pattern);
  const attributes = (match ? match[1] || match[3] : "")
    .replace(/\s+xmlns\s*=\s*(["']).*?\1/i, "");
  const element = `<${name}${attributes} xmlns="${namespace}">${value}</${name}>`;
  return match ? xml.replace(pattern, element) : `${xml}${element}`;
}

function removeSettings(xml, name) {
  const pattern = new RegExp(
    `<((?:[\\w.-]+:)?)${name}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/\\1${name}\\s*>)`,
    "gi",
  );
  return xml.replace(pattern, "");
}

function patchManifestText(xml) {
  if (!/<assembly\b[^>]*>/i.test(xml) || !/<\/assembly\s*>/i.test(xml)) {
    throw new Error("Manifeste Windows invalide : racine assembly introuvable.");
  }

  const root = xml.match(/<assembly\b([^>]*)>/i)[1];
  const namespace = root.match(new RegExp(`\\sxmlns:([\\w.-]+)\\s*=\\s*(["'])${escapeRegExp(ASM_V3_NAMESPACE)}\\2`, "i"));
  const prefix = namespace ? namespace[1] : "asmv3";
  const applicationTag = `${prefix}:application`;
  const settingsTag = `${prefix}:windowsSettings`;
  const applicationPattern = new RegExp(
    `<${escapeRegExp(applicationTag)}\\b([^>]*)>([\\s\\S]*?)<\\/${escapeRegExp(applicationTag)}\\s*>`,
    "i",
  );
  const applicationMatch = xml.match(applicationPattern);
  const applicationAttributes = applicationMatch ? applicationMatch[1] : ` xmlns:${prefix}="${ASM_V3_NAMESPACE}"`;
  let applicationContent = applicationMatch ? applicationMatch[2] : "";
  const settingsPattern = new RegExp(
    `<${escapeRegExp(settingsTag)}\\b([^>]*)>([\\s\\S]*?)<\\/${escapeRegExp(settingsTag)}\\s*>`,
    "gi",
  );
  let settingsCount = 0;
  applicationContent = applicationContent.replace(settingsPattern, (_match, attributes, content) => {
    let settingsContent = removeSettings(content, "dpiAware");
    settingsContent = removeSettings(settingsContent, "dpiAwareness");
    if (settingsCount++ === 0) {
      settingsContent = upsertSetting(settingsContent, "dpiAware", DPI_AWARE_NAMESPACE, "true/pm");
      settingsContent = upsertSetting(settingsContent, "dpiAwareness", DPI_AWARENESS_NAMESPACE, "PerMonitorV2");
    }
    if (!settingsContent.trim()) return "";
    return `<${settingsTag}${attributes}>${settingsContent}</${settingsTag}>`;
  });
  if (!settingsCount) {
    let settingsContent = upsertSetting("", "dpiAware", DPI_AWARE_NAMESPACE, "true/pm");
    settingsContent = upsertSetting(settingsContent, "dpiAwareness", DPI_AWARENESS_NAMESPACE, "PerMonitorV2");
    applicationContent += `<${settingsTag}>${settingsContent}</${settingsTag}>`;
  }
  const application = `<${applicationTag}${applicationAttributes}>${applicationContent}</${applicationTag}>`;

  const patched = applicationMatch
    ? xml.replace(applicationPattern, application)
    : xml.replace(/<\/assembly\s*>/i, `${application}</assembly>`);
  return patched;
}

function patchDpiManifest(context) {
  if (context.electronPlatformName !== "win32") return;
  const executableName = context.packager.appInfo.productFilename;
  const executablePath = path.join(context.appOutDir, `${executableName}.exe`);
  const executable = NtExecutable.from(fs.readFileSync(executablePath), { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const manifests = resources.getResourceEntriesAsString(24, 1);
  if (!manifests.length) {
    throw new Error(`Manifeste Windows introuvable dans ${executablePath}.`);
  }
  for (const [language, xml] of manifests) {
    resources.replaceResourceEntryFromString(24, 1, language, patchManifestText(xml));
  }
  resources.outputResource(executable);
  fs.writeFileSync(executablePath, Buffer.from(executable.generate()));
}

module.exports = patchDpiManifest;
module.exports.patchManifestText = patchManifestText;
