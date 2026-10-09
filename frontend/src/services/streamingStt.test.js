import { connectStreamingStt } from "./streamingStt";

const OriginalWebSocket = global.WebSocket;

class MockWebSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    global.lastStreamingSocket = this;
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen();
      this.onmessage({ data: JSON.stringify({ type: "ready" }) });
    });
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

afterEach(() => {
  global.WebSocket = OriginalWebSocket;
  delete global.lastStreamingSocket;
});

test("sends audio chunks before requesting a final transcript", async () => {
  global.WebSocket = MockWebSocket;
  const stream = await connectStreamingStt({
    contentType: "audio/webm;codecs=opus",
    groqKey: "user-key",
  });
  const socket = global.lastStreamingSocket;
  const chunk = new Blob(["audio"], { type: "audio/webm" });

  expect(socket.url).toMatch(/\/api\/stt\/stream$/);
  expect(JSON.parse(socket.sent[0])).toEqual({
    action: "start",
    content_type: "audio/webm;codecs=opus",
    groq_key: "user-key",
  });
  expect(stream.send(chunk)).toBe(true);
  expect(socket.sent[1]).toBe(chunk);

  const result = stream.finish();
  expect(JSON.parse(socket.sent[2])).toEqual({ action: "finish" });
  socket.onmessage({
    data: JSON.stringify({ type: "transcript", data: { text: "Bonjour." } }),
  });
  await expect(result).resolves.toEqual({ text: "Bonjour." });
});
