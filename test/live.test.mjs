/**
 * Tests that talk to the REAL Speech Revolutions API.
 *
 * Everything else in this directory runs against `mock_api.py`, which is a
 * MODEL of the contract written by reading the server. A model can be wrong in
 * the same way the client is wrong, and then the suite is green while
 * production is broken. These close that gap for JavaScript specifically:
 * until they existed, the Node client had never once been pointed at the real
 * API, and the mock was the only thing claiming it worked.
 *
 * OPT-IN, because they create real jobs on a real account and cost real money
 * (a few seconds of audio each, so fractions of a cent):
 *
 *   SR_LIVE=1 SPEECHREVOLUTIONS_API_KEY=stt_... node --test test/live.test.mjs
 *
 * Override the clip with SR_LIVE_AUDIO; SR_LIVE_LONG_AUDIO enables the progress
 * test, which needs a file long enough to emit intermediate events.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SpeechRevolutions } from "../dist/esm/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

const LIVE =
  process.env.SR_LIVE === "1" &&
  Boolean(process.env.SPEECHREVOLUTIONS_API_KEY || process.env.STT_API_KEY);

/** The shortest clip available: these create real, billed jobs. */
function audioPath() {
  if (process.env.SR_LIVE_AUDIO) return process.env.SR_LIVE_AUDIO;
  for (const name of ["ru_uk_segment.mp3", "crawl11.mp3"]) {
    const p = path.join(REPO, "qa-audio", name);
    if (existsSync(p)) return p;
  }
  return null;
}

const client = () => new SpeechRevolutions({ timeout: 900_000 });

describe("live API", { skip: LIVE ? false : "opt-in: set SR_LIVE=1 (creates real, billable jobs)" }, () => {
  // -------------------------------------------------------------------------
  // Read-only: no jobs created, no cost
  // -------------------------------------------------------------------------

  test("listJobs returns the documented shape", async () => {
    const page = await client().listJobs({ limit: 3 });
    assert.ok(Array.isArray(page.jobs));
    for (const job of page.jobs) {
      assert.ok(job.jobId, "a job summary came back with no jobId");
      // Production sends {job_id, created_at} and no status.
      assert.ok(job.createdAt, `job ${job.jobId} has no createdAt`);
    }
  });

  test("listJobs paginates without duplicates", async () => {
    const c = client();
    const seen = new Set();
    let before;
    for (let i = 0; i < 3; i++) {
      const page = await c.listJobs({ limit: 2, before });
      for (const job of page.jobs) {
        assert.ok(!seen.has(job.jobId), `pagination returned ${job.jobId} twice`);
        seen.add(job.jobId);
      }
      before = page.nextBefore;
      if (!before) break;
    }
  });

  test("a bad key is rejected", async () => {
    const bogus = new SpeechRevolutions({ apiKey: "stt_definitely_not_a_real_key" });
    await assert.rejects(() => bogus.listJobs({ limit: 1 }));
  });

  // -------------------------------------------------------------------------
  // Billable: each of these transcribes a real clip
  // -------------------------------------------------------------------------

  test("transcribe from a path", async () => {
    const audio = audioPath();
    assert.ok(audio, "no test audio found; set SR_LIVE_AUDIO");

    const result = await client().transcribe(audio, { speakerLabels: true });
    assert.ok(result.text.trim(), "the real API returned an empty transcript");
    assert.ok(result.words.length > 0, "no words; wordTimestamps defaults to on");
  });

  test("transcribe from bytes", async () => {
    const audio = audioPath();
    assert.ok(audio, "no test audio found; set SR_LIVE_AUDIO");

    const result = await client().transcribe(readFileSync(audio));
    assert.ok(result.text.trim());
  });

  test("submit then poll to completion", async () => {
    const audio = audioPath();
    assert.ok(audio, "no test audio found; set SR_LIVE_AUDIO");
    const c = client();

    const jobId = await c.submit(audio);
    assert.match(jobId, /^[0-9a-f-]{36}$/, `job id ${jobId} is not a UUID`);

    const flags = await c.checkFailed([jobId]);
    assert.deepEqual(flags, [false]);

    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const status = await c.getJobStatus(jobId);
      if (status.status === "completed") {
        assert.ok(status.downloadUrl, "a completed job carried no downloadUrl");

        const result = await c.getTranscript(jobId);
        assert.ok(result.text.trim());

        const raw = await c.downloadResult(status.downloadUrl);
        assert.ok(raw.byteLength > 0, "downloadResult returned no bytes");
        return;
      }
      assert.notEqual(status.status, "failed",
        `job ${jobId} failed at ${status.failedStage}: ${status.reason}`);
      assert.ok(Date.now() < deadline, `job ${jobId} did not finish in 10 minutes`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  });

  test("srt output from the real API", async () => {
    const audio = audioPath();
    assert.ok(audio, "no test audio found; set SR_LIVE_AUDIO");

    const result = await client().transcribe(audio, { outputType: "srt" });
    assert.ok(result.text.includes("-->"), `not SRT: ${result.text.slice(0, 120)}`);
  });

  // The full upload flow the convenience methods wrap. Nothing else exercises
  // these against the real API.
  test("the raw upload flow", async () => {
    const audio = audioPath();
    assert.ok(audio, "no test audio found; set SR_LIVE_AUDIO");
    const c = client();

    const data = readFileSync(audio);
    const job = await c.createUploadJob(data.byteLength);
    assert.ok(job.jobId && job.uploadUrl, `createUploadJob returned ${JSON.stringify(job)}`);

    await c.uploadAudio(job.uploadUrl, data, { jobId: job.jobId });
    await c.touchUploadProgress(job.jobId);
    await c.completeUpload(job.jobId);

    const { content } = await c.waitForResult(job.jobId, job.downloadUrl);
    assert.ok(content.byteLength > 0, "waitForResult returned no bytes");
  });

  test("cancel a job", async () => {
    const audio = audioPath();
    assert.ok(audio, "no test audio found; set SR_LIVE_AUDIO");
    const c = client();

    // Cancel before completing the upload, so nothing is transcribed and the
    // job costs nothing.
    const job = await c.createUploadJob(readFileSync(audio).byteLength);
    await c.cancelJob(job.jobId);
  });

  // Live progress is a headline feature, so prove it actually arrives — but
  // only on a file long enough to emit intermediate events. A short clip
  // finishes before the first one is sent, so asserting on the default clip
  // would test the clock, not the client.
  test("progress fires for a long file", async (t) => {
    const long = process.env.SR_LIVE_LONG_AUDIO;
    if (!long || !existsSync(long)) {
      t.skip("set SR_LIVE_LONG_AUDIO to a file of 20 minutes or more");
      return;
    }

    const steps = [];
    const result = await client().transcribe(long, {
      onProgress: (e) => steps.push(e.step),
    });

    assert.ok(result.text.trim());
    assert.ok(steps.length >= 3, `expected several progress events, got ${steps.length}: ${steps}`);
    assert.ok(steps.some((s) => s?.startsWith("chunk:")), `no chunk steps in ${steps}`);
  });

  // ---------------------------------------------------------------------------
  // Webhooks
  //
  // Needs a PUBLIC callback URL: the pipeline resolves the callback host and
  // refuses anything that is not globally routable, so localhost is rejected
  // before a request is made. Point SR_LIVE_WEBHOOK_BASE at a tunnel.
  // ---------------------------------------------------------------------------

  test("a webhook is delivered by the real pipeline", { timeout: 900_000 }, async (t) => {
    const base = process.env.SR_LIVE_WEBHOOK_BASE;
    if (!base) {
      t.skip("set SR_LIVE_WEBHOOK_BASE to a public tunnel URL " +
             "(the pipeline refuses non-public callback hosts)");
      return;
    }
    const audio = audioPath();
    assert.ok(audio, "no test audio found; set SR_LIVE_AUDIO");

    const port = Number(process.env.SR_LIVE_WEBHOOK_PORT ?? 8799);

    let resolveHit;
    const hit = new Promise((r) => { resolveHit = r; });

    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        resolveHit({ raw: Buffer.concat(chunks), headers: req.headers, path: req.url });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((r) => server.listen(port, "127.0.0.1", r));

    try {
      const callback = `${base.replace(/\/$/, "")}/webhooks/speechrevolutions`;
      const jobId = await client().submit(audio, { callbackUrl: callback });

      const got = await Promise.race([
        hit,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("no webhook arrived within 15 minutes")), 900_000)),
      ]);

      const event = JSON.parse(got.raw.toString());
      assert.equal(event.job_id, jobId);
      assert.ok(["completed", "failed"].includes(event.status), `status ${event.status}`);
      assert.ok(got.path.endsWith("/webhooks/speechrevolutions"), `delivered to ${got.path}`);

      // Headers the documented receivers rely on.
      assert.equal(got.headers["x-sr-event"], event.status);
      assert.ok(got.headers["x-sr-delivery"], "no delivery id");
      assert.ok((got.headers["user-agent"] ?? "").startsWith("SpeechRevolutions-Webhook/"),
        `unexpected webhook User-Agent ${got.headers["user-agent"]}`);

      // Absent means the secret is unset server-side, which is worth reporting
      // rather than silently passing.
      const sig = got.headers["x-sr-signature"];
      if (sig) assert.ok(sig.startsWith("sha256="), `unexpected signature format: ${sig}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
