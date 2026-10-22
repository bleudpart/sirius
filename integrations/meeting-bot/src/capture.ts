import { Participant } from "../../shared/client";

export class ConsentGate {
  readonly accepted = new Set<string>();
  constructor(readonly roster: Participant[]) {
    const ids = roster.map((item) => item.id);
    if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length)
      throw new Error("Une à dix personnes distinctes requises.");
  }
  accept(id: string) {
    if (!this.roster.some((item) => item.id === id)) throw new Error("Participant absent du groupe initial.");
    this.accepted.add(id);
  }
  ready() { return this.roster.every((item) => this.accepted.has(item.id)); }
  unchanged(ids: string[]) {
    return ids.length === this.roster.length && ids.every((id) => this.roster.some((item) => item.id === id));
  }
}

export function wav(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % 4 || pcm.length > 48000 * 4 * 15) throw new Error("PCM stéréo 48 kHz, 15 secondes maximum requis.");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function safeSlackText(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class TranscriptionQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private sequence = 0;
  private characters = 0;
  private closed = false;
  private cancelled = false;
  failed = false;
  constructor(
    private readonly transcribe: (pcm: Buffer) => Promise<string>,
    private readonly save: (sequence: number, speaker: string, text: string) => Promise<unknown>,
    private readonly onFailure: () => void,
  ) {}
  private fail() {
    if (this.failed) return;
    this.failed = true;
    this.onFailure();
  }
  push(speaker: string, pcm: Buffer) {
    if (this.closed || this.failed || pcm.length < 48000 * 4 / 5) return;
    if (this.pending >= 6 || this.sequence >= 240) { this.fail(); return; }
    const sequence = this.sequence++;
    this.pending++;
    this.tail = this.tail.then(async () => {
      if (this.failed || this.cancelled) return;
      const text = await this.transcribe(pcm);
      if (this.cancelled || !text) return;
      if (text.length > 2000 || this.characters + text.length > 24000)
        throw new Error("Limite de transcription atteinte.");
      await this.save(sequence, speaker, text);
      this.characters += text.length;
    }).catch(() => this.fail()).finally(() => { this.pending--; });
  }
  close(cancelPending: boolean) {
    this.closed = true;
    this.cancelled ||= cancelPending;
    return this.tail;
  }
}

export async function publishSlack(token: string, channel: string, text: string) {
  if (!token || !/^[CG][A-Z0-9]+$/.test(channel)) throw new Error("Token et canal Slack fixe requis.");
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text: safeSlackText(text), mrkdwn: false, parse: "none",
      link_names: false, unfurl_links: false, unfurl_media: false }),
  });
  const result: unknown = await response.json();
  if (!response.ok || !result || typeof result !== "object" || !("ok" in result) || result.ok !== true)
    throw new Error("Publication Slack non confirmée ; vérifier le canal, ne pas renvoyer automatiquement.");
}
