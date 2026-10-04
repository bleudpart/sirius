const { captureRectangle } = require("../public/electron/capture_region");

const bounds = { width: 1440, height: 900 };

test("full interface capture retains the default rectangle", () => {
  expect(captureRectangle(undefined, bounds)).toBeUndefined();
  expect(captureRectangle(null, bounds)).toBeUndefined();
});

test("mouse coordinates become integer DIP coordinates without display scaling", () => {
  expect(captureRectangle({ x: 20.5, y: 30.2, w: 100.4, h: 80.5 }, bounds))
    .toEqual({ x: 20, y: 30, width: 101, height: 81 });
});

test("rectangle is clipped to the content bounds", () => {
  expect(captureRectangle({ x: 1400, y: 850, w: 100, h: 100 }, bounds))
    .toEqual({ x: 1400, y: 850, width: 40, height: 50 });
});

test.each([
  { x: -1, y: 0, w: 20, h: 20 },
  { x: 0, y: 0, w: 0, h: 20 },
  { x: 0, y: NaN, w: 20, h: 20 },
  { x: 0, y: 0, w: Infinity, h: 20 },
  { x: 1500, y: 0, w: 20, h: 20 },
  {},
])("invalid capture rectangle is rejected: %p", (region) => {
  expect(() => captureRectangle(region, bounds)).toThrow(/Zone de capture/);
});
