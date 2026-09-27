/**
 * The tools this MCP server exposes, and the judgement encoded in them.
 *
 * Tool descriptions are prompt, not documentation. A model reads them to decide which tool
 * to call and with what, so each one says when to reach for it AND when not to — the common
 * failure here is a model picking the synchronous path for a two-hour recording and blocking
 * the conversation until it times out.
 *
 * Every tool returns text. Transcripts come back as readable prose with speaker labels rather
 * than the raw JSON payload: the caller is a language model, and handing it 40,000 words of
 * word-level JSON burns the context it needs to actually answer the question. The structured
 * detail stays one `get_transcript` call away with `format: "json"`.
 */

import type { SpeechRevolutionsClient } from "../client.js";
import type { Transcript } from "../transcript.js";
import type { OutputType, TranscribeOptions } from "../types.js";
import type { ToolDefinition, ToolResult } from "./protocol.js";

/**
 * Files at or below this go through the synchronous path; anything larger is submitted as a
 * job. 25 MB is roughly half an hour of typical speech, which is about as long as a caller
 * should wait inside one tool call.
 */
const SYNC_LIMIT_BYTES = 25 * 1024 * 1024;

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

/** Options shared by both transcription tools, so their schemas cannot drift. */
const TRANSCRIPTION_PROPERTIES = {
  speaker_labels: {
    type: "boolean",
    description:
      "Label each utterance with the speaker who said it. Included in the price, so leave it on unless the audio is known to be a single speaker.",
    default: true,
  },
  word_timestamps: {
    type: "boolean",
    description: "Return a start and end time for every word. Included in the price.",
    default: true,
  },
  custom_vocabulary: {
    type: "array",
    items: { type: "string" },
    description:
      "Names, jargon or product terms that appear in the audio. Use it for words a general model would get wrong — surnames, drug names, internal codenames.",
  },
} as const;

function transcriptionOptions(args: Record<string, unknown>): TranscribeOptions {
  return {
    speakerLabels: args.speaker_labels !== false,
    wordTimestamps: args.word_timestamps !== false,
    customVocabulary: Array.isArray(args.custom_vocabulary)
      ? (args.custom_vocabulary as unknown[]).map(String)
      : undefined,
  };
}

/** A transcript as a model should receive it: who spoke, in order, as prose. */
function renderTranscript(transcript: Transcript, maxChars: number): string {
  const body = transcript.utterances.length
    ? transcript.utterances
        .map((u) => {
          const who = u.speaker ? `${u.speaker}: ` : "";
          const at =
            typeof u.start === "number" ? `[${formatTimestamp(u.start)}] ` : "";
          return `${at}${who}${u.text}`.trim();
        })
        .join("\n")
    : transcript.text;

  const languages = [...new Set(transcript.languages.map((l) => l.language).filter(Boolean))];
  const header = [
    `Job: ${transcript.jobId}`,
    languages.length ? `Detected language: ${languages.join(", ")}` : null,
    transcript.utterances.length
      ? `Speakers: ${new Set(transcript.utterances.map((u) => u.speaker).filter(Boolean)).size}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (body.length <= maxChars) return `${header}\n\n${body}`;
  // Truncating is better than blowing the caller's context, but it must SAY so — a silently
  // shortened transcript is one a model will happily summarise as if it were complete.
  return (
    `${header}\n\n${body.slice(0, maxChars)}\n\n` +
    `[Truncated at ${maxChars.toLocaleString()} characters of ${body.length.toLocaleString()}. ` +
    `Call get_transcript with job_id "${transcript.jobId}" and a larger max_characters, or format "json", for the rest.]`
  );
}

function formatTimestamp(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function buildTools(client: SpeechRevolutionsClient): ToolDefinition[] {
  return [
    {
      name: "transcribe_audio",
      description:
        "Transcribe a local audio or video file, or a public URL, and return the text with speaker labels. " +
        "Waits for the result, so use it for short recordings — anything under about half an hour. " +
        "For longer files call submit_transcription_job instead and collect the result later; this tool " +
        "will redirect you there rather than hold the conversation open. Costs $0.003 per minute of audio.",
      inputSchema: {
        type: "object",
        properties: {
          audio: {
            type: "string",
            description:
              "An absolute path to a local file, or a public https:// URL. The URL must be reachable without authentication.",
          },
          ...TRANSCRIPTION_PROPERTIES,
          max_characters: {
            type: "number",
            description: "Cap on returned transcript characters. Default 20000.",
            default: 20000,
          },
        },
        required: ["audio"],
      },
      async handler(args) {
        const audio = String(args.audio ?? "");
        if (!audio) throw new Error("`audio` is required: a local file path or a public URL.");

        // Size is checked before the upload starts, so a long recording is redirected in a
        // second rather than after a failed twenty-minute wait.
        if (!/^https?:\/\//i.test(audio)) {
          const { stat } = await import("node:fs/promises");
          const info = await stat(audio).catch(() => null);
          if (!info) throw new Error(`No such file: ${audio}`);
          if (info.size > SYNC_LIMIT_BYTES) {
            return text(
              `That file is ${(info.size / 1024 / 1024).toFixed(0)} MB, which is too long to transcribe ` +
                `inside one call. Use submit_transcription_job with the same arguments — it returns a job id ` +
                `immediately — then check_job and get_transcript to collect the result.`,
            );
          }
        }

        const transcript = await client.transcribe(audio, transcriptionOptions(args));
        return text(renderTranscript(transcript, Number(args.max_characters ?? 20000)));
      },
    },

    {
      name: "submit_transcription_job",
      description:
        "Start transcribing a long recording and return a job id immediately, without waiting. " +
        "Use this for anything over about half an hour, and for batches. Poll check_job for progress, " +
        "then get_transcript once it reports completed. Costs $0.003 per minute of audio, billed when " +
        "the job finishes.",
      inputSchema: {
        type: "object",
        properties: {
          audio: {
            type: "string",
            description: "An absolute path to a local file, or a public https:// URL.",
          },
          ...TRANSCRIPTION_PROPERTIES,
        },
        required: ["audio"],
      },
      async handler(args) {
        const audio = String(args.audio ?? "");
        if (!audio) throw new Error("`audio` is required: a local file path or a public URL.");
        const jobId = await client.submit(audio, transcriptionOptions(args));
        return text(
          `Submitted. Job id: ${jobId}\n\n` +
            `Transcription typically takes about 48 seconds per hour of audio. Call check_job with this ` +
            `id to see progress, then get_transcript once it reports completed.`,
        );
      },
    },

    {
      name: "check_job",
      description:
        "Report whether a transcription job is still processing, has completed, or has failed. " +
        "Call this before get_transcript; fetching a transcript that is not ready is an error, not an empty result.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "The id returned by submit_transcription_job." },
        },
        required: ["job_id"],
      },
      async handler(args) {
        const status = await client.getJobStatus(String(args.job_id ?? ""));
        if (status.status === "failed") {
          return text(
            `Job ${status.jobId} failed` +
              (status.failedStage ? ` during ${status.failedStage}` : "") +
              (status.reason ? `: ${status.reason}` : "."),
          );
        }
        if (status.status === "completed") {
          return text(`Job ${status.jobId} is complete. Call get_transcript to read it.`);
        }
        return text(`Job ${status.jobId} is ${status.status}. Check again shortly.`);
      },
    },

    {
      name: "get_transcript",
      description:
        "Fetch the transcript of a completed job. Returns readable text with speaker labels by default; " +
        "ask for format \"json\" only when word-level timestamps or confidences are actually needed, since " +
        "that payload is far larger.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "The id of a completed job." },
          format: {
            type: "string",
            enum: ["text", "json", "srt", "vtt"],
            description:
              "text (default) for reading, json for word-level detail, srt or vtt for subtitles.",
            default: "text",
          },
          max_characters: {
            type: "number",
            description: "Cap on returned characters. Default 20000.",
            default: 20000,
          },
        },
        required: ["job_id"],
      },
      async handler(args) {
        const jobId = String(args.job_id ?? "");
        const format = String(args.format ?? "text");
        const maxChars = Number(args.max_characters ?? 20000);
        const outputType: OutputType = format === "text" ? "json" : (format as OutputType);
        const transcript = await client.getTranscript(jobId, { outputType });

        if (format === "text") return text(renderTranscript(transcript, maxChars));

        const raw = new TextDecoder().decode(transcript.content);
        return text(
          raw.length <= maxChars
            ? raw
            : `${raw.slice(0, maxChars)}\n\n[Truncated at ${maxChars.toLocaleString()} of ${raw.length.toLocaleString()} characters.]`,
        );
      },
    },

    {
      name: "list_jobs",
      description:
        "List the account's most recent transcription jobs, newest first. Use it to find a job id the user " +
        "refers to but cannot name.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many to return. Default 20.", default: 20 },
        },
      },
      async handler(args) {
        const limit = Math.min(Number(args.limit ?? 20), 100);
        const { jobs } = await client.listJobs({ limit });
        if (!jobs.length) return text("No transcription jobs on this account yet.");
        return text(
          jobs.map((j) => `${j.jobId}  submitted ${j.createdAt}`).join("\n"),
        );
      },
    },
  ];
}
