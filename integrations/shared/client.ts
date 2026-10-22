export interface Participant { id: string; label: string }
export interface Proposal { text: string; evidence_sequence: number }
export interface Meeting {
  id: string;
  title: string;
  state: string;
  participants: Participant[];
  created_at: string;
  capture_complete?: boolean;
  capture_reason?: string;
  error?: string;
  fingerprint?: string;
  result?: { summary: string; tasks: Proposal[] };
  fragments?: Record<string, { sequence: number; speaker_id: string; text: string }>;
}
export interface Assignment { task_index: number; participant_id: string }

export function apiRoot(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("API HTTPS requise (HTTP uniquement sur la boucle locale), sans secret dans l'URL.");
  }
  if (url.pathname.replace(/\/$/, "") !== "/api") throw new Error("L'URL doit finir par /api.");
  return url.toString().replace(/\/$/, "");
}

export class SiriusClient {
  private readonly root: string;
  constructor(base: string, private readonly token: string, private readonly cerebras = "") {
    this.root = apiRoot(base);
    if (!token.trim()) throw new Error("Session SIRIUS requise ; renseigner un access_token valide.");
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Chemin API relatif requis.");
    const response = await fetch(this.root + path, {
      method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.cerebras ? { "X-Sirius-Cerebras-Key": this.cerebras } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const detail = result && typeof result === "object" && "detail" in result ? result.detail : null;
      throw new Error(typeof detail === "string" ? detail : `SIRIUS HTTP ${response.status} ; consulter la même référence.`);
    }
    return result as T;
  }
  list() { return this.request<{ items: Meeting[]; truncated: boolean }>("/integrations/meetings"); }
  ask(text: string, session: string) {
    return this.request<{ answer: string }>("/chat", "POST", {
      text, session_id: session, keys: this.cerebras ? { cerebras: this.cerebras } : {},
    });
  }
  detail(id: string) { return this.request<Meeting>(`/integrations/meetings/${encodeURIComponent(id)}`); }
  start(id: string, title: string, participants: Participant[]) {
    return this.request<Meeting>("/integrations/meetings", "POST", {
      request_id: id, title, participants, consent_ids: participants.map((item) => item.id), consent: true,
    });
  }
  fragment(id: string, sequence: number, speaker: string, text: string) {
    return this.request(`/integrations/meetings/${encodeURIComponent(id)}/fragments`, "PUT", {
      sequence, speaker_id: speaker, text,
    });
  }
  finish(id: string, complete: boolean, reason = "") {
    return this.request<Meeting>(`/integrations/meetings/${encodeURIComponent(id)}/finish`, "POST", {
      capture_complete: complete, reason,
    });
  }
  approve(meeting: Meeting, dossier: string, assignments: Assignment[]) {
    return this.request<{ entry_id: string; cross_user_delivery: boolean }>(
      `/integrations/meetings/${encodeURIComponent(meeting.id)}/approve`, "POST", {
        confirm: true, fingerprint: meeting.fingerprint, dossier_id: dossier, assignments,
      });
  }
  publicationPreview(id: string) {
    return this.request<{ text: string; fingerprint: string }>(
      `/integrations/meetings/${encodeURIComponent(id)}/publication`);
  }
  publication(id: string, fingerprint: string) {
    return this.request<{ text: string }>(`/integrations/meetings/${encodeURIComponent(id)}/publication`,
      "POST", { confirm: true, fingerprint });
  }
  async transcribe(wav: Uint8Array, groqKey = ""): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "meeting-fragment.wav");
    if (groqKey) form.append("groq_key", groqKey);
    const response = await fetch(`${this.root}/stt`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(100000),
      headers: { Authorization: `Bearer ${this.token}` }, body: form,
    });
    if (!response.ok) throw new Error(`Transcription refusée (HTTP ${response.status}), capture arrêtée ; aucun retry.`);
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string")
      throw new Error("Transcription SIRIUS non conforme.");
    return result.text.trim();
  }
}
