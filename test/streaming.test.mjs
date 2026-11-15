// Streaming event mapping + session.update (src/streaming.ts). Live check: test/live.test.mjs style, run by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toEvent, sessionUpdate } from "../dist/esm/index.js";

test("event mapping", () => {
  const p = toEvent({ type: "transcription.partial", index: 2, text: "hel", stable: 1, audio_s: 3.5 });
  assert.deepEqual([p.type, p.index, p.text, p.stable, p.start], ["partial", 2, "hel", 1, 3.5]);
  assert.equal(toEvent({ type: "final.revised", index: 2, text: "Hi!" }).type, "revision");
  assert.equal(toEvent({ type: "error", error: "at capacity" }).text, "at capacity");
  assert.equal(toEvent({ type: "error", code: "x", message: "v2 style" }).text, "v2 style");
});

test("session.update", () => {
  assert.deepEqual(sessionUpdate({ language: "auto", vocabulary: ["Acme"], endUserId: "u1", turnThreshold: 0.6 }),
    { type: "session.update", vocabulary: ["Acme"], end_user_id: "u1", turn_detection: { threshold: 0.6 } });
  assert.deepEqual(sessionUpdate({ language: "ja" }), { type: "session.update", language: "ja" });
});
