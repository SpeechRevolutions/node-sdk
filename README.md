# Speech Revolutions — JavaScript / TypeScript SDK

Official JS/TS client for the Speech Revolutions STT API. Works in Node 18+
(native `fetch`). Async-first, like Deepgram / ElevenLabs JS.

Written in TypeScript, published as both CommonJS and ESM, so it works from
plain JavaScript (`require`), ESM (`import`), and TypeScript alike — with full
type definitions either way.

## Install

```bash
npm install speechrevolutions
```

```js
// CommonJS
const { SpeechRevolutions } = require("speechrevolutions");
```

```ts
// ESM / TypeScript
import { SpeechRevolutions } from "speechrevolutions";
```

## Quick start

```ts
import { SpeechRevolutions } from "speechrevolutions";

const client = new SpeechRevolutions(); // reads SPEECHREVOLUTIONS_API_KEY
const result = await client.transcribe("meeting.mp3", { speakerLabels: true });

console.log(result.text);
for (const u of result.utterances) {
  console.log(`Speaker ${u.speaker}: ${u.text}`);
}
```

### From a URL (Deepgram-style)

```ts
const result = await client.transcribeUrl("https://example.com/audio.mp3");
// or, since transcribe() detects http(s) URLs:
// const result = await client.transcribe("https://example.com/audio.mp3");
```

The platform fetches the URL itself — the audio never passes through your
process.

### Options as an object

Pass options as the second argument. `diarize` is an alias for `speakerLabels`.

```ts
await client.transcribe("a.mp3", {
  diarize: true, // alias for speakerLabels
  outputType: "json",
  wordTimestamps: true,
  customVocabulary: ["AcmeCorp"],
});
```

| Option | Type | Default |
|--------|------|---------|
| `outputType` | `"txt" \| "json" \| "srt" \| "vtt" \| "docx" \| "pdf"` | `"json"` |
| `wordTimestamps` | `boolean` | `true` |
| `speakerLabels` | `boolean` | `true` |
| `diarize` | `boolean` (alias for `speakerLabels`) | — |
| `nltk` | `boolean` (punctuation & capitalization) | `true` |
| `tier` | `"standard"` | `"standard"` — the only tier currently available |
| `customVocabulary` | `string[]` | `undefined` |
| `onProgress` | `(event: ProgressEvent) => void` | `undefined` |
| `onUploadProgress` | `(event: ProgressEvent) => void` | `undefined` |
| `progress` | `boolean` (render console bars) | `false` |

## Live progress

Unlike AssemblyAI/Deepgram (which give no percentage for pre-recorded audio),
you get real-time progress — for **both** the file upload and the transcription
— as a console bar, a callback, or both.

```ts
// 1. Console bars — an "Uploading" byte bar, then a "Transcribing" bar,
//    rendered to stderr on a single carriage-return-updated line.
await client.transcribe("meeting.mp3", { progress: true });

// 2. Programmatic — read event.percent (0–100) to drive your own UI / API.
await client.transcribe("meeting.mp3", {
  onProgress(event) {
    // transcription: event.step is "preprocess", "chunk:N" or "aggregation"; event.percent is 0–100
    console.log(event.percent, event.step);
  },
  onUploadProgress(event) {
    // upload: event.step === "upload", event.completed / event.total are bytes
    console.log("upload", event.percent);
  },
});
```

`progress: true` and the callbacks compose — the bars render *and* your
callbacks still fire for every event. `event.percent` is a `0–100` number,
`undefined` when the total is not yet known.

The upload is streamed in chunks with an explicit `Content-Length` (so presigned
S3 PUTs never see `Transfer-Encoding: chunked`), and progress is reported after
each chunk.

## Result shape

Default `outputType` is `json`. The SDK parses it into a transcript-first object:

| Field | Like |
|-------|------|
| `result.text` | AssemblyAI / ElevenLabs |
| `result.transcript` | Deepgram alias |
| `result.words` | word + start/end/speaker |
| `result.utterances` | AssemblyAI speaker turns |
| `result.toDeepgram()` | Deepgram-shaped object |
| `result.toDict()` | normalized JSON |
| `result.content` / `result.save()` | raw bytes / file |

```ts
const dg = result.toDeepgram();
console.log(dg.results.channels[0].alternatives[0].transcript);

// Save raw content to disk. Appends the output type if the path has no
// extension, e.g. "output" -> "output.json". Returns the written path.
const path = await result.save("output");
```

## Webhooks & retrieving results later

`submit()` uploads and enqueues a job and returns its id **without waiting** —
ideal for batch/background work. Collect the result later via a webhook
(`callbackUrl`, a signed POST — verify `X-SR-Signature: sha256=…` against the raw
bytes) or by polling:

```ts
const jobId = await client.submit("meeting.mp3");  // returns immediately, no waiting
// ...or notify a webhook instead of polling:
await client.transcribe("meeting.mp3", { callbackUrl: "https://you.example.com/hook" });

const status = await client.getJobStatus(jobId);   // .status: processing|completed|failed
if (status.status === "completed") {
  const result = await client.getTranscript(jobId); // downloads + parses
}
const page = await client.listJobs({ limit: 50 });  // { jobs, nextBefore }
```

## Robustness

`new SpeechRevolutions({ maxRetries: 3, retryBackoffMs: 500, requestInit: { dispatcher } })`.
Transient 429/5xx/network errors are retried (honoring `Retry-After`). Errors are
typed and carry `.statusCode` and `.requestId`.

## Timeouts and retries

API requests that fail to connect or return 429/500/502/503/504 are retried with
exponential backoff, honoring `Retry-After`. Uploads and the progress stream
have their own retry loops.

```ts
const controller = new AbortController();
const client = new SpeechRevolutions({
  timeout: 600,        // whole-job wait in seconds (SSE + polling)
  maxRetries: 3,       // extra attempts per API request
  retryBackoffMs: 500,
  requestInit: { signal: controller.signal }, // aborts propagate as AbortError
});
```

Errors carry `statusCode`, `requestId` and `body` where the server supplied
them; `RateLimitError.retryAfter` holds the server's hint in seconds.

## Auth

```bash
export SPEECHREVOLUTIONS_API_KEY=stt_...
```

Or `new SpeechRevolutions({ apiKey: "stt_..." })` / `new SpeechRevolutions("stt_...")`.
