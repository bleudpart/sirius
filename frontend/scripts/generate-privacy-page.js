const fs = require("fs");
const path = require("path");
const policy = require("../src/privacyPolicy.json");

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function renderPrivacyPage(data) {
  const sections = data.sections.map(([heading, text]) =>
    `<section><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(text)}</p></section>`
  ).join("\n");
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Politique de confidentialité de ΣIRIUS et coordonnées du responsable du traitement.">
<title>${escapeHtml(data.title)}</title>
<style>
body{margin:0;background:#051320;color:#e7eff5;font:17px/1.65 system-ui,sans-serif}
main{max-width:820px;margin:auto;padding:32px 24px 64px}
a{color:#eecb6d}h1{font-size:clamp(28px,5vw,42px);line-height:1.2;color:#eecb6d}
h2{font-size:22px;color:#eecb6d}section{padding:16px 0;border-top:1px solid #284252}
p{overflow-wrap:anywhere}footer{margin-top:28px;color:#aec2cf}
</style>
</head>
<body><main>
<nav><a href="/">ΣIRIUS — Retour au site</a></nav>
<h1>${escapeHtml(data.title)}</h1>
${sections}
<footer>Dernière mise à jour : ${escapeHtml(data.updated)}.<br>
<a href="mailto:danielsirius.pro2026@gmail.com">Contacter le responsable</a></footer>
</main></body></html>
`;
}

if (require.main === module) {
  const output = path.join(__dirname, "../public/confidentialite.html");
  fs.writeFileSync(output, renderPrivacyPage(policy), "utf8");
  console.log(`Politique HTML generee : ${output}`);
}

module.exports = { escapeHtml, renderPrivacyPage };
