import fs from "fs";
import path from "path";
import postcss from "postcss";

const read = name => fs.readFileSync(path.join(__dirname, name), "utf8");
const root = postcss.parse(read("publicPantheon.css"));
const rule = selector => root.nodes.find(node => node.type === "rule" && node.selector === selector);
const value = (node, prop) => node.nodes.find(decl => decl.prop === prop)?.value;

test("store and legal pages load the shared skin after their legacy styles", () => {
  for (const name of ["PublicStore", "PublicLegal"]) {
    const source = read(`${name}.jsx`);
    expect(source.indexOf('import "./publicPantheon.css"')).toBeGreaterThan(source.indexOf(`import "./${name}.css"`));
  }
  const theme = root.nodes[0];
  expect(value(theme, "--store-gold")).toBe("#c5a059");
  expect(value(theme, "--store-lime")).toBe("#c5a059");
});

test("store modal retains a visible 44 pixel close button and a scrollable body", () => {
  const close = rule(".public-store .public-odysseia-close");
  expect(value(close, "width")).toBe("44px");
  expect(value(close, "height")).toBe("44px");
  expect(value(rule(".public-store .public-odysseia-content"), "min-height")).toBe("0");
  expect(value(rule(".public-store .public-odysseia-dialog"), "max-height")).toBe("calc(100dvh - 48px)");
});

test("public portraits preserve the full image and responsive four-to-five proportions", () => {
  const portraits = rule(".public-store :is(.public-odysseia-card img, .public-odysseia-content > img)");
  expect(value(portraits, "width")).toBe("128px");
  expect(value(portraits, "height")).toBe("160px");
  expect(value(portraits, "object-fit")).toBe("contain");
  const mobile = root.nodes.find(node => node.type === "atrule" && node.params === "(max-width: 700px)");
  const small = mobile.nodes.find(node => node.selector?.includes(".public-odysseia-content > img"));
  expect(value(small, "width")).toBe("96px");
  expect(value(small, "height")).toBe("120px");
});
