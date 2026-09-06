import { accumulateFdeMetrics } from "./fdeOmega";

test("FDE Omega accumulates layout shifts without recent user input", () => {
  const result = accumulateFdeMetrics(
    { cls: 0.1, layoutShiftCount: 1, longTaskCount: 0, worstLongTaskMs: 0 },
    [
      { entryType: "layout-shift", value: 0.08, hadRecentInput: false },
      { entryType: "layout-shift", value: 0.5, hadRecentInput: true },
    ],
  );

  expect(result.cls).toBe(0.18);
  expect(result.layoutShiftCount).toBe(2);
});

test("FDE Omega tracks long task count and worst duration", () => {
  const result = accumulateFdeMetrics(
    { cls: 0, layoutShiftCount: 0, longTaskCount: 1, worstLongTaskMs: 120 },
    [
      { entryType: "longtask", duration: 80 },
      { entryType: "longtask", duration: 640.4 },
    ],
  );

  expect(result.longTaskCount).toBe(3);
  expect(result.worstLongTaskMs).toBe(640);
});
