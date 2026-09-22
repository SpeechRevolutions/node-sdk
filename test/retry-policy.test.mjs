/**
 * Retry policy, and the duplicate-job hazard it exists to prevent.
 *
 * The rule under test: a request that CREATES a job is retried only when the
 * request provably never reached the server. Every other request retries freely.
 *
 * A regression here is expensive and silent — the customer gets two transcripts
 * and two charges for one file — so these assert attempt COUNTS, not just the
 * final outcome.
 *
 * Run: npm test   (no network, no test framework, Node's built-in runner)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SpeechRevolutions, APIError } from "../dist/esm/index.js";

const OK_BODY = { job_id: "j1", upload_url: "u", download_url: "d" };

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A network failure shaped the way undici reports one. */
function netError(code) {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error(code), { code });
  return err;
}

/**
 * Builds a client whose fetch replays `script` in order. The last entry
 * repeats, so a test asserting "no retry" fails loudly on an extra call.
 */
function makeClient(script, opts = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const item = script[Math.min(calls.length - 1, script.length - 1)];
    if (item instanceof Error) throw item;
    return item();
  };
  const client = new SpeechRevolutions({
    apiKey: "k",
    fetch: fetchFn,
    maxRetries: 3,
    retryBackoffMs: 0,
    ...opts,
  });
  return { client, calls };
}

const ok = () => jsonResponse(200, OK_BODY);
const status = (s) => () => jsonResponse(s, { detail: "x" });

describe("create calls — must not retry on an ambiguous failure", () => {
  for (const s of [500, 502, 503, 504]) {
    test(`does not retry on ${s}`, async () => {
      const { client, calls } = makeClient([status(s)]);
      await assert.rejects(() => client.createUploadJob(1024), APIError);
      assert.equal(calls.length, 1, "a retry here would create a duplicate job");
    });
  }

  test("does not retry on a mid-flight reset", async () => {
    const { client, calls } = makeClient([netError("ECONNRESET")]);
    await assert.rejects(() => client.createUploadJob(1024));
    assert.equal(calls.length, 1);
  });

  test("does not retry on a headers timeout", async () => {
    const { client, calls } = makeClient([netError("UND_ERR_HEADERS_TIMEOUT")]);
    await assert.rejects(() => client.createUploadJob(1024));
    assert.equal(calls.length, 1);
  });

  test("does not retry on an unrecognised network error", async () => {
    const { client, calls } = makeClient([new TypeError("fetch failed")]);
    await assert.rejects(() => client.createUploadJob(1024));
    assert.equal(calls.length, 1, "unknown causes must be treated as ambiguous");
  });
});

describe("create calls — retry when the request provably never landed", () => {
  for (const code of [
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
  ]) {
    test(`retries on ${code}`, async () => {
      const { client, calls } = makeClient([netError(code), ok]);
      const job = await client.createUploadJob(1024);
      assert.equal(job.jobId, "j1");
      assert.equal(calls.length, 2);
    });
  }

  test("retries on 429 — the server refused it outright", async () => {
    const { client, calls } = makeClient([status(429), ok]);
    const job = await client.createUploadJob(1024);
    assert.equal(job.jobId, "j1");
    assert.equal(calls.length, 2);
  });

  test("honours maxRetries", async () => {
    const err = netError("ECONNREFUSED");
    const { client, calls } = makeClient([err], { maxRetries: 2 });
    await assert.rejects(() => client.createUploadJob(1024));
    assert.equal(calls.length, 3); // 1 initial + 2 retries
  });
});

describe("non-create calls keep the permissive behaviour", () => {
  for (const s of [429, 500, 502, 503, 504]) {
    test(`cancelJob retries on ${s}`, async () => {
      const { client, calls } = makeClient([status(s), () => jsonResponse(200, {})]);
      await client.cancelJob("j1");
      assert.equal(calls.length, 2);
    });
  }

  test("cancelJob retries on a mid-flight reset", async () => {
    const { client, calls } = makeClient([netError("ECONNRESET"), () => jsonResponse(200, {})]);
    await client.cancelJob("j1");
    assert.equal(calls.length, 2);
  });

  test("completeUpload is retryable — it acts on an existing job", async () => {
    const { client, calls } = makeClient([status(500), () => jsonResponse(200, {})]);
    await client.completeUpload("j1");
    assert.equal(calls.length, 2);
  });
});

describe("the scenario the policy exists for", () => {
  test("a lost response creates exactly one job", async () => {
    // Server creates the job, then the response is lost to a gateway 502.
    // The SDK must surface the error rather than silently creating a second.
    const { client, calls } = makeClient([status(502), ok]);
    await assert.rejects(() => client.createUploadJob(1024), (err) => {
      assert.ok(err instanceof APIError);
      assert.equal(err.statusCode, 502);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  test("the create request really is the one being guarded", async () => {
    const { client, calls } = makeClient([status(500)]);
    await assert.rejects(() => client.createUploadJob(1024));
    assert.match(calls[0].url, /\/api\/v1\/upload$/);
    assert.equal(calls[0].init.method, "POST");
  });
});

describe("base URL resolution", () => {
  const ENV_KEYS = ["SPEECHREVOLUTIONS_BASE_URL", "STT_BASE_URL"];
  const saved = {};

  test("explicit option wins over the environment", () => {
    process.env.SPEECHREVOLUTIONS_BASE_URL = "https://from-env.example";
    const c = new SpeechRevolutions({ apiKey: "k", baseUrl: "https://explicit.example" });
    assert.equal(c.baseUrl, "https://explicit.example");
    delete process.env.SPEECHREVOLUTIONS_BASE_URL;
  });

  test("falls back to SPEECHREVOLUTIONS_BASE_URL", () => {
    process.env.SPEECHREVOLUTIONS_BASE_URL = "https://staging.example";
    assert.equal(new SpeechRevolutions({ apiKey: "k" }).baseUrl, "https://staging.example");
    delete process.env.SPEECHREVOLUTIONS_BASE_URL;
  });

  // STT_BASE_URL predates the rebrand. Honouring it would let a stale variable
  // silently point the client at the wrong host.
  test("ignores the pre-rebrand STT_BASE_URL", () => {
    delete process.env.SPEECHREVOLUTIONS_BASE_URL;
    process.env.STT_BASE_URL = "https://stale.example";
    assert.equal(new SpeechRevolutions({ apiKey: "k" }).baseUrl, "https://api.speechrevolutions.com");
    delete process.env.STT_BASE_URL;
  });

  test("defaults to production", () => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    assert.equal(new SpeechRevolutions({ apiKey: "k" }).baseUrl, "https://api.speechrevolutions.com");
    for (const k of ENV_KEYS) if (saved[k] !== undefined) process.env[k] = saved[k];
  });

  test("a trailing slash is stripped", () => {
    process.env.SPEECHREVOLUTIONS_BASE_URL = "https://x.example/";
    assert.equal(new SpeechRevolutions({ apiKey: "k" }).baseUrl, "https://x.example");
    delete process.env.SPEECHREVOLUTIONS_BASE_URL;
  });
});
