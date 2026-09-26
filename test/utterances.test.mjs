// Utterances are whole speaker turns, in time order, and never lose a word — even when the
// service's diarization list is grouped by speaker, split at pauses, and misses a word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript } from "../dist/esm/transcript.js";

test("utterances are whole turns in order and keep every word", () => {
  const raw = {
    words: [
      { word: "Why,", start: 0.4, end: 0.7, speaker: "SPEAKER_1" },
      { word: "my", start: 0.8, end: 0.9, speaker: "SPEAKER_1" },
      { word: "dear?", start: 3.5, end: 3.9, speaker: "SPEAKER_1" },
      { word: "She", start: 5.0, end: 5.2, speaker: "SPEAKER_2" },
      { word: "sighed.", start: 5.3, end: 5.8, speaker: "SPEAKER_2" },
      { word: "Well.", start: 6.5, end: 6.9, speaker: "SPEAKER_1" },
    ],
    diarization: [
      { start: 0.4, end: 0.9, speaker: "SPEAKER_1" },
      { start: 6.5, end: 6.9, speaker: "SPEAKER_1" },
      { start: 5.0, end: 5.8, speaker: "SPEAKER_2" },
    ],
  };
  const t = parseTranscript({
    jobId: "j",
    content: new TextEncoder().encode(JSON.stringify(raw)),
    outputType: "json",
  });
  assert.deepEqual(
    t.utterances.map((u) => [u.speaker, u.text]),
    [
      ["SPEAKER_1", "Why, my dear?"],
      ["SPEAKER_2", "She sighed."],
      ["SPEAKER_1", "Well."],
    ],
  );
});
