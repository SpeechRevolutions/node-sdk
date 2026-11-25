/**
 * Real-time streaming transcription over WebSocket (`wss://.../api/v1/stream`).
 *
 * The session, per the streaming protocol:
 * - **buffers** every chunk until the server acknowledges it (`audio.committed`), at most ~30 s;
 * - **resumes** a dropped connection: reconnects with `?job_id=` for up to 60 s (at once on close
 *   code 1012, "going away for a deploy"), then sends `rewind` and replays the buffer;
 * - **replays on failover** (`resend`) the same way, paced at up to 3x real time.
 *
 * Audio is PCM16 little-endian, mono, 16 kHz. In Node, install `ws` (`npm i ws`) or run Node 22+,
 * whose built-in WebSocket can send the API key as a header.
 */

import { SpeechRevolutionsError } from "./exceptions.js";

export const SAMPLE_RATE = 16000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000; // 32
const CHUNK_MS = 80;
const REPLAY_SPEED = 3;
const RESUME_WINDOW_MS = 60_000;
/** The server accepts audio at most ~10 s ahead of real time; file streaming stays under it. */
export const MAX_LEAD_MS = 8_000;

const FATAL_ERRORS = new Set([
  "invalid_api_key",
  "insufficient_balance",
  "session_expired",
  "no_capacity",
  "idle_timeout",
  "max_duration",
  "use_batch",
  "frame_too_large",
  "bad_audio_format",
]);

export class StreamError extends SpeechRevolutionsError {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "StreamError";
    this.code = code;
  }
}

/**
 * One server event. `type` is the protocol name: `session.created`, `session.resumed`,
 * `transcription.partial` (the open utterance so far; replaces the previous partial of that
 * `index`; `text.slice(0, stable)` is settled), `final`, `final.revised`, `speech.started`,
 * `turn.ended`, `language.detected`, `language.unsupported`, `audio.committed`,
 * `transcription.done`, `voice_focus` (`active`: the stream is locked to the voiceprint), `warning`,
 * `error`. A redacted final whose PII pass fell back to patterns only carries `piiStatus`
 * `"patterns_only"`. Unknown types are passed through with `raw` set.
 */
export interface StreamEvent {
  type: string;
  index?: number;
  text?: string;
  start?: number;
  end?: number;
  stable?: number;
  audioS?: number;
  language?: string;
  probability?: number | null;
  forced?: boolean;
  jobId?: string;
  code?: string;
  message?: string;
  /** `voice_focus`: whether the stream is locked to the voiceprint (only an active lock is billed). */
  active?: boolean;
  /** On a redacted final: `"patterns_only"` when the PII pass fell back to pattern matching. */
  piiStatus?: string;
  raw: Record<string, unknown>;
}

export interface StreamFinal {
  index: number;
  text: string;
  start?: number;
  end?: number;
}

export interface StreamResult {
  jobId?: string;
  /** All finals joined, as the server sent it in `transcription.done`. */
  text: string;
  /** Each utterance's latest text (`final.revised` applied), in order. */
  finals: StreamFinal[];
  /** False when the session ended before `transcription.done`. */
  complete: boolean;
  /** With `captureVoiceprint`: the sealed voiceprint to pass as `voiceprint` later. */
  voiceprint?: string;
  /** Its quality (`{ score, ok, reasons }`); capture again until `ok`. */
  voiceprintQuality?: { score?: number; ok?: boolean; reasons?: string[]; [k: string]: unknown };
}

export interface StreamOptions {
  /** The spoken language (`"en"`, `"ja"`…). Omit to detect it automatically. */
  language?: string;
  /** Narrow automatic detection to these languages. */
  languages?: string[];
  /** Names and terms to recognise (included in the streaming price). */
  vocabulary?: string[];
  /** `{ threshold: 0.05–0.99, max_silence_ms: 300–5000 }`: when a turn ends. */
  turnDetection?: { threshold?: number; max_silence_ms?: number };
  /**
   * PII redaction (+$0.12 per session hour): finals are redacted before they reach you. Partials
   * are not sent while it is on, unless `includePartials` is set (they then arrive unredacted).
   */
  redactPii?: boolean;
  /** As in batch (`PII_POLICIES`). Sent only with `redactPii`. */
  redactPiiPolicies?: string[];
  /** `"entity_name"` (default) or `"hash"`. Sent only with `redactPii`. */
  redactPiiSub?: "entity_name" | "hash";
  /** With `redactPii`: send partials anyway (unredacted). */
  includePartials?: boolean;
  /**
   * Voice focus (+$0.10 per session hour, billed only while a `voice_focus` event says `active`):
   * lock the stream to this enrolled voice (a `voiceprint` from an earlier `captureVoiceprint`
   * session's result), so other people and background voices are left out.
   */
  voiceprint?: string;
  /** Enrol a voice: the result carries `voiceprint` and `voiceprintQuality`. */
  captureVoiceprint?: boolean;
  /** How strictly `voiceprint` is enforced: `"prefer"` or `"strict"`. */
  speakerPolicy?: "prefer" | "strict";
  /** Called for every server event. */
  onEvent?: (event: StreamEvent) => void;
  /** Other `session.update` fields, sent as given. */
  extra?: Record<string, unknown>;
}

// --------------------------------------------------------------- socket adapter

interface Socket {
  send(data: string): void;
  close(code?: number): void;
  /** Cut the connection without a close handshake (tests; `ws` only). */
  terminate?(): void;
}

type SocketHandlers = {
  /** Called synchronously on open, before any message: the first frame can arrive in the same tick. */
  onOpen: (socket: Socket) => void;
  onMessage: (text: string) => void;
  onClose: (code: number) => void;
};

async function openSocket(
  url: string,
  headers: Record<string, string>,
  apiKey: string,
  h: SocketHandlers,
  timeoutMs: number,
): Promise<Socket> {
  let Impl: any;
  let viaHeaders = true;
  try {
    const mod: any = await import(/* @vite-ignore */ "ws" as string);
    Impl = mod.WebSocket ?? mod.default;
  } catch {
    Impl = (globalThis as any).WebSocket;
    if (!Impl) {
      throw new StreamError(
        "No WebSocket implementation: install the `ws` package (npm i ws) or use Node 22+",
      );
    }
  }
  let ws: any;
  if (Impl === (globalThis as any).WebSocket) {
    // Node 22+'s WebSocket (undici) takes headers as a non-standard option; browsers don't, so the
    // key goes in the query string there.
    const isNode = typeof process !== "undefined" && !!process.versions?.node;
    if (isNode) {
      ws = new Impl(url, { headers });
    } else {
      viaHeaders = false;
      const sep = url.includes("?") ? "&" : "?";
      ws = new Impl(`${url}${sep}api_key=${encodeURIComponent(apiKey)}`);
    }
  } else {
    ws = new Impl(url, { headers, maxPayload: 0 });
  }
  void viaHeaders;

  return await new Promise<Socket>((resolve, reject) => {
    let opened = false;
    const timer = setTimeout(() => {
      if (!opened) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new StreamError(`streaming connection timed out after ${timeoutMs} ms`));
      }
    }, timeoutMs);
    ws.addEventListener("open", () => {
      opened = true;
      clearTimeout(timer);
      const socket: Socket = {
        send: (d: string) => ws.send(d),
        close: (code?: number) => ws.close(code),
        terminate: typeof ws.terminate === "function" ? () => ws.terminate() : undefined,
      };
      h.onOpen(socket);
      resolve(socket);
    });
    ws.addEventListener("message", (ev: any) => {
      const d = ev.data;
      if (typeof d === "string") h.onMessage(d);
      else if (d instanceof ArrayBuffer) h.onMessage(new TextDecoder().decode(d));
      else if (d && typeof d.toString === "function") h.onMessage(d.toString());
    });
    ws.addEventListener("close", (ev: any) => {
      clearTimeout(timer);
      if (!opened) {
        reject(new StreamError(`streaming refused (close ${ev.code})`));
        return;
      }
      h.onClose(ev.code ?? 1006);
    });
    ws.addEventListener("error", (ev: any) => {
      if (!opened) {
        clearTimeout(timer);
        const msg = String(ev?.message ?? ev?.error?.message ?? "connection failed");
        const status = /\b(401|403)\b/.test(msg) ? "auth" : /\b429\b/.test(msg) ? "rate" : "";
        reject(
          new StreamError(
            status === "auth"
              ? `streaming refused: check the API key (${msg})`
              : status === "rate"
                ? `streaming refused: too many sessions or connects (${msg})`
                : `streaming connection failed: ${msg}`,
            status === "auth" ? "invalid_api_key" : status === "rate" ? "rate_limited" : undefined,
          ),
        );
      }
    });
  });
}

function toEvent(m: Record<string, unknown>): StreamEvent {
  const err = m.error;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    type: String(m.type ?? ""),
    index: num(m.index),
    text: typeof m.text === "string" ? m.text : undefined,
    start: num(m.start),
    end: num(m.end),
    stable: num(m.stable),
    audioS: num(m.audio_s),
    language: typeof m.language === "string" ? m.language : undefined,
    probability: m.probability === null ? null : num(m.probability),
    forced: typeof m.forced === "boolean" ? m.forced : undefined,
    jobId: typeof m.job_id === "string" ? m.job_id : undefined,
    code:
      typeof m.code === "string"
        ? m.code
        : typeof err === "string" && !err.includes(" ")
          ? err
          : undefined,
    message: typeof m.message === "string" ? m.message : typeof err === "string" ? err : undefined,
    active: typeof m.active === "boolean" ? m.active : undefined,
    piiStatus: typeof m.pii_status === "string" ? m.pii_status : undefined,
    raw: m,
  };
}

function b64(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
  let s = "";
  for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]!);
  return btoa(s);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --------------------------------------------------------------- session

export class LiveSession implements AsyncIterable<StreamEvent> {
  jobId?: string;
  private ws?: Socket;
  private buffer: { start: number; data: Uint8Array }[] = [];
  private audioMs = 0;
  private nextMs = 0;
  private replayUntil = 0;
  private committedMs = 0;
  private finishing = false;
  private finalSent = false;
  private done?: StreamEvent;
  private fatal?: StreamError;
  private finals = new Map<number, StreamFinal>();
  private queue: (StreamEvent | null)[] = [];
  private waiters: ((e: StreamEvent | null) => void)[] = [];
  private closed = false;
  private closedWaiters: (() => void)[] = [];
  private pumping = false;
  private generation = 0;
  /** False between a drop and the server's session.resumed: audio waits in the buffer. */
  private live = false;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly headers: Record<string, string>,
    private readonly update: Record<string, unknown>,
    private readonly onEvent?: (e: StreamEvent) => void,
    private readonly connectTimeoutMs = 15_000,
  ) {}

  /** Open the session; resolves once the server has sent `session.created`. */
  async connect(): Promise<this> {
    await this.open(false);
    return this;
  }

  /** Queue PCM16 mono 16 kHz audio. Send it at the pace it is produced. */
  sendAudio(pcm: Uint8Array): void {
    if (this.fatal) throw this.fatal;
    if (this.finishing) throw new StreamError("sendAudio after finish()");
    if (pcm.byteLength % 2) throw new RangeError("PCM16 audio must be an even number of bytes");
    if (!pcm.byteLength) return;
    this.buffer.push({ start: this.audioMs, data: new Uint8Array(pcm) });
    this.audioMs += pcm.byteLength / BYTES_PER_MS;
    void this.pump();
  }

  /** End the current turn now (push-to-talk release). */
  endTurn(): void {
    this.sendJson({ type: "turn.end" });
  }

  /** End the audio, wait for `transcription.done`, and return the result. */
  async finish(opts: { timeoutMs?: number } = {}): Promise<StreamResult> {
    this.finishing = true;
    void this.pump();
    const timeoutMs = opts.timeoutMs ?? 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      this.whenClosed().then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer); // a pending timer would keep Node running after the session is done
    if (!finished) {
      this.close();
      return this.result(false);
    }
    this.teardown();
    if (this.fatal && !this.done) throw this.fatal;
    return this.result(!!this.done);
  }

  /** Drop the connection without waiting for the transcript. */
  close(): void {
    this.markClosed();
    this.teardown();
  }

  /** Cut the connection without a close handshake (to test resume). Needs the `ws` package. */
  simulateDrop(): void {
    this.ws?.terminate?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: async () => {
        const ev = this.queue.length ? this.queue.shift()! : await new Promise<StreamEvent | null>((r) => this.waiters.push(r));
        return ev === null ? { done: true, value: undefined } : { done: false, value: ev };
      },
    };
  }

  // ----------------------------------------------------------- connection

  private async open(resume: boolean): Promise<void> {
    const gen = ++this.generation;
    const url = resume && this.jobId ? `${this.url}?job_id=${encodeURIComponent(this.jobId)}` : this.url;
    let ready!: () => void;
    let failed!: (e: unknown) => void;
    const handshake = new Promise<void>((res, rej) => {
      ready = res;
      failed = rej;
    });
    let established = false;
    const ws = await openSocket(
      url,
      this.headers,
      this.apiKey,
      {
        onOpen: (socket) => {
          if (gen === this.generation) this.ws = socket;
        },
        onMessage: (text) => {
          if (gen !== this.generation) return;
          let m: Record<string, unknown>;
          try {
            m = JSON.parse(text);
          } catch {
            return;
          }
          const ev = toEvent(m);
          if (!established && ev.type === "error") {
            failed(this.toError(ev));
            return;
          }
          this.handle(ev);
          if (!established && (ev.type === "session.created" || ev.type === "session.resumed")) {
            established = true;
            ready();
          }
          if (ev.type === "transcription.done") {
            this.markClosed();
            this.ws?.close(1000);
          } else if (ev.type === "error" && (FATAL_ERRORS.has(ev.code ?? "") || !this.jobId)) {
            this.fatal = this.toError(ev);
            this.markClosed();
          }
        },
        onClose: (code) => {
          if (gen !== this.generation) return;
          this.live = false;
          if (!established) {
            failed(new StreamError(`streaming closed before the session started (${code})`));
            return;
          }
          if (this.closed) return;
          void this.resume(code === 1012);
        },
      },
      this.connectTimeoutMs,
    );
    this.ws = ws;
    if (!resume) {
      ws.send(JSON.stringify(this.update));
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" })); // start of audio
    }
    const timer = setTimeout(
      () => failed(new StreamError("no session.created from the server")),
      this.connectTimeoutMs,
    );
    try {
      await handshake;
    } catch (e) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async resume(immediately: boolean): Promise<void> {
    const deadline = Date.now() + RESUME_WINDOW_MS;
    let delay = immediately ? 0 : 500;
    while (!this.closed) {
      if (delay) await sleep(delay);
      try {
        await this.open(true);
        return;
      } catch (e) {
        if (e instanceof StreamError && e.code && FATAL_ERRORS.has(e.code)) {
          this.fatal = e;
          break;
        }
        if (e instanceof StreamError && e.code === "invalid_api_key") {
          this.fatal = e;
          break;
        }
      }
      if (Date.now() > deadline) {
        this.fatal = new StreamError("connection lost and could not be resumed within 60 s");
        break;
      }
      delay = Math.min(Math.max(delay * 2, 500), 5000);
    }
    this.markClosed();
  }

  private toError(ev: StreamEvent): StreamError {
    const msg = ev.message ?? ev.code ?? "stream error";
    return new StreamError(ev.code === "invalid_api_key" ? `invalid API key: ${msg}` : msg, ev.code);
  }

  // ----------------------------------------------------------- events

  private handle(ev: StreamEvent): void {
    const m = ev.raw;
    switch (ev.type) {
      case "session.created":
        this.jobId = ev.jobId;
        this.live = true;
        void this.pump();
        break;
      case "session.resumed":
      case "resend": {
        const from = Number(m.resume_from_ms ?? m.from_ms ?? this.committedMs) || 0;
        this.live = true;
        this.rewind(from);
        break;
      }
      case "audio.committed":
        this.committedMs = Number(m.through_ms) || 0;
        this.buffer = this.buffer.filter((c) => c.start + c.data.byteLength / BYTES_PER_MS > this.committedMs);
        break;
      case "final":
        if (ev.index !== undefined) this.finals.set(ev.index, { index: ev.index, text: ev.text ?? "", start: ev.start, end: ev.end });
        break;
      case "final.revised":
        if (ev.index !== undefined) {
          const f = this.finals.get(ev.index);
          this.finals.set(ev.index, { index: ev.index, text: ev.text ?? "", start: f?.start, end: f?.end });
        }
        break;
      case "transcription.done":
        this.done = ev;
        break;
    }
    if (ev.type === "resend") return; // internal: the replay is the answer
    this.emit(ev);
    this.onEvent?.(ev);
  }

  private emit(ev: StreamEvent | null): void {
    const w = this.waiters.shift();
    if (w) w(ev);
    else this.queue.push(ev);
  }

  private rewind(fromMs: number): void {
    this.sendJson({ type: "input_audio_buffer.rewind", from_ms: fromMs });
    this.replayUntil = Math.max(this.nextMs, this.replayUntil);
    this.nextMs = fromMs;
    this.finalSent = false; // re-sent once the replay is through
    void this.pump();
  }

  // ----------------------------------------------------------- sending

  private sendJson(m: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(m));
    } catch {
      /* the close handler resumes; the buffer still holds the audio */
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.live) {
        const chunk = this.chunkAt(this.nextMs);
        if (!chunk) {
          if (this.finishing && !this.finalSent && this.nextMs >= this.audioMs) {
            this.sendJson({ type: "input_audio_buffer.commit", final: true });
            this.finalSent = true;
          }
          return;
        }
        const replay = chunk.start < this.replayUntil;
        this.sendJson({ type: "input_audio_buffer.append", audio: b64(chunk.data) });
        this.nextMs = chunk.start + chunk.data.byteLength / BYTES_PER_MS;
        if (replay) await sleep(chunk.data.byteLength / BYTES_PER_MS / REPLAY_SPEED);
      }
    } finally {
      this.pumping = false;
    }
  }

  private chunkAt(ms: number): { start: number; data: Uint8Array } | undefined {
    for (const c of this.buffer) {
      const end = c.start + c.data.byteLength / BYTES_PER_MS;
      if (end <= ms) continue;
      const off = Math.max(0, ms - c.start) * BYTES_PER_MS;
      const piece = c.data.subarray(off, off + CHUNK_MS * BYTES_PER_MS);
      return piece.byteLength ? { start: c.start + off / BYTES_PER_MS, data: piece } : undefined;
    }
    return undefined;
  }

  // ----------------------------------------------------------- end

  private whenClosed(): Promise<void> {
    return this.closed ? Promise.resolve() : new Promise((r) => this.closedWaiters.push(r));
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.closedWaiters.splice(0)) r();
    this.emit(null);
  }

  private teardown(): void {
    this.generation++; // late frames from this socket are ignored
    try {
      this.ws?.close(1000);
    } catch {
      /* ignore */
    }
  }

  private result(complete: boolean): StreamResult {
    const finals = [...this.finals.values()].sort((a, b) => a.index - b.index);
    const text =
      this.done?.text !== undefined ? this.done.text : finals.map((f) => f.text).filter(Boolean).join(" ");
    const raw = this.done?.raw ?? {};
    return {
      jobId: this.jobId,
      text,
      finals,
      complete,
      voiceprint: typeof raw.voiceprint === "string" ? raw.voiceprint : undefined,
      voiceprintQuality:
        raw.voiceprint_quality && typeof raw.voiceprint_quality === "object"
          ? (raw.voiceprint_quality as StreamResult["voiceprintQuality"])
          : undefined,
    };
  }
}

export function streamUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/api/v1/stream`;
}

export function sessionUpdate(o: StreamOptions): Record<string, unknown> {
  return {
    type: "session.update",
    audio_format: { encoding: "pcm_s16le", sample_rate: SAMPLE_RATE, channels: 1 },
    ...(o.language && o.language !== "auto" ? { language: o.language } : {}),
    ...(o.languages?.length ? { languages: o.languages } : {}),
    ...(o.vocabulary?.length ? { vocabulary: o.vocabulary } : {}),
    ...(o.turnDetection ? { turn_detection: o.turnDetection } : {}),
    ...(o.redactPii
      ? {
          redact_pii: true,
          ...(o.redactPiiPolicies?.length ? { redact_pii_policies: [...o.redactPiiPolicies] } : {}),
          ...(o.redactPiiSub ? { redact_pii_sub: o.redactPiiSub } : {}),
        }
      : {}),
    ...(o.includePartials !== undefined ? { include_partials: !!o.includePartials } : {}),
    ...(o.voiceprint ? { voiceprint: o.voiceprint } : {}),
    ...(o.captureVoiceprint ? { capture_voiceprint: true } : {}),
    ...(o.speakerPolicy ? { speaker_policy: o.speakerPolicy } : {}),
    ...(o.extra ?? {}),
  };
}

/**
 * Send recorded PCM through a session as live audio, then finish. Audio goes out at real time,
 * up to `MAX_LEAD_MS` ahead of the clock (the server's limit), so the first seconds go at once.
 */
export async function streamPcm(session: LiveSession, pcm: Uint8Array): Promise<StreamResult> {
  const step = CHUNK_MS * BYTES_PER_MS;
  const t0 = Date.now();
  for (let i = 0, n = 0; i < pcm.byteLength; i += step, n++) {
    session.sendAudio(pcm.subarray(i, i + step));
    const due = t0 + (n + 1) * CHUNK_MS - MAX_LEAD_MS;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
  }
  return session.finish();
}

/** Any audio file as PCM16 mono 16 kHz (Node; ffmpeg for anything but a 16 kHz mono 16-bit WAV). */
export async function loadPcm16(path: string): Promise<Uint8Array> {
  const fs = await import("node:fs/promises");
  const buf = new Uint8Array(await fs.readFile(path));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(...buf.subarray(o, o + 4));
  if (buf.byteLength > 44 && tag(0) === "RIFF" && tag(8) === "WAVE") {
    let o = 12;
    let fmtOk = false;
    while (o + 8 <= buf.byteLength) {
      const id = tag(o);
      const size = view.getUint32(o + 4, true);
      if (id === "fmt ") {
        const format = view.getUint16(o + 8, true);
        const channels = view.getUint16(o + 10, true);
        const rate = view.getUint32(o + 12, true);
        const bits = view.getUint16(o + 22, true);
        fmtOk = format === 1 && channels === 1 && rate === SAMPLE_RATE && bits === 16;
      } else if (id === "data" && fmtOk) {
        return buf.slice(o + 8, o + 8 + size);
      }
      o += 8 + size + (size % 2);
    }
  }
  const { spawn } = await import("node:child_process");
  return await new Promise<Uint8Array>((resolve, reject) => {
    const p = spawn("ffmpeg", ["-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "-"]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => err.push(d));
    p.on("error", () =>
      reject(new StreamError("ffmpeg is needed to convert this file to PCM16 mono 16 kHz (or pass such a WAV)")),
    );
    p.on("close", (code: number) => {
      const data = Buffer.concat(out);
      if (code !== 0 || !data.length) {
        reject(new StreamError(`ffmpeg could not decode ${path}: ${Buffer.concat(err).toString().slice(0, 300)}`));
      } else resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    });
  });
}
