/**
 * Live tests for 1.1 against the REAL API: add-on options, deleteJob and real-time streaming,
 * including a cut connection that must resume. Opt-in (bills a few minutes of audio):
 *
 *   SR_LIVE=1 SPEECHREVOLUTIONS_API_KEY=stt_... node --test test/live-features.test.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SpeechRevolutions, loadPcm16 } from "../dist/esm/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const asset = (n) => path.join(HERE, "assets", n);
const CALL = asset("call.mp3"); // bank call: names, card, phone, "Northwind Bank"
const NONAME = asset("noname.mp3"); // two speakers, quarterly numbers, no names said
const PROF = asset("prof.mp3"); // three strong swear words
const LIVE = process.env.SR_LIVE === "1" && Boolean(process.env.SPEECHREVOLUTIONS_API_KEY);
const norm = (t) => t.toLowerCase().replace(/[.,]/g, " ").split(/\s+/).filter(Boolean).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("live: 1.1 features", { skip: !LIVE && "set SR_LIVE=1 and SPEECHREVOLUTIONS_API_KEY" }, () => {
  const client = LIVE ? new SpeechRevolutions() : null;

  test("speaker labels are off by default, on when asked", async () => {
    const plain = await client.transcribe(NONAME);
    assert.ok(norm(plain.text).includes("quarterly"));
    assert.ok(plain.words.every((w) => w.speaker === undefined || w.speaker === null));
    const labelled = await client.transcribe(NONAME, { speakerLabels: true });
    assert.equal(new Set(labelled.words.map((w) => w.speaker)).size, 2);
  });

  test("summary and paragraphs", async () => {
    const t = await client.transcribe(NONAME, { speakerLabels: true, summarize: true, paragraphs: true });
    assert.ok(t.summary && t.summary.text.length > 40 && t.summary.bullets.length > 0);
    assert.ok(t.paragraphs.length >= 2 && t.paragraphs.every((p) => p.text && p.sentences.length));
    assert.equal(t.toDict().summary.text, t.summary.text);
  });

  test("profanity filter, and extra passes options through", async () => {
    const f = await client.transcribe(PROF, { filterProfanity: true });
    assert.ok(f.text.includes("s***") && !f.text.toLowerCase().includes("shit"));
    const e = await client.transcribe(PROF, { extra: { filter_profanity: true } });
    assert.ok(e.text.includes("s***"));
  });

  test("custom vocabulary fixes the brand", async () => {
    const t = await client.transcribe(CALL, { customVocabulary: ["Northwind"] });
    assert.ok(norm(t.text).includes("northwind bank"));
    assert.ok(!norm(t.text).includes("north northwind"));
  });

  test("deleteJob", async (t) => {
    const jobId = await client.submit(PROF);
    for (let i = 0; i < 60 && !(await client.getJobStatus(jobId)).status.startsWith("completed"); i++) await sleep(2000);
    try {
      await client.deleteJob(jobId);
    } catch (e) {
      if (String(e.message).includes("temporarily unavailable")) {
        t.skip("prod user_cluster lacks s3:DeleteObject (2026-11-23)");
        return;
      }
      throw e;
    }
    await assert.rejects(client.getTranscript(jobId));
  });

  test("streamFile: partials, finals, done", async () => {
    const types = [];
    const r = await client.streamFile(NONAME, { language: "en", onEvent: (e) => types.push(e.type) });
    assert.ok(r.complete && r.jobId);
    assert.ok(norm(r.text).includes("quarterly") && norm(r.text).includes("planning meeting"));
    for (const t of ["session.created", "transcription.partial", "final", "transcription.done"]) assert.ok(types.includes(t), t);
  });

  test("stream: turn events, vocabulary, auto language", async () => {
    const events = [];
    const r = await client.streamFile(CALL, { vocabulary: ["Northwind"], onEvent: (e) => events.push(e) });
    const types = events.map((e) => e.type);
    assert.ok(norm(r.text).includes("northwind bank"));
    assert.ok(types.includes("speech.started") && types.includes("turn.ended"));
    assert.equal(events.find((e) => e.type === "language.detected")?.language, "en");
  });

  test("stream resumes after the connection is cut", async () => {
    const types = [];
    const session = await client.stream({ language: "en", onEvent: (e) => types.push(e.type) });
    const jobId = session.jobId;
    const pcm = await loadPcm16(NONAME);
    const step = 80 * 32;
    const t0 = Date.now();
    for (let i = 0, n = 0; i < pcm.length; i += step, n++) {
      session.sendAudio(pcm.subarray(i, i + step));
      if (i <= pcm.length / 2 && pcm.length / 2 < i + step) session.simulateDrop();
      const wait = t0 + (n + 1) * 80 / 1.3 - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const r = await session.finish({ timeoutMs: 120000 });
    assert.ok(types.includes("session.resumed"), "expected a resume");
    assert.ok(r.complete);
    assert.equal(r.jobId, jobId);
    assert.ok(norm(r.text).includes("quarterly") && norm(r.text).includes("deck with the numbers"));
  });

  test("a bad key is refused", async () => {
    const bad = new SpeechRevolutions({ apiKey: "stt_" + "0".repeat(64) });
    await assert.rejects(bad.stream({ language: "en" }));
  });
});
