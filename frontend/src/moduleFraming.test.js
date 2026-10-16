import fs from "fs";
import path from "path";
import postcss from "postcss";

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const declarations = (file, selector, rootOnly = false) => {
  const values = {};
  postcss.parse(read(file)).walkRules((rule) => {
    if (rule.selector === selector && (!rootOnly || rule.parent.type === "root")) {
      rule.walkDecls(({ prop, value }) => { values[prop] = value; });
    }
  });
  return values;
};

test("shared module margins are loaded at startup, not by opening ARGUS first", () => {
  expect(read("App.js")).toContain('import "@/App.css"');
  expect(declarations("App.css", ".argus-body")).toMatchObject({
    padding: "0 22px", "max-width": "1020px", "min-width": "0", "box-sizing": "border-box",
  });
  expect(declarations("Argus.css", ".argus-body")).toEqual({});
  expect(declarations("mobileModulePages.css", ".prime-screen .argus-body")).toMatchObject({
    "padding-inline": "12px", "overflow-wrap": "anywhere",
  });
  for (const module of ["ThemisPanel.jsx", "LocusPanel.jsx", "HeraclesPanel.jsx", "PromoPanel.jsx",
    "PackagerPanel.jsx", "ScriptInstaller.jsx", "TrailerGallery.jsx", "ArgusPanel.jsx"]) {
    expect(read(module)).toContain('className="argus-body');
  }
});

test("narrow promotional and template grids can shrink to their actual container", () => {
  expect(declarations("Promo.css", ".promo-grid", true)["grid-template-columns"])
    .toBe("repeat(auto-fill, minmax(min(100%, 340px), 1fr))");
  expect(declarations("Themis.css", ".th-templates")["grid-template-columns"])
    .toBe("repeat(auto-fit, minmax(min(100%, 240px), 1fr))");
});

test("portrait grid columns never erase the module's own content padding", () => {
  postcss.parse(read("App.css")).walkRules((rule) => {
    if (!rule.selector.includes(":has(>") || !rule.selector.includes("mythos-avatar")) return;
    rule.walkDecls("padding-left", () => {
      throw new Error(`Portrait layout must not reset inner padding: ${rule.selector}`);
    });
  });
});

test("consultation buttons and book covers do not depend on opening unrelated modules", () => {
  for (const selector of [".mg-open", ".mg-speak"]) {
    expect(declarations("App.css", selector).display).toBe("inline-flex");
    expect(declarations("MythosGallery.css", selector)).toEqual({});
  }
  expect(declarations("Calliope.css", ".cal-cover").width).toBe("46px");
  expect(declarations("AgoraPipeline.css", ".cal-cover")).toEqual({});
  for (const file of ["Argus.css", "InstallWizard.css", "MemoryManager.css"]) {
    expect(read("ScriptInstaller.jsx")).toContain(`import "./${file}"`);
  }
});

test("mobile calculations, sales metrics and search controls stay inside their module", () => {
  expect(declarations("mobileModulePages.css", ".prime-screen .cal-tabs")["flex-wrap"]).toBe("wrap");
  expect(declarations("mobileModulePages.css", ".prime-screen .cal-input")["min-width"]).toBe("0");
  expect(declarations("mobileModulePages.css", ".eu-screen .eu-input")["min-width"]).toBe("0");
  expect(declarations("mobileModulePages.css", ".zeus-screen .zeus-bottom")).toMatchObject({
    left: "12px", right: "12px", width: "auto", transform: "none",
  });
  expect(declarations("AgoraPipeline.css", ".ag-stats")["grid-template-columns"])
    .toBe("repeat(auto-fit, minmax(min(100%, 130px), 1fr))");
});

test("THEMIS mobile document lines keep the description above amount and quantity", () => {
  expect(declarations("Themis.css", ".th-input")).toMatchObject({
    "min-width": "0", "box-sizing": "border-box",
  });
  expect(declarations("Themis.css", ".th-line > .th-input:first-child")["grid-column"]).toBe("1 / -1");
  expect(declarations("Themis.css", ".th-line .th-input.th-qty").width).toBe("100%");
  expect(declarations("Themis.css", ".th-table td")["overflow-wrap"]).toBe("anywhere");
  expect(declarations("Themis.css", ".th-table td.th-stock-cell").display).toBe("flex");
});

test("the email modal stays above the module window and scrolls on short displays", () => {
  expect(Number(declarations("Themis.css", ".th-modal-back")["z-index"])).toBeGreaterThan(1490);
  expect(declarations("Themis.css", ".th-modal")).toMatchObject({
    "max-height": "calc(100dvh - 32px)", "overflow-y": "auto", "box-sizing": "border-box",
  });
});

test("archive folder titles stay compact while leaving room for mobile window controls", () => {
  expect(declarations("mobileModulePages.css", ".archive-gallery .ww-titles")).toMatchObject({
    "min-width": "0", flex: "1 1 calc(100% - 24px)",
  });
  expect(declarations("mobileModulePages.css", ".archive-gallery .ww-title")).toMatchObject({
    display: "block", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis",
  });
});
