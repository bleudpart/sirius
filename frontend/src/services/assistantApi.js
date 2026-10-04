import { withBackendResponse } from "../lib/backendRequest";

export const ASSISTANT_TIMEOUTS = Object.freeze({
  stream: 60000,
  conversation: 30000,
  intent: 12000,
  transcription: 30000,
});

const jsonPost = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});
const readJson = async (response) => ({
  ok: response.ok,
  status: response.status,
  data: await response.json(),
});

export function streamConversation(payload, { signal }, consume) {
  return withBackendResponse("/chat/stream", jsonPost(payload), consume, {
    signal, timeoutMs: ASSISTANT_TIMEOUTS.stream,
  });
}

export function requestConversation(payload, { signal }) {
  return withBackendResponse("/chat", jsonPost(payload), async (response) => ({
    ok: response.ok,
    status: response.status,
    data: response.ok ? await response.json() : null,
  }), { signal, timeoutMs: ASSISTANT_TIMEOUTS.conversation });
}

export function requestAssistantIntent(command, { signal }) {
  return withBackendResponse("/intent", jsonPost(JSON.stringify({ text: command })), readJson, {
    signal, timeoutMs: ASSISTANT_TIMEOUTS.intent,
  });
}

export function requestTranscription(form, { signal }) {
  return withBackendResponse("/stt", { method: "POST", body: form }, readJson, {
    signal, timeoutMs: ASSISTANT_TIMEOUTS.transcription,
  });
}
