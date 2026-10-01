/**
 * Job-creating request bodies carry the optional fields only when set.
 *
 * `language` and `custom_vocabulary` are omitted when unset, so an older server
 * sees a byte-identical request. Every path that creates a job is covered: the
 * multipart default, the single-shot fallback, a remote URL, and the public
 * `createUploadJob`.
 *
 * Run: npm test   (no network — fetch is stubbed)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SpeechRevolutions } from "../dist/esm/index.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A client whose fetch answers the upload endpoints and records every JSON body
 * sent to a job-creating route. `multipartStatus: 404` forces the fallback.
 */
function makeClient({ multipartStatus = 200 } = {}) {
  const creates = [];
  const fetchFn = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/v1/upload/multipart/create") {
      creates.push({ path, body: JSON.parse(init.body) });
      if (multipartStatus !== 200) return jsonResponse(multipartStatus, { detail: "off" });
      return jsonResponse(200, {
        job_id: "jm",
        download_url: "https://dl/jm",
        part_size: 1024,
        parts: [{ part_number: 1, url: "https://s3/part1" }],
      });
    }
    if (path === "/api/v1/upload") {
      creates.push({ path, body: JSON.parse(init.body) });
      return jsonResponse(200, {
        job_id: "js",
        upload_url: "https://s3/single",
        download_url: "https://dl/js",
      });
    }
    if (url.startsWith("https://s3/")) {
      return new Response(null, { status: 200, headers: { ETag: '"etag"' } });
    }
    return jsonResponse(200, {});
  };
  const client = new SpeechRevolutions({
    apiKey: "k",
    baseUrl: "http://api.test",
    fetch: fetchFn,
    retryBackoffMs: 0,
  });
  return { client, creates };
}

const AUDIO = new Uint8Array([1, 2, 3, 4]);

describe("language", () => {
  test("multipart create carries language when set", async () => {
    const { client, creates } = makeClient();
    assert.equal(await client.submit(AUDIO, { language: "ru" }), "jm");
    assert.equal(creates.length, 1);
    assert.equal(creates[0].path, "/api/v1/upload/multipart/create");
    assert.equal(creates[0].body.language, "ru");
  });

  test("the single-shot fallback carries language too", async () => {
    const { client, creates } = makeClient({ multipartStatus: 404 });
    assert.equal(await client.submit(AUDIO, { language: "ru" }), "js");
    assert.deepEqual(
      creates.map((c) => c.path),
      ["/api/v1/upload/multipart/create", "/api/v1/upload"],
    );
    for (const c of creates) assert.equal(c.body.language, "ru");
  });

  test("a remote URL job carries language", async () => {
    const { client, creates } = makeClient();
    await client.submit("https://example.com/a.mp3", { language: "en" });
    assert.equal(creates[0].path, "/api/v1/upload");
    assert.equal(creates[0].body.language, "en");
    assert.equal(creates[0].body.audio_url, "https://example.com/a.mp3");
  });

  test("createUploadJob carries language", async () => {
    const { client, creates } = makeClient();
    await client.createUploadJob(4, { language: "de" });
    assert.equal(creates[0].body.language, "de");
  });

  test("the code is passed through unvalidated", async () => {
    const { client, creates } = makeClient();
    await client.submit(AUDIO, { language: "auto" });
    assert.equal(creates[0].body.language, "auto");
  });

  test("omitted from every path when unset", async () => {
    for (const multipartStatus of [200, 404]) {
      const { client, creates } = makeClient({ multipartStatus });
      await client.submit(AUDIO);
      await client.submit("https://example.com/a.mp3");
      assert.ok(creates.length >= 2);
      for (const c of creates) assert.ok(!("language" in c.body), `${c.path} sent language`);
    }
  });
});

describe("customVocabulary", () => {
  test("sent as custom_vocabulary when set", async () => {
    const { client, creates } = makeClient({ multipartStatus: 404 });
    await client.submit(AUDIO, { customVocabulary: ["Kyiv"] });
    for (const c of creates) assert.deepEqual(c.body.custom_vocabulary, ["Kyiv"]);
  });

  test("omitted when unset", async () => {
    const { client, creates } = makeClient({ multipartStatus: 404 });
    await client.submit(AUDIO);
    for (const c of creates) assert.ok(!("custom_vocabulary" in c.body));
  });
});
