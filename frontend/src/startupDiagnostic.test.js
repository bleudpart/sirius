import { explainStartupDiagnostic } from "./startupDiagnostic";

test("explains measured failure without inventing its cause", () => {
  const text = explainStartupDiagnostic({
    measuredAt: "2026-10-10T00:00:00Z",
    checks: [{ label: "Serveur", state: false, scope: "Joignabilité seulement." }],
  });
  expect(text).toContain("Serveur : indisponible");
  expect(text).toContain("pas sa cause exacte");
  expect(text).toContain("2026-10-10");
});

test("missing measurements are not represented as healthy services", () => {
  expect(explainStartupDiagnostic(null)).toContain("pas de résultat");
});
