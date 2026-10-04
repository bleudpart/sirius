import {
  formatUtcTime,
  formatLocalTime,
  formatLocalDate,
  getLocalDateKey,
  formatDocumentDate,
} from "./dateTime";

describe("dateTime", () => {
  const fixed = new Date(2026, 0, 5, 9, 7, 3); // 5 janvier 2026, 09:07:03 locale

  test("les dates documentaires utilisent JJ/MM/AAAA sans décalage de fuseau", () => {
    expect(formatDocumentDate("2026-10-04")).toBe("04/10/2026");
    expect(formatDocumentDate("2026-01-05T23:59:00-12:00")).toBe("05/01/2026");
    expect(formatDocumentDate("2026-10-04 09:30:00")).toBe("04/10/2026");
    expect(formatDocumentDate("04/10/2026")).toBe("04/10/2026");
    expect(formatDocumentDate(null)).toBe("—");
    expect(formatDocumentDate("À préciser")).toBe("À préciser");
  });

  test("getLocalDateKey complète mois et jour avec des zéros", () => {
    expect(getLocalDateKey(fixed)).toBe("2026-01-05");
  });

  test("getLocalDateKey gère la fin d'année", () => {
    expect(getLocalDateKey(new Date(2025, 11, 31))).toBe("2025-12-31");
  });

  test("formatUtcTime renvoie HH:MM:SS depuis l'ISO", () => {
    const utc = new Date(Date.UTC(2026, 0, 5, 23, 4, 9));
    expect(formatUtcTime(utc)).toBe("23:04:09");
  });

  test("formatLocalTime contient heures/minutes/secondes", () => {
    expect(formatLocalTime(fixed)).toMatch(/09.07.03|9.07.03/);
  });

  test("formatLocalDate renvoie une date longue non vide", () => {
    const rendered = formatLocalDate(fixed);
    expect(rendered).toEqual(expect.stringContaining("2026"));
    expect(rendered.length).toBeGreaterThan(8);
  });
});
