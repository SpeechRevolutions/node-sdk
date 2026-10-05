/**
 * Captions rendered from words (used by the MCP server's get_transcript srt/vtt),
 * and toDeepgram's 0-based speakers.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { renderCaptions, buildCues } from "../dist/esm/captions.js";
import { parseTranscript } from "../dist/esm/index.js";

const w = (word, start, end, speaker = "SPEAKER_1") => ({ word, text: word, start, end, speaker });

describe("captions", () => {
  test("phrases, not one word per cue; split on speaker change", () => {
    const words = [
      w("Hey", 0.0, 0.2), w("Alex.", 0.3, 0.6),
      w("Good", 0.7, 0.9, "SPEAKER_2"), w("morning.", 1.0, 1.4, "SPEAKER_2"),
    ];
    assert.equal(
      renderCaptions(words, "srt"),
      "1\n00:00:00,000 --> 00:00:00,600\nSPEAKER_1: Hey Alex.\n\n" +
        "2\n00:00:00,700 --> 00:00:01,400\nSPEAKER_2: Good morning.\n",
    );
    assert.equal(
      renderCaptions(words, "vtt"),
      "WEBVTT\n\n00:00:00.000 --> 00:00:00.600\nSPEAKER_1: Hey Alex.\n\n" +
        "00:00:00.700 --> 00:00:01.400\nSPEAKER_2: Good morning.\n",
    );
  });

  test("no speaker prefix without speakers", () => {
    const words = [{ word: "Hi", start: 1, end: 1.5 }];
    assert.equal(renderCaptions(words, "srt"), "1\n00:00:01,000 --> 00:00:01,500\nHi\n");
  });

  test("at most 2 lines of 42 characters, prefix not counted", () => {
    const words = [];
    for (let i = 0; i < 40; i++) words.push(w(`word${i}`, i * 0.1, i * 0.1 + 0.05));
    for (const cue of buildCues(words)) {
      assert.ok(cue.lines.length <= 2);
      for (const line of cue.lines) assert.ok(line.length <= 42, line);
    }
    const first = renderCaptions(words, "srt").split("\n")[2];
    assert.ok(first.startsWith("SPEAKER_1: "));
    assert.ok(first.length > 42 && first.length - "SPEAKER_1: ".length <= 42);
  });

  test("a cue lasts at most 7 s", () => {
    const words = [];
    for (let i = 0; i < 10; i++) words.push(w("a", i * 0.9, i * 0.9 + 0.5));
    for (const cue of buildCues(words)) assert.ok(cue.end - cue.start <= 7.0);
    assert.equal(buildCues(words).length, 2);
  });

  test("a gap over 1 s starts a new cue", () => {
    const cues = buildCues([w("one", 0, 0.3), w("two", 1.5, 1.8)]);
    assert.equal(cues.length, 2);
    assert.equal(buildCues([w("one", 0, 0.3), w("two", 1.3, 1.6)]).length, 1);
  });

  test("sentence end breaks only a cue already >= 1 s long", () => {
    assert.equal(buildCues([w("Yes.", 0, 0.4), w("Go", 0.5, 0.7)]).length, 1);
    assert.equal(buildCues([w("Well", 0, 0.5), w("yes.", 0.6, 1.0), w("Go", 1.1, 1.3)]).length, 2);
  });

  test("hours and millisecond rounding", () => {
    const srt = renderCaptions([{ word: "x", start: 3723.4567, end: 3724.0 }], "srt");
    assert.match(srt, /01:02:03,457 --> 01:02:04,000/);
  });
});

describe("toDeepgram", () => {
  test("speakers are 0-based like Deepgram", () => {
    const t = parseTranscript({
      jobId: "j",
      outputType: "json",
      content: new TextEncoder().encode(
        JSON.stringify({
          words: [
            { word: "Hi.", start: 0, end: 1, speaker: "SPEAKER_1" },
            { word: "Yo.", start: 1, end: 2, speaker: "SPEAKER_2" },
          ],
        }),
      ),
    });
    const dg = t.toDeepgram();
    assert.deepEqual(dg.results.channels[0].alternatives[0].words.map((x) => x.speaker), [0, 1]);
    assert.deepEqual(dg.results.utterances.map((u) => u.speaker), [0, 1]);
    assert.equal(dg.results.channels[0].alternatives[0].transcript, "Hi. Yo.");
  });
});
