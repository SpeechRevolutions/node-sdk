/**
 * SRT / WebVTT captions built from a transcript's words.
 *
 * The rules match the service's own caption output, so a caption rendered here
 * and one downloaded with `outputType: "srt"` read the same:
 *
 * - a cue never spans two speakers;
 * - a new cue starts when the speaker changes, when the text would no longer fit
 *   in 2 lines of 42 characters, when the cue would last more than 7 s, or when
 *   the gap to the next word is over 1 s;
 * - after a word ending in . ? or ! a new cue starts once the cue is >= 1 s long;
 * - with speaker labels, the first line starts with "SPEAKER_n: " (not counted
 *   toward the 42 characters).
 */

import type { Word } from "./transcript.js";

const MAX_LINE_CHARS = 42;
const MAX_LINES = 2;
const MAX_CUE_SECONDS = 7.0;
const MAX_GAP_SECONDS = 1.0;
const MIN_SENTENCE_CUE_SECONDS = 1.0;

interface TimedWord {
  text: string;
  start: number;
  end: number;
  speaker?: string;
}

interface Cue {
  start: number;
  end: number;
  speaker?: string;
  lines: string[];
}

/** Greedy wrap into lines of at most `MAX_LINE_CHARS` (a longer word gets its own line). */
function wrap(tokens: string[]): string[] {
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    if (!line) line = token;
    else if (line.length + 1 + token.length <= MAX_LINE_CHARS) line += ` ${token}`;
    else {
      lines.push(line);
      line = token;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Words with timings, with a token that starts with punctuation folded into the one before. */
function timedWords(words: Word[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const w of words) {
    const text = (w.word ?? "").trim();
    if (!text || w.start === undefined || w.end === undefined) continue;
    const prev = out[out.length - 1];
    if (prev && prev.speaker === w.speaker && ".,!?;:%)]}".includes(text[0]!)) {
      prev.text += text;
      prev.end = w.end;
      continue;
    }
    out.push({ text, start: w.start, end: w.end, speaker: w.speaker });
  }
  return out;
}

export function buildCues(words: Word[]): Cue[] {
  const cues: Cue[] = [];
  let current: TimedWord[] = [];

  const flush = () => {
    if (!current.length) return;
    cues.push({
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      speaker: current[0]!.speaker,
      lines: wrap(current.map((w) => w.text)),
    });
    current = [];
  };

  for (const w of timedWords(words)) {
    if (current.length) {
      const first = current[0]!;
      const prev = current[current.length - 1]!;
      const breakHere =
        w.speaker !== first.speaker ||
        wrap([...current.map((c) => c.text), w.text]).length > MAX_LINES ||
        w.end - first.start > MAX_CUE_SECONDS ||
        w.start - prev.end > MAX_GAP_SECONDS ||
        (/[.?!]$/.test(prev.text) && prev.end - first.start >= MIN_SENTENCE_CUE_SECONDS);
      if (breakHere) flush();
    }
    current.push(w);
  }
  flush();
  return cues;
}

function timestamp(seconds: number, sep: "," | "."): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

function cueText(cue: Cue, speakerLabels: boolean): string {
  const lines = [...cue.lines];
  if (speakerLabels && cue.speaker) lines[0] = `${cue.speaker}: ${lines[0]}`;
  return lines.join("\n");
}

/**
 * Render words as SRT or WebVTT. Speaker labels are shown when the words carry
 * speakers, unless `speakerLabels` is false.
 */
export function renderCaptions(
  words: Word[],
  format: "srt" | "vtt",
  opts: { speakerLabels?: boolean } = {},
): string {
  const cues = buildCues(words);
  const labels = opts.speakerLabels ?? words.some((w) => w.speaker != null);
  if (format === "vtt") {
    const body = cues
      .map((c) => `${timestamp(c.start, ".")} --> ${timestamp(c.end, ".")}\n${cueText(c, labels)}`)
      .join("\n\n");
    return `WEBVTT\n\n${body}${body ? "\n" : ""}`;
  }
  return cues
    .map(
      (c, i) =>
        `${i + 1}\n${timestamp(c.start, ",")} --> ${timestamp(c.end, ",")}\n${cueText(c, labels)}\n`,
    )
    .join("\n");
}
