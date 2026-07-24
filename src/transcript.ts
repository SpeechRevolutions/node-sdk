/**
 * Transcript models + Deepgram / AssemblyAI-style adapters.
 */

export interface Word {
  word: string;
  text: string;
  start?: number;
  end?: number;
  speaker?: string;
  confidence?: number;
  language?: string;
}

/** A contiguous time range spoken in a single detected language. */
export interface LanguageSegment {
  start: number;
  end: number;
  language: string;
}

export interface Utterance {
  text: string;
  transcript: string;
  speaker?: string;
  start?: number;
  end?: number;
  words: Word[];
  confidence?: number;
}

export interface Transcript {
  jobId: string;
  outputType: string;
  content: Uint8Array;
  downloadUrl: string;
  words: Word[];
  utterances: Utterance[];
  languages: LanguageSegment[];
  raw: Record<string, unknown> | null;
  /** Full transcript text (AssemblyAI / ElevenLabs-style). */
  readonly text: string;
  /** Deepgram-compatible alias for text. */
  readonly transcript: string;
  /** Write raw content to disk (Node). Appends `.outputType` if path has no extension. */
  save(path: string): Promise<string>;
  toDict(): Record<string, unknown>;
  toDeepgram(): Record<string, unknown>;
}

function joinWords(words: Word[]): string {
  const parts: string[] = [];
  for (const w of words) {
    const token = w.word;
    if (!token) continue;
    if (parts.length && ".,!?;:%)]}'\"".includes(token[0]!)) {
      parts[parts.length - 1] = parts[parts.length - 1]! + token;
    } else {
      parts.push(token);
    }
  }
  return parts.join(" ");
}

function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseWord(data: Record<string, unknown>): Word {
  const word = String(data.word ?? data.text ?? "");
  return {
    word,
    text: word,
    start: asNumber(data.start),
    end: asNumber(data.end),
    speaker: data.speaker != null ? String(data.speaker) : undefined,
    confidence: asNumber(data.confidence),
    language: data.language != null ? String(data.language) : undefined,
  };
}

function parseLanguageSegment(data: Record<string, unknown>): LanguageSegment {
  return {
    start: asNumber(data.start) ?? 0,
    end: asNumber(data.end) ?? 0,
    language: String(data.language ?? ""),
  };
}

function utteranceFromGroup(group: Word[]): Utterance {
  const text = joinWords(group);
  return {
    text,
    transcript: text,
    speaker: group[0]?.speaker,
    start: group[0]?.start,
    end: group[group.length - 1]?.end,
    words: group,
  };
}

function utterancesFromWords(words: Word[]): Utterance[] {
  if (!words.length) return [];
  if (words.every((w) => w.speaker == null)) {
    return [utteranceFromGroup(words)];
  }
  const out: Utterance[] = [];
  let current: Word[] = [words[0]!];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.speaker === current[0]!.speaker) current.push(w);
    else {
      out.push(utteranceFromGroup(current));
      current = [w];
    }
  }
  out.push(utteranceFromGroup(current));
  return out;
}

function speakerIndex(speaker?: string): number | string | undefined {
  if (speaker == null) return undefined;
  if (speaker.toUpperCase().startsWith("SPEAKER_")) {
    const n = Number(speaker.split("_")[1]);
    return Number.isFinite(n) ? n : speaker;
  }
  if (speaker.length === 1 && /[a-zA-Z]/.test(speaker)) {
    return speaker.toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
  }
  const n = Number(speaker);
  return Number.isFinite(n) ? n : speaker;
}

export function parseTranscript(opts: {
  jobId: string;
  content: Uint8Array;
  outputType: string;
  downloadUrl?: string;
}): Transcript {
  const { jobId, content, outputType } = opts;
  const downloadUrl = opts.downloadUrl ?? "";

  if (outputType !== "json") {
    let text = "";
    try {
      text = new TextDecoder().decode(content);
    } catch {
      text = "";
    }
    return makeTranscript({
      jobId,
      outputType,
      content,
      downloadUrl,
      words: [],
      utterances: [],
      languages: [],
      raw: null,
      text,
    });
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder().decode(content)) as Record<string, unknown>;
  } catch {
    return makeTranscript({
      jobId,
      outputType,
      content,
      downloadUrl,
      words: [],
      utterances: [],
      languages: [],
      raw: null,
      text: "",
    });
  }

  const words = Array.isArray(raw.words)
    ? (raw.words as Record<string, unknown>[]).map(parseWord)
    : [];
  const utterances = utterancesFromWords(words);
  const languages = Array.isArray(raw.languages)
    ? (raw.languages as Record<string, unknown>[]).map(parseLanguageSegment)
    : [];
  const text = joinWords(words);

  return makeTranscript({
    jobId,
    outputType,
    content,
    downloadUrl,
    words,
    utterances,
    languages,
    raw,
    text,
  });
}

function makeTranscript(args: {
  jobId: string;
  outputType: string;
  content: Uint8Array;
  downloadUrl: string;
  words: Word[];
  utterances: Utterance[];
  languages: LanguageSegment[];
  raw: Record<string, unknown> | null;
  text: string;
}): Transcript {
  const textValue = args.text;
  return {
    jobId: args.jobId,
    outputType: args.outputType,
    content: args.content,
    downloadUrl: args.downloadUrl,
    words: args.words,
    utterances: args.utterances,
    languages: args.languages,
    raw: args.raw,
    get text() {
      return textValue;
    },
    get transcript() {
      return textValue;
    },
    async save(path: string): Promise<string> {
      const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
      const out = name.includes(".") ? path : `${path}.${args.outputType}`;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(out, args.content);
      return out;
    },
    toDict() {
      const dict: Record<string, unknown> = {
        id: args.jobId,
        status: "completed",
        text: textValue,
        words: args.words,
        utterances: args.utterances,
        output_type: args.outputType,
      };
      if (args.languages.length) dict.languages = args.languages;
      return dict;
    },
    toDeepgram() {
      return {
        metadata: { request_id: args.jobId, channels: 1 },
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: textValue,
                  confidence: 1.0,
                  words: args.words.map((w) => ({
                    word: w.word.replace(/[.,!?;:]+$/g, "").toLowerCase(),
                    punctuated_word: w.word,
                    start: w.start,
                    end: w.end,
                    speaker: speakerIndex(w.speaker),
                  })),
                },
              ],
            },
          ],
          utterances: args.utterances.map((u) => ({
            transcript: u.text,
            channel: 0,
            start: u.start,
            end: u.end,
            speaker: speakerIndex(u.speaker),
            words: u.words.map((w) => ({
              word: w.word,
              punctuated_word: w.word,
              start: w.start,
              end: w.end,
              speaker: speakerIndex(w.speaker),
            })),
          })),
        },
      };
    },
  };
}
