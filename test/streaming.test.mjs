/**
 * The streaming session against a local fake server (`ws`): normal flow, resume after a drop,
 * failover replay and fatal errors.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

import { SpeechRevolutions, StreamError } from "../dist/esm/index.js";

const MS = 32; // bytes per millisecond of PCM16 mono 16 kHz
const pcm = (ms, v = 1) => {
  const b = new Uint8Array(ms * MS);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < b.length; i += 2) dv.setInt16(i, v, true);
  return b;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const audioOf = (msgs) =>
  Buffer.concat(msgs.filter((m) => m.type === "input_audio_buffer.append").map((m) => Buffer.from(m.audio, "base64")));

/** A scripted /api/v1/stream. `script(n, ws, url, inbox)` drives the n-th connection. */
async function fakeServer(script) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const conns = [];
  wss.on("connection", (ws, req) => {
    const got = [];
    const waiters = [];
    ws.on("message", (d) => {
      got.push(JSON.parse(d.toString()));
      for (const w of waiters.splice(0)) w();
    });
    const next = () => new Promise((r) => waiters.push(r));
    conns.push({ url: req.url, headers: req.headers, got });
    script(conns.length, ws, req.url, got, next);
  });
  const { port } = wss.address();
  return { baseUrl: `http://127.0.0.1:${port}`, conns, close: () => new Promise((r) => wss.close(r)) };
}

async function until(cond, next) {
  while (!cond()) await next();
}

async function finishNormally(ws, got, next) {
  await until(() => got.some((m) => m.type === "input_audio_buffer.commit" && m.final), next);
  ws.send(JSON.stringify({ type: "final", index: 0, text: "hello world", start: 0, end: 1 }));
  ws.send(JSON.stringify({ type: "transcription.done", text: "hello world" }));
}

test("normal session: update, start commit, audio, final commit, result", async () => {
  const srv = await fakeServer(async (n, ws, url, got, next) => {
    ws.send(JSON.stringify({ type: "session.created", job_id: "job-1" }));
    await finishNormally(ws, got, next);
  });
  const client = new SpeechRevolutions({ apiKey: "k", baseUrl: srv.baseUrl });
  const session = await client.stream({ language: "en", vocabulary: ["Zephyr"], turnDetection: { threshold: 0.5 } });
  session.sendAudio(pcm(400));
  const result = await session.finish({ timeoutMs: 5000 });
  await srv.close();

  const { url, headers, got } = srv.conns[0];
  assert.equal(url, "/api/v1/stream");
  assert.equal(headers["x-api-key"], "k");
  assert.match(headers["user-agent"], /^speechrevolutions-node\//);
  assert.equal(got[0].type, "session.update");
  assert.equal(got[0].language, "en");
  assert.deepEqual(got[0].vocabulary, ["Zephyr"]);
  assert.deepEqual(got[0].turn_detection, { threshold: 0.5 });
  assert.deepEqual(got[0].audio_format, { encoding: "pcm_s16le", sample_rate: 16000, channels: 1 });
  assert.deepEqual(got[1], { type: "input_audio_buffer.commit" });
  assert.deepEqual(audioOf(got), Buffer.from(pcm(400)));
  assert.equal(result.complete, true);
  assert.equal(result.text, "hello world");
  assert.equal(result.jobId, "job-1");
});

test("no language: detection, languages hint passed", async () => {
  const srv = await fakeServer(async (n, ws, url, got, next) => {
    ws.send(JSON.stringify({ type: "session.created", job_id: "j" }));
    await finishNormally(ws, got, next);
  });
  const client = new SpeechRevolutions({ apiKey: "k", baseUrl: srv.baseUrl });
  const session = await client.stream({ languages: ["en", "ja"] });
  await session.finish({ timeoutMs: 5000 });
  await srv.close();
  const upd = srv.conns[0].got[0];
  assert.equal("language" in upd, false);
  assert.deepEqual(upd.languages, ["en", "ja"]);
});

test("resume after a drop replays exactly the unacknowledged audio", async () => {
  let firstDone;
  const firstDropped = new Promise((r) => (firstDone = r));
  const srv = await fakeServer(async (n, ws, url, got, next) => {
    if (n === 1) {
      ws.send(JSON.stringify({ type: "session.created", job_id: "job-r" }));
      await until(() => audioOf(got).length >= 600 * MS, next);
      ws.send(JSON.stringify({ type: "audio.committed", through_ms: 200 }));
      await sleep(50);
      firstDone();
      ws.close(1012);
      return;
    }
    ws.send(JSON.stringify({ type: "session.resumed", job_id: "job-r", resume_from_ms: 200 }));
    await finishNormally(ws, got, next);
  });
  const client = new SpeechRevolutions({ apiKey: "k", baseUrl: srv.baseUrl });
  const session = await client.stream({ language: "en" });
  session.sendAudio(pcm(600, 7));
  await firstDropped;
  await sleep(200);
  session.sendAudio(pcm(200, 9));
  const result = await session.finish({ timeoutMs: 10000 });
  await srv.close();

  assert.equal(srv.conns.length, 2);
  const { url, got } = srv.conns[1];
  assert.equal(url, "/api/v1/stream?job_id=job-r");
  assert.deepEqual(got[0], { type: "input_audio_buffer.rewind", from_ms: 200 });
  assert.equal(got.some((m) => m.type === "session.update"), false);
  assert.deepEqual(audioOf(got), Buffer.concat([Buffer.from(pcm(400, 7)), Buffer.from(pcm(200, 9))]));
  assert.equal(result.complete, true);
  assert.equal(result.jobId, "job-r");
});

test("failover resend: rewind and replay on the same connection", async () => {
  const srv = await fakeServer(async (n, ws, url, got, next) => {
    ws.send(JSON.stringify({ type: "session.created", job_id: "j" }));
    await until(() => audioOf(got).length >= 480 * MS, next);
    ws.send(JSON.stringify({ type: "audio.committed", through_ms: 160 }));
    ws.send(JSON.stringify({ type: "resend", from_ms: 160 }));
    await finishNormally(ws, got, next);
  });
  const client = new SpeechRevolutions({ apiKey: "k", baseUrl: srv.baseUrl });
  const session = await client.stream({ language: "en" });
  session.sendAudio(pcm(480, 3));
  await sleep(300);
  const result = await session.finish({ timeoutMs: 10000 });
  await srv.close();
  const got = srv.conns[0].got;
  const rw = got.findIndex((m) => m.type === "input_audio_buffer.rewind");
  assert.ok(rw > 0);
  assert.equal(got[rw].from_ms, 160);
  assert.deepEqual(audioOf(got.slice(rw)), Buffer.from(pcm(320, 3)));
  assert.equal(result.complete, true);
});

test("revised finals replace text; events in order", async () => {
  const srv = await fakeServer(async (n, ws, url, got, next) => {
    ws.send(JSON.stringify({ type: "session.created", job_id: "j" }));
    await until(() => got.some((m) => m.final), next);
    ws.send(JSON.stringify({ type: "final", index: 0, text: "helo", start: 0, end: 1 }));
    ws.send(JSON.stringify({ type: "final.revised", index: 0, text: "hello" }));
    ws.send(JSON.stringify({ type: "transcription.done", text: "hello" }));
  });
  const client = new SpeechRevolutions({ apiKey: "k", baseUrl: srv.baseUrl });
  const seen = [];
  const session = await client.stream({ language: "en", onEvent: (e) => seen.push(e.type) });
  const iterated = (async () => {
    const out = [];
    for await (const e of session) out.push(e.type);
    return out;
  })();
  const result = await session.finish({ timeoutMs: 5000 });
  await srv.close();
  assert.equal(result.finals[0].text, "hello");
  assert.equal(result.finals[0].start, 0);
  assert.deepEqual(seen, ["session.created", "final", "final.revised", "transcription.done"]);
  // The iterator also gets session.created, which arrived before it started reading.
  assert.deepEqual(await iterated, ["session.created", "final", "final.revised", "transcription.done"]);
});

test("fatal error at connect rejects with its code", async () => {
  const srv = await fakeServer(async (n, ws) => {
    ws.send(JSON.stringify({ type: "error", code: "insufficient_balance", message: "top up" }));
  });
  const client = new SpeechRevolutions({ apiKey: "k", baseUrl: srv.baseUrl });
  await assert.rejects(client.stream({ language: "en" }), (e) => e instanceof StreamError && e.code === "insufficient_balance");
  await srv.close();
});

test("fatal error mid-session makes finish reject", async () => {
  const srv = await fakeServer(async (n, ws, url, got, next) => {
    ws.send(JSON.stringify({ type: "session.created", job_id: "j" }));
    await until(() => audioOf(got).length > 0, next);
    ws.send(JSON.stringify({ type: "error", code: "use_batch", message: "sent too fast" }));
  });
  const client = new SpeechRevolutions({ apiKey: "k", baseUrl: srv.baseUrl });
  const session = await client.stream({ language: "en" });
  session.sendAudio(pcm(100));
  await assert.rejects(session.finish({ timeoutMs: 5000 }), (e) => e instanceof StreamError && e.code === "use_batch");
  await srv.close();
});

test("odd-length PCM is refused", async () => {
  const srv = await fakeServer(async (n, ws) => ws.send(JSON.stringify({ type: "session.created", job_id: "j" })));
  const client = new SpeechRevolutions({ apiKey: "k", baseUrl: srv.baseUrl });
  const session = await client.stream({ language: "en" });
  assert.throws(() => session.sendAudio(new Uint8Array(3)), RangeError);
  session.close();
  await srv.close();
});
