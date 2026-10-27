import fs from "fs";
import path from "path";
import vm from "vm";

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const script = html.match(/<script id="haccp-asset-base">([\s\S]*?)<\/script>/)[1];

function assetBase(url) {
  const location = new URL(url);
  const elements = [];
  vm.runInNewContext(script, {
    window: { location },
    document: {
      createElement: (tag) => ({ tag }),
      head: { appendChild: (element) => elements.push(element) },
    },
  });
  return { elements, url: new URL(elements[0]?.href || ".", url) };
}

test.each(["/haccp", "/haccp/"])("capture assets resolve at the root for %s", (pathname) => {
  const base = assetBase(`https://sirius-assistant.fr${pathname}?test=1`).url;
  expect(new URL("./static/js/main.js", base).pathname).toBe("/static/js/main.js");
  expect(new URL("./manifest.json", base).pathname).toBe("/manifest.json");
});

test.each([
  "https://sirius-assistant.fr/",
  "https://sirius-assistant.fr/acheter",
  "file:///C:/sirius/index.html",
  "file:///haccp/",
])("other entry points keep their original asset base: %s", (url) => {
  expect(assetBase(url).elements).toEqual([]);
});

test("the base is set before any relative resources are requested", () => {
  expect(html.indexOf('id="haccp-asset-base"')).toBeLessThan(html.indexOf("<link"));
});

test("the public server redirects the trailing slash before loading relative assets", () => {
  const caddy = fs.readFileSync(path.join(__dirname, "..", "..", "deploy", "hetzner", "Caddyfile"), "utf8");
  expect(caddy).toMatch(/^\s*redir \/haccp\/ \/haccp 308\s*$/m);
});
