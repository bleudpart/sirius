import fs from "fs";
import path from "path";
import postcss from "postcss";

const css = fs.readFileSync(path.join(__dirname, "desktopModuleInteriors.css"), "utf8");
const root = postcss.parse(css);

test("le nouvel habillage reste limite aux grandes vues Windows", () => {
  const media = root.nodes.filter((node) => node.type !== "comment");
  expect(media).toHaveLength(1);
  expect(media[0].name).toBe("media");
  expect(media[0].params).toBe("(min-width: 1024px)");
});

test("les cartes PRIME partagent le style sans coins coupes ni animation", () => {
  const rules = [];
  root.walkRules((rule) => {
    if (rule.selector.includes(".prime-card")) rules.push(rule);
  });
  expect(rules).toHaveLength(1);
  const declarations = Object.fromEntries(rules[0].nodes.map(({ prop, value }) => [prop, value]));
  expect(declarations["clip-path"]).toBe("none");
  expect(declarations["border-radius"]).toBe("14px");
  expect(declarations.animation).toBe("none");
  expect(declarations.border).toBe("1px solid var(--module-line)");
});

test("les cartes ne changent pas la geometrie et les alertes restent distinctes", () => {
  root.walkDecls((decl) => {
    expect(["position", "transform", "width", "height", "display"]).not.toContain(
      decl.parent.selector?.includes(".prime-card") ? decl.prop : ""
    );
  });
  expect(css).toContain(".argus-row:not(.sev-severe):not(.sev-critical)");
  expect(css).not.toMatch(/\.locus-error|\.dev-error|\.kr-msg\.ko|\.heph-row\.fail/);
});
