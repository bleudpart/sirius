import { startWakeSequence } from "./wakeSequence";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test("delivers the briefing and then mail when the wake-up remains enabled", async () => {
  const announce = jest.fn();
  const briefing = jest.fn().mockResolvedValue(undefined);
  const readMail = jest.fn();
  const cancel = startWakeSequence({ announce, briefing, readMail, isSpeaking: () => false, isEnabled: () => true });

  expect(announce).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(5000);
  await flush();
  expect(briefing).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(3000);
  await flush();
  jest.advanceTimersByTime(800);
  await flush();
  expect(readMail).toHaveBeenCalledTimes(1);
  cancel();
});

test("closing the interface cancels the pending briefing and mail", async () => {
  const briefing = jest.fn();
  const readMail = jest.fn();
  const cancel = startWakeSequence({ announce: jest.fn(), briefing, readMail, isSpeaking: () => false, isEnabled: () => true });

  cancel();
  jest.runAllTimers();
  await Promise.resolve();
  expect(briefing).not.toHaveBeenCalled();
  expect(readMail).not.toHaveBeenCalled();
});

test("disabling the alarm while the briefing is running prevents mail", async () => {
  let enabled = true;
  let finishBriefing;
  const briefing = jest.fn(() => new Promise((resolve) => { finishBriefing = resolve; }));
  const readMail = jest.fn();
  const cancel = startWakeSequence({ announce: jest.fn(), briefing, readMail, isSpeaking: () => false, isEnabled: () => enabled });

  jest.advanceTimersByTime(5000);
  await Promise.resolve();
  enabled = false;
  finishBriefing();
  await Promise.resolve();
  await Promise.resolve();
  jest.runAllTimers();
  expect(readMail).not.toHaveBeenCalled();
  cancel();
});
