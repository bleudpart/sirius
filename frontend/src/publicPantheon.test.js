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

test("storefront and public password page use the dark HUD palette", () => {
  const storeSkin = rule(".public-store");
  expect(value(storeSkin, "--store-paper")).toBe("#010307");
  expect(value(storeSkin, "--store-panel")).toBe("#030405");
  expect(value(storeSkin, "--store-surface")).toBe("linear-gradient(160deg, #040506, #010101)");
  expect(value(storeSkin, "--store-line")).toBe("rgba(145, 230, 242, .24)");

  const accountStyles = postcss.parse(read("PublicAccount.css"));
  const account = accountStyles.nodes.find(node => node.type === "rule" && node.selector === ".public-account");
  const passwordInput = accountStyles.nodes.find(node => node.type === "rule" && node.selector === ".public-account .auth-form input");
  expect(value(account, "background")).toContain("#010307");
  expect(value(passwordInput, "border-radius")).toBe("10px");
  expect(value(passwordInput, "background")).toBe("#010307");
});

test("the HUD storefront overrides its legacy heading and button styles", () => {
  const theme = postcss.parse(read("pantheonTheme.css"));
  const hero = theme.nodes.find(node => node.type === "rule" && node.selector.includes(".public-store .public-hero h1"));
  const actions = theme.nodes.find(node => node.type === "rule" && node.selector.includes(".public-primary-cta") && node.selector.includes(".public-nav-cta"));
  expect(value(hero, "color")).toBe("var(--store-text)");
  expect(value(hero, "font")).toContain("var(--store-heading)");
  expect(value(actions, "background")).toContain("#a9eff4");
});
