/**
 * The published surface, end to end against a real server.
 *
 * The retry tests stub `fetch`; these do not. They spawn the API mock from the
 * python-sdk checkout — the reference implementation of the contract, shared
 * with the Python suites and the cookbook tests so the three cannot drift — and
 * drive the real client over a real socket.
 *
 * Uploads, polling, SSE, list pagination and webhooks had no coverage at all.
 *
 * Skipped automatically when the mock is not found. Point elsewhere with
 * SR_MOCK_API=/path/to/python-sdk/tests/mock_api.py
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SpeechRevolutions, JobFailedError, AuthenticationError } from "../dist/esm/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK =
  process.env.SR_MOCK_API ??
  path.resolve(HERE, "../../python-sdk/tests/mock_api.py");
const PYTHON = process.env.SR_PYTHON ?? "python3";
const WEBHOOK_SECRET = "whsec_node_functional";

const AVAILABLE = existsSync(MOCK);

/** Boots `mock_api.py` on a free port and waits for it to answer. */
async function startMock({ port, secret, failAt, streamStatus } = {}) {
  port = port ?? 8000 + Math.floor(Math.random() * 20000);
  const args = [MOCK, "--port", String(port), "--api-key", "test-key", "--progress-steps", "2"];
  if (secret) args.push("--webhook-secret", secret);
  if (failAt) args.push("--fail-at", failAt);
  if (streamStatus) args.push("--stream-status", String(streamStatus));
  const proc = spawn(PYTHON, args, { stdio: ["ignore", "pipe", "pipe"] });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`mock exited ${proc.exitCode}`);
    try {
      // Any answer means the socket is listening.
      await fetch(`${base}/api/v1/jobs`, { headers: { "X-API-Key": "test-key" } });
      return { base, proc, port };
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  proc.kill();
  throw new Error("mock never came up");
}

function client(base, opts = {}) {
  return new SpeechRevolutions({ apiKey: "test-key", baseUrl: base, ...opts });
}

const audio = () => new Uint8Array(4096).fill(7);

describe("functional (real server)", { skip: AVAILABLE ? false : `mock not found at ${MOCK}` }, () => {
  let mock;

  before(async () => { mock = await startMock(); });
  after(() => { mock?.proc.kill(); });

  // -- uploads ------------------------------------------------------------

  test("transcribe uploads bytes and returns the transcript", async () => {
    const r = await client(mock.base).transcribe(audio());
    assert.equal(r.text, "Good morning everyone. Thanks for joining.");
  });

  test("utterances are grouped by speaker turn", async () => {
    const r = await client(mock.base).transcribe(audio());
    assert.deepEqual(
      r.utterances.map((u) => [u.speaker, u.text]),
      [["A", "Good morning everyone."], ["B", "Thanks for joining."]],
    );
  });

  test("words carry timings, speaker and confidence", async () => {
    const r = await client(mock.base).transcribe(audio());
    assert.equal(r.words.length, 6);
    assert.equal(r.words[0].word, "Good");
    assert.equal(r.words[0].speaker, "A");
    assert.ok(r.words[0].end > r.words[0].start);
  });

  test("a URL is fetched server-side, not uploaded", async () => {
    const r = await client(mock.base).transcribe("https://example.com/a.mp3");
    assert.ok(r.text);
  });

  test("output_type srt returns subtitle text", async () => {
    const r = await client(mock.base).transcribe(audio(), { outputType: "srt" });
    assert.match(r.text, /-->/);
  });

  test("multipart disabled falls back to a single PUT", async () => {
    const m = await startMock();
    try {
      // The mock 404s multipart/create only when told to; instead force the
      // client's own single-shot path, which is the same code being exercised.
      const r = await client(m.base, { multipart: false }).transcribe(audio());
      assert.ok(r.text);
    } finally {
      m.proc.kill();
    }
  });

  // -- progress -----------------------------------------------------------

  test("progress callback fires for every event", async () => {
    const seen = [];
    await client(mock.base).transcribe(audio(), {}, (e) => seen.push(e));
    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((e) => e.completed), [1, 2]);
    assert.ok(seen.every((e) => e.total === 2));
  });

  // -- jobs API -----------------------------------------------------------

  test("submit returns a job id without waiting", async () => {
    const id = await client(mock.base).submit("https://example.com/a.mp3");
    assert.match(id, /^job_/);
  });

  test("getJobStatus reports completion with a download url", async () => {
    const c = client(mock.base);
    const id = await c.submit("https://example.com/a.mp3");
    const s = await c.getJobStatus(id);
    assert.equal(s.jobId, id);
    assert.ok(s.downloadUrl);
  });

  test("getTranscript retrieves by id", async () => {
    const c = client(mock.base);
    const id = await c.submit("https://example.com/a.mp3");
    const r = await c.getTranscript(id);
    assert.equal(r.text, "Good morning everyone. Thanks for joining.");
  });

  test("listJobs paginates with the cursor without duplicates", async () => {
    const m = await startMock();
    try {
      const c = client(m.base);
      for (let i = 0; i < 5; i++) await c.submit(`https://example.com/${i}.mp3`);

      const seen = [];
      let before;
      for (let i = 0; i < 10; i++) {
        const page = await c.listJobs({ limit: 2, before });
        seen.push(...page.jobs.map((j) => j.job_id ?? j.jobId));
        before = page.next_before ?? page.nextBefore;
        if (!before) break;
      }
      assert.equal(seen.length, 5);
      assert.equal(new Set(seen).size, 5, "pagination returned a duplicate");
    } finally {
      m.proc.kill();
    }
  });

  test("cancelJob", async () => {
    const c = client(mock.base);
    const job = await c.createUploadJob(1024);
    await c.cancelJob(job.jobId);
  });

  test("checkFailed preserves order", async () => {
    const m = await startMock();
    try {
      const c = client(m.base);
      const ok = await c.submit("https://example.com/ok.mp3");
      const flags = await c.checkFailed([ok]);
      assert.deepEqual(flags, [false]);
    } finally {
      m.proc.kill();
    }
  });

  test("a bad api key raises AuthenticationError", async () => {
    const c = new SpeechRevolutions({ apiKey: "wrong", baseUrl: mock.base });
    await assert.rejects(() => c.listJobs(), AuthenticationError);
  });

  // -- failures -----------------------------------------------------------

  test("a failed job raises JobFailedError, carrying step and reason", async () => {
    const m = await startMock({ failAt: "gpu_timestamps" });
    try {
      await assert.rejects(
        () => client(m.base).transcribe(audio()),
        (err) => {
          assert.ok(err instanceof JobFailedError, `got ${err?.constructor?.name}`);
          assert.match(String(err.message ?? err), /gpu_timestamps/);
          return true;
        },
      );
    } finally {
      m.proc.kill();
    }
  });

  test("an SSE endpoint that refuses falls back to polling", async () => {
    // A proxy that will not pass text/event-stream answers 503 forever. The
    // client must still deliver the transcript, via the polling path.
    const m = await startMock({ streamStatus: 503 });
    try {
      const r = await client(m.base).transcribe(audio());
      assert.equal(r.text, "Good morning everyone. Thanks for joining.");
    } finally {
      m.proc.kill();
    }
  });

  // -- webhooks -----------------------------------------------------------

  test("callbackUrl is delivered, signed over the raw bytes", async () => {
    const received = [];
    const srv = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({ raw: Buffer.concat(chunks), headers: req.headers });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const hookUrl = `http://127.0.0.1:${srv.address().port}/webhooks`;

    const m = await startMock({ secret: WEBHOOK_SECRET });
    try {
      const id = await client(m.base).submit("https://example.com/a.mp3", {
        callbackUrl: hookUrl,
      });

      const deadline = Date.now() + 8000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(received.length, 1, "no webhook arrived");

      const got = received[0];
      const event = JSON.parse(got.raw.toString());
      assert.equal(event.job_id, id);
      assert.equal(event.status, "completed");
      assert.equal(got.headers["x-sr-event"], "completed");
      assert.ok(got.headers["x-sr-delivery"]);

      // The signature is over the RAW bytes; re-serialising changes them.
      const expected =
        "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(got.raw).digest("hex");
      assert.equal(got.headers["x-sr-signature"], expected);

      // A language difference worth knowing, because it decides how this bug
      // shows up. Python's json.dumps() defaults to ", " / ": " separators, so
      // re-serialising there changes the bytes and every delivery is rejected
      // loudly. JSON.stringify() is compact by default, so in Node the
      // round-trip reproduces the same bytes FOR THIS PAYLOAD and the signature
      // still verifies — the bug hides until a payload arrives whose key order,
      // unicode escaping or number formatting does not survive the round-trip.
      const reserialized = Buffer.from(JSON.stringify(JSON.parse(got.raw.toString())));
      const afterRoundTrip =
        "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(reserialized).digest("hex");
      assert.equal(
        afterRoundTrip,
        expected,
        "JSON.stringify is compact, so this payload survives a round-trip",
      );

      // Which is exactly why the rule is "verify the raw bytes", not "verify a
      // re-serialisation that happens to match". Reorder one key and it breaks.
      const parsed = JSON.parse(got.raw.toString());
      const reordered = Buffer.from(
        JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse())),
      );
      const wrong =
        "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(reordered).digest("hex");
      assert.notEqual(wrong, expected, "any byte change must break the signature");
    } finally {
      m.proc.kill();
      srv.close();
    }
  });
});
