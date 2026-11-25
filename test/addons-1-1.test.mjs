/**
 * 1.1.0 add-on options: what is sent, and what comes back.
 *
 * Run: npm test   (no network — fetch is stubbed, streaming uses a local fake server)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

import { PII_POLICIES, SpeechRevolutions, parseTranscript } from "../dist/esm/index.js";
import { sessionUpdate } from "../dist/esm/streaming.js";

const ADDON_FIELDS = [
  "auto_chapters",
  "known_speakers",
  "redact_pii",
  "redact_pii_policies",
  "redact_pii_sub",
  "entity_detection",
];

/** A client whose fetch records every job-creating body. `multipartStatus: 404` forces the fallback. */
function makeClient({ multipartStatus = 200 } = {}) {
  const creates = [];
  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/v1/upload/multipart/create") {
      creates.push({ path, body: JSON.parse(init.body) });
      if (multipartStatus !== 200) return json(multipartStatus, { detail: "off" });
      return json(200, {
        job_id: "jm",
        download_url: "https://dl/jm",
        part_size: 1024,
        parts: [{ part_number: 1, url: "https://s3/part1" }],
      });
    }
    if (path === "/api/v1/upload") {
      creates.push({ path, body: JSON.parse(init.body) });
      return json(200, { job_id: "js", upload_url: "https://s3/single", download_url: "https://dl/js" });
    }
    if (url.startsWith("https://s3/")) return new Response(null, { status: 200, headers: { ETag: '"etag"' } });
    return json(200, {});
  };
  const client = new SpeechRevolutions({ apiKey: "k", baseUrl: "http://api.test", fetch: fetchFn, retryBackoffMs: 0 });
  return { client, creates };
}

const AUDIO = new Uint8Array([1, 2, 3, 4]);

test("add-on options are sent only when set", async () => {
  for (const multipartStatus of [200, 404]) {
    const { client, creates } = makeClient({ multipartStatus });
    await client.submit(AUDIO);
    await client.submit("https://example.com/a.mp3");
    for (const c of creates) {
      for (const k of ADDON_FIELDS) assert.ok(!(k in c.body), `${c.path} sent ${k}`);
      assert.equal(c.body.speaker_labels, false); // explicit, off by default
    }
  }

  const { client, creates } = makeClient({ multipartStatus: 404 });
  await client.submit(AUDIO, {
    autoChapters: true,
    knownSpeakers: ["Agent", "Customer"],
    redactPii: true,
    redactPiiPolicies: ["person_name", "phone_number"],
    redactPiiSub: "hash",
    entityDetection: true,
    speakerLabels: true,
  });
  await client.submit("https://example.com/a.mp3", { redactPii: true, entityDetection: true });
  assert.equal(creates.length, 3); // multipart (refused), single-shot, remote URL
  for (const p of creates.slice(0, 2).map((c) => c.body)) {
    assert.equal(p.auto_chapters, true);
    assert.deepEqual(p.known_speakers, ["Agent", "Customer"]);
    assert.equal(p.redact_pii, true);
    assert.deepEqual(p.redact_pii_policies, ["person_name", "phone_number"]);
    assert.equal(p.redact_pii_sub, "hash");
    assert.equal(p.entity_detection, true);
    assert.equal(p.speaker_labels, true);
  }
  assert.equal(creates[2].body.redact_pii, true);
  assert.equal(creates[2].body.entity_detection, true);

  // policies and substitution need redactPii
  const off = makeClient();
  await off.client.createUploadJob(4, { redactPiiPolicies: ["date"], redactPiiSub: "hash" });
  assert.ok(!("redact_pii_policies" in off.creates[0].body));
  assert.ok(!("redact_pii_sub" in off.creates[0].body));
  assert.ok(!("redact_pii" in off.creates[0].body));

  assert.ok(PII_POLICIES.includes("person_name"));
  assert.equal(PII_POLICIES.length, 12);
});

test("transcript parses chapters, entities, speaker names and PII status", () => {
  const raw = {
    words: [{ word: "Hi.", start: 0.0, end: 0.4, speaker: "SPEAKER_1" }],
    chapters: [{ start: 0.0, end: 0.4, headline: "Greeting", gist: "Hello." }],
    entities: [{ entity_type: "person_name", text: "[PERSON_NAME]", start: 0.0, end: 0.4 }],
    speaker_names: { SPEAKER_1: "Agent" },
    pii_status: "patterns_only",
  };
  const t = parseTranscript({ jobId: "j", content: new TextEncoder().encode(JSON.stringify(raw)), outputType: "json" });
  assert.equal(t.chapters[0].headline, "Greeting");
  assert.equal(t.chapters[0].start, 0);
  assert.equal(t.entities[0].entityType, "person_name");
  assert.equal(t.entities[0].text, "[PERSON_NAME]");
  assert.deepEqual(t.speakerNames, { SPEAKER_1: "Agent" });
  assert.equal(t.piiStatus, "patterns_only");
  const d = t.toDict();
  assert.equal(d.chapters[0].gist, "Hello.");
  assert.equal(d.entities[0].entity_type, "person_name");
  assert.equal(d.speaker_names.SPEAKER_1, "Agent");
  assert.equal(d.pii_status, "patterns_only");

  const plain = parseTranscript({ jobId: "j", content: new TextEncoder().encode(JSON.stringify({ words: [] })), outputType: "json" });
  assert.deepEqual(plain.chapters, []);
  assert.deepEqual(plain.entities, []);
  assert.deepEqual(plain.speakerNames, {});
  assert.equal(plain.piiStatus, undefined);
  const pd = plain.toDict();
  for (const k of ["chapters", "entities", "speaker_names", "pii_status"]) assert.ok(!(k in pd), k);
});

test("streaming options reach session.update", () => {
  const m = sessionUpdate({
    language: "en",
    redactPii: true,
    redactPiiSub: "hash",
    includePartials: true,
    voiceprint: "vp1.x",
    speakerPolicy: "strict",
  });
  assert.equal(m.redact_pii, true);
  assert.equal(m.redact_pii_sub, "hash");
  assert.equal(m.include_partials, true);
  assert.equal(m.voiceprint, "vp1.x");
  assert.equal(m.speaker_policy, "strict");
  assert.ok(!("capture_voiceprint" in m));
  assert.ok(!("redact_pii_policies" in m));

  const plain = sessionUpdate({});
  for (const k of ["redact_pii", "include_partials", "voiceprint", "capture_voiceprint", "speaker_policy"]) {
    assert.ok(!(k in plain), k);
  }
  // policies / substitution need redactPii; capture is sent as true
  const noPii = sessionUpdate({ redactPiiPolicies: ["date"], redactPiiSub: "hash", captureVoiceprint: true });
  assert.ok(!("redact_pii_policies" in noPii) && !("redact_pii_sub" in noPii));
  assert.equal(noPii.capture_voiceprint, true);
  assert.deepEqual(sessionUpdate({ redactPii: true, redactPiiPolicies: ["date"] }).redact_pii_policies, ["date"]);
});

test("stream events carry active / piiStatus; the result carries the voiceprint", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const got = [];
  wss.on("connection", (ws) => {
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      got.push(m);
      if (m.type === "input_audio_buffer.commit" && m.final) {
        ws.send(JSON.stringify({ type: "voice_focus", active: true }));
        ws.send(
          JSON.stringify({ type: "final", index: 0, text: "[PERSON_NAME]", start: 0, end: 1, pii_status: "patterns_only" }),
        );
        ws.send(
          JSON.stringify({
            type: "transcription.done",
            text: "[PERSON_NAME]",
            voiceprint: "vp1.sealed",
            voiceprint_quality: { score: 0.9, ok: true, reasons: [] },
          }),
        );
      }
    });
    ws.send(JSON.stringify({ type: "session.created", job_id: "job-vf" }));
  });
  const { port } = wss.address();
  const events = [];
  const client = new SpeechRevolutions({ apiKey: "k", baseUrl: `http://127.0.0.1:${port}` });
  const session = await client.stream({
    language: "en",
    redactPii: true,
    captureVoiceprint: true,
    onEvent: (e) => events.push(e),
  });
  session.sendAudio(new Uint8Array(32 * 200));
  const result = await session.finish({ timeoutMs: 5000 });
  await new Promise((r) => wss.close(r));

  assert.equal(got[0].type, "session.update");
  assert.equal(got[0].redact_pii, true);
  assert.equal(got[0].capture_voiceprint, true);
  const vf = events.find((e) => e.type === "voice_focus");
  assert.equal(vf.active, true);
  assert.equal(events.find((e) => e.type === "final").piiStatus, "patterns_only");
  assert.equal(result.voiceprint, "vp1.sealed");
  assert.deepEqual(result.voiceprintQuality, { score: 0.9, ok: true, reasons: [] });
  assert.equal(result.text, "[PERSON_NAME]");
});
