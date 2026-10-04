import { createVoiceSession, linkAbortSignal } from "./voiceSession";

test("stopping aborts the current requests and resume never revives an old signal", () => {
  const session = createVoiceSession();
  const old = session.signal;
  const lateResponse = jest.fn();
  const deliver = () => { if (!old.aborted) lateResponse(); };
  session.stop();
  expect(old.aborted).toBe(true);
  expect(session.stopped).toBe(true);
  session.resume();
  deliver();
  expect(lateResponse).not.toHaveBeenCalled();
  expect(session.signal).not.toBe(old);
  expect(session.signal.aborted).toBe(false);
  expect(session.resume()).toBe(session.signal);
});

test("links cancellation to a request controller and removes the listener", () => {
  const parent = new AbortController();
  const child = new AbortController();
  const remove = jest.spyOn(parent.signal, "removeEventListener");
  const unlink = linkAbortSignal(parent.signal, child);
  parent.abort();
  expect(child.signal.aborted).toBe(true);
  unlink();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

test("an already canceled session cannot start a new request", () => {
  const parent = new AbortController();
  parent.abort();
  const child = new AbortController();
  linkAbortSignal(parent.signal, child)();
  expect(child.signal.aborted).toBe(true);
});
