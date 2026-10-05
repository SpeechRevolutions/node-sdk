/**
 * `requestInit` reaches every request (API, storage, stream), without carrying
 * credentials to storage; and a finished job always reports 100% progress.
 *
 * Run: npm test   (no network — fetch is stubbed)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SpeechRevolutions } from "../dist/esm/index.js";

const RESULT = JSON.stringify({
  words: [{ word: "Hi.", start: 0, end: 0.4, speaker: "SPEAKER_1" }],
});

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that serves the whole upload -> stream -> download flow and records each call. */
function makeFetch({ multipart = true, sse = "event: completed\ndata: {}\n\n" } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.pathname === "/api/v1/upload/multipart/create") {
      if (!multipart) return json(404, { detail: "off" });
      return json(200, {
        job_id: "j1",
        download_url: "https://s3.test/result",
        part_size: 1024,
        parts: [{ part_number: 1, url: "https://s3.test/part1" }],
      });
    }
    if (u.pathname === "/api/v1/upload") {
      return json(200, {
        job_id: "j1",
        upload_url: "https://s3.test/single",
        download_url: "https://s3.test/result",
      });
    }
    if (u.pathname.endsWith("/stream")) {
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (u.host === "s3.test" && init.method === "PUT") {
      return new Response(null, { status: 200, headers: { ETag: '"e"' } });
    }
    if (u.host === "s3.test") return new Response(RESULT, { status: 200 });
    return json(200, {});
  };
  return { fetchFn, calls };
}

const DISPATCHER = { marker: "proxy-dispatcher" };
const AUDIO = new Uint8Array([1, 2, 3, 4]);

function client(fetchFn, extra = {}) {
  return new SpeechRevolutions({
    apiKey: "secret-key",
    baseUrl: "http://api.test",
    fetch: fetchFn,
    retryBackoffMs: 0,
    requestInit: { dispatcher: DISPATCHER, headers: { "X-Gateway-Auth": "gw" } },
    ...extra,
  });
}

function headersOf(init) {
  return new Headers(init.headers ?? {});
}

describe("requestInit", () => {
  for (const multipart of [true, false]) {
    for (const withProgress of [false, true]) {
      test(`reaches every call (multipart=${multipart}, upload progress=${withProgress})`, async () => {
        const { fetchFn, calls } = makeFetch({ multipart });
        const opts = withProgress ? { onUploadProgress: () => {} } : {};
        const r = await client(fetchFn).transcribe(AUDIO, opts);
        assert.equal(r.text, "Hi.");

        const storage = calls.filter((c) => new URL(c.url).host === "s3.test");
        const stream = calls.filter((c) => c.url.endsWith("/stream"));
        assert.ok(storage.some((c) => c.init.method === "PUT"), "an upload PUT was made");
        assert.ok(storage.some((c) => c.init.method !== "PUT"), "a download was made");
        assert.equal(stream.length, 1);

        for (const c of calls) {
          assert.equal(c.init.dispatcher, DISPATCHER, `no dispatcher on ${c.init.method ?? "GET"} ${c.url}`);
        }
        // Storage URLs are presigned for a third party: never the API key, never caller headers.
        for (const c of storage) {
          const h = headersOf(c.init);
          assert.equal(h.get("x-api-key"), null, `API key sent to ${c.url}`);
          assert.equal(h.get("x-gateway-auth"), null, `caller header sent to ${c.url}`);
        }
        assert.equal(headersOf(stream[0].init).get("x-api-key"), "secret-key");
      });
    }
  }

  test("reaches the polling fallback's download", async () => {
    const { fetchFn, calls } = makeFetch();
    const c = client(fetchFn);
    // waitPoll is the path taken once the stream gives up.
    await c["waitPoll"]("j1", "https://s3.test/result", 5);
    const dl = calls.filter((x) => new URL(x.url).host === "s3.test");
    assert.equal(dl.length, 1);
    assert.equal(dl[0].init.dispatcher, DISPATCHER);
    assert.equal(headersOf(dl[0].init).get("x-api-key"), null);
  });

  test("the caller's abort signal cancels the stream wait", async () => {
    const controller = new AbortController();
    const fetchFn = async (url, init = {}) => {
      if (url.endsWith("/stream")) {
        return new Promise((_, reject) =>
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        );
      }
      return makeFetch().fetchFn(url, init);
    };
    const c = new SpeechRevolutions({
      apiKey: "k",
      baseUrl: "http://api.test",
      fetch: fetchFn,
      requestInit: { signal: controller.signal },
    });
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await assert.rejects(c.waitForResult("j1", "https://s3.test/result"), /abort/i);
    assert.ok(Date.now() - started < 2000, "abort did not stop the wait promptly");
  });
});

describe("completion progress", () => {
  test("a job that finishes before any progress event still reports 100%", async () => {
    const { fetchFn } = makeFetch();
    const seen = [];
    await client(fetchFn).transcribe(AUDIO, { onProgress: (e) => seen.push(e) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].percent, 100);
    assert.equal(seen[0].step, "completed");
  });

  test("a stream that ends short of 100% is closed out at 100%", async () => {
    const sse =
      'event: progress\ndata: {"completed": 1, "total": 3, "step": "chunk:1"}\n\n' +
      "event: completed\ndata: {}\n\n";
    const { fetchFn } = makeFetch({ sse });
    const seen = [];
    await client(fetchFn).transcribe(AUDIO, {}, (e) => seen.push(e));
    assert.deepEqual(seen.map((e) => Math.round(e.percent)), [33, 100]);
    assert.equal(seen[1].completed, 3);
    assert.equal(seen[1].total, 3);
  });

  test("no duplicate when the stream already reached 100%", async () => {
    const sse =
      'event: progress\ndata: {"completed": 2, "total": 2, "step": "aggregation"}\n\n' +
      "event: completed\ndata: {}\n\n";
    const { fetchFn } = makeFetch({ sse });
    const seen = [];
    await client(fetchFn).transcribe(AUDIO, {}, (e) => seen.push(e));
    assert.deepEqual(seen.map((e) => e.percent), [100]);
  });
});
