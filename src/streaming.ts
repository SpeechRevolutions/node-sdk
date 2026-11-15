/**
 * Realtime streaming transcription (WebSocket /api/v1/stream).
 *
 *   const session = await client.stream({ language: undefined }); // undefined = detect the language
 *   session.on("final", (e) => console.log(e.start, e.text));
 *   for (const chunk of pcm16Chunks) await session.sendAudio(chunk);
 *   await session.finish();
 *   await session.done; // resolves with the whole text
 *
 * Audio is PCM16 mono 16 kHz. Events: "partial" (replaces the previous partial of the same index; `stable` =
 * settled leading characters), "final", "revision", "speech_started", "turn_ended", "language", "done", "error".
 *
 * Needs the `ws` package (an optional peer dependency: `npm install ws`) -- the WebSocket built into Node cannot
 * send the X-API-Key header, and Node 18 has none at all.
 */

import { EventEmitter } from "node:events";

export interface StreamOptions {
  /** ISO code to pin the language; omit to detect it. */
  language?: string;
  /** Terms to bias recognition toward (names, products, jargon). */
  vocabulary?: string[];
  /** Your id for the person speaking: their automatically learned vocabulary is added (opted-in accounts). */
  endUserId?: string;
  /** End-of-turn probability threshold (Smart Turn) and the silence after which a turn always ends. */
  turnThreshold?: number;
  maxSilenceMs?: number;
}

export interface StreamEvent {
  type: string;
  text: string;
  index?: number;
  start?: number;
  end?: number;
  stable?: number;
  language?: string;
  raw: Record<string, unknown>;
}

const TYPES: Record<string, string> = {
  "transcription.partial": "partial",
  final: "final",
  "final.revised": "revision",
  "speech.started": "speech_started",
  "turn.ended": "turn_ended",
  "language.detected": "language",
  "transcription.done": "done",
  error: "error",
  "session.created": "session",
};

/** A server message, normalised (exported for tests). */
export function toEvent(m: Record<string, any>): StreamEvent {
  const type = TYPES[m.type] ?? m.type;
  return {
    type,
    text: m.text ?? (type === "error" ? String(m.error ?? m.message ?? "") : ""),
    index: m.index,
    start: m.start ?? m.audio_s,
    end: m.end,
    stable: m.stable,
    language: m.language,
    raw: m,
  };
}

/** The session.update a StreamOptions becomes (exported for tests). */
export function sessionUpdate(o: StreamOptions): Record<string, unknown> {
  const u: Record<string, unknown> = { type: "session.update" };
  if (o.language && o.language !== "auto") u.language = o.language;
  if (o.vocabulary?.length) u.vocabulary = [...o.vocabulary];
  if (o.endUserId) u.end_user_id = o.endUserId;
  const turn: Record<string, number> = {};
  if (o.turnThreshold !== undefined) turn.threshold = o.turnThreshold;
  if (o.maxSilenceMs !== undefined) turn.max_silence_ms = o.maxSilenceMs;
  if (Object.keys(turn).length) u.turn_detection = turn;
  return u;
}

export class StreamSession extends EventEmitter {
  /** The job id the stream is recorded (and billed) under. */
  jobId?: string;
  /** Resolves with the whole transcript once the server has sent everything after finish(). */
  readonly done: Promise<string>;
  private resolveDone!: (t: string) => void;
  private rejectDone!: (e: Error) => void;

  constructor(private readonly ws: any) {
    super();
    this.done = new Promise((res, rej) => {
      this.resolveDone = res;
      this.rejectDone = rej;
    });
    this.done.catch(() => undefined); // an unobserved rejection must not crash the process
    ws.on("message", (data: any) => {
      let m: Record<string, any>;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      const e = toEvent(m);
      if (e.type === "session") {
        this.jobId = m.job_id;
        return;
      }
      this.emit(e.type, e);
      this.emit("event", e);
      if (e.type === "done") this.resolveDone(e.text);
      if (e.type === "error") this.rejectDone(new Error(e.text || "stream error"));
    });
    ws.on("close", () => this.rejectDone(new Error("stream closed before done")));
  }

  /** Send PCM16 mono 16 kHz audio (any chunk size). */
  async sendAudio(pcm16: Uint8Array): Promise<void> {
    if (pcm16.length) await this.send({ type: "input_audio_buffer.append", audio: Buffer.from(pcm16).toString("base64") });
  }

  /** Finalise the current utterance now (push-to-talk release). */
  endTurn(): Promise<void> {
    return this.send({ type: "turn.end" });
  }

  /** No more audio: the server sends the remaining finals, then "done". */
  finish(): Promise<void> {
    return this.send({ type: "input_audio_buffer.commit", final: true });
  }

  close(): void {
    this.ws.close();
  }

  private send(m: Record<string, unknown>): Promise<void> {
    return new Promise((res, rej) => this.ws.send(JSON.stringify(m), (err?: Error) => (err ? rej(err) : res())));
  }
}

/** Open a session (used by SpeechRevolutions.stream). */
export async function openStream(baseUrl: string, apiKey: string, opts: StreamOptions = {},
  userAgent = "speechrevolutions-node"): Promise<StreamSession> {
  let WS: any;
  try {
    const name = "ws"; // a variable, so bundlers and tsc do not require the optional dependency
    WS = (await import(name)).default;
  } catch {
    throw new Error("streaming needs the `ws` package: npm install ws");
  }
  const url = baseUrl.replace(/^http/, "ws") + "/api/v1/stream";
  // a User-Agent is required: the edge answers a handshake without one with a bare 403
  const ws = new WS(url, { headers: { "X-API-Key": apiKey, "User-Agent": userAgent }, maxPayload: 0 });
  await new Promise<void>((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  const session = new StreamSession(ws);
  ws.send(JSON.stringify(sessionUpdate(opts)));
  ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  return session;
}
