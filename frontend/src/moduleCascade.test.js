import { startModuleCascade } from "./moduleCascade";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("opens each module in sequence", () => {
  const first = jest.fn();
  const second = jest.fn();
  const cancel = startModuleCascade([{ id: "first", run: first }, { id: "second", run: second }]);

  jest.advanceTimersByTime(0);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  jest.advanceTimersByTime(280);
  expect(second).toHaveBeenCalledTimes(1);
  cancel();
});

test("cancellation prevents later modules from opening", () => {
  const first = jest.fn();
  const second = jest.fn();
  const cancel = startModuleCascade([{ id: "first", run: first }, { id: "second", run: second }]);

  jest.advanceTimersByTime(0);
  cancel();
  jest.runAllTimers();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
});
