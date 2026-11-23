# Speech Revolutions — JavaScript / TypeScript SDK

Official JS/TS client for the [Speech Revolutions](https://www.speechrevolutions.com) speech-to-text API. Works in Node 18+
(native `fetch`). Async-first, like Deepgram / ElevenLabs JS.

Written in TypeScript, published as both CommonJS and ESM, so it works from
plain JavaScript (`require`), ESM (`import`), and TypeScript alike — with full
type definitions either way.

## Install

```bash
npm install speechrevolutions
npm install ws        # for real-time streaming on Node 18/20 (Node 22+ needs nothing extra)
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
  console.log(`${u.speaker}: ${u.text}`); // e.g. "SPEAKER_1: Hello."
}
```

### From a URL (Deepgram-style)

```ts
const result = await client.transcribeUrl(
  "https://docs.speechrevolutions.com/samples/diamond-necklace.mp3",
);
// or, since transcribe() detects http(s) URLs:
// const result = await client.transcribe("https://docs.speechrevolutions.com/samples/diamond-necklace.mp3");
```

The platform fetches the URL itself — the audio never passes through your
process.

### Options as an object

Pass options as the second argument. `diarize` is an alias for `speakerLabels`.

```ts
await client.transcribe("meeting.mp3", {
  diarize: true, // alias for speakerLabels
  outputType: "json",
  wordTimestamps: true,
  customVocabulary: ["AcmeCorp"],
  language: "en", // omit for automatic language detection
});
```

| Option | Type | Default |
|--------|------|---------|
| `outputType` | `"txt" \| "json" \| "srt" \| "vtt" \| "docx" \| "pdf"` | `"json"` |
| `wordTimestamps` | `boolean` | `true` |
| `speakerLabels` | `boolean` (diarization, +$0.02/hr) | `false` |
| `diarize` | `boolean` (alias for `speakerLabels`) | — |
| `summarize` | `boolean` (`result.summary`, +$0.02/hr) | `false` |
| `filterProfanity` | `boolean` (`s***`, +$0.01/hr) | `false` |
| `paragraphs` | `boolean` (`result.paragraphs`, free) | `false` |
| `verbatim` | `boolean` (keep fillers and false starts) | server default |
| `extra` | `Record<string, unknown>` (any other API option, as named in the API) | `undefined` |
| `nltk` | `boolean` (punctuation & capitalization) | `true` |
| `tier` | `"standard"` | `"standard"` — the only tier currently available |
| `customVocabulary` | `string[]` (keyterms, +$0.05/hr) | `undefined` |
| `language` | `string` (ISO 639-1, e.g. `"en"`) | `undefined` — auto-detect |
| `onProgress` | `(event: ProgressEvent) => void` | `undefined` |
| `onUploadProgress` | `(event: ProgressEvent) => void` | `undefined` |
| `progress` | `boolean` (render console bars) | `false` |

`language` skips language detection and transcribes the whole file in that
language. Pinning the wrong one makes the model translate into it (Russian audio
pinned to `"en"` comes back in English), so leave it unset unless you know the
language. An unsupported code is rejected with HTTP 422.

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
`undefined` when the total is not yet known. When the job completes, `onProgress`
always receives a final event at `100` (`event.step === "completed"`), even for a
short file that finished before reporting any progress.

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
import { SpeechRevolutions } from "speechrevolutions";

const client = new SpeechRevolutions();
const result = await client.transcribe("meeting.mp3");

// Deepgram's response shape (typed as DeepgramResponse); speakers are numbered from 0.
const dg = result.toDeepgram();
console.log(dg.results.channels[0].alternatives[0].transcript);

// Save raw content to disk. Appends the output type if the path has no
// extension, e.g. "output" -> "output.json". Returns the written path.
const path = await result.save("output");
console.log(`saved ${path}`);
```

`toDeepgram()` numbers speakers from 0, as Deepgram does: `SPEAKER_1` becomes speaker `0`,
`SPEAKER_2` speaker `1`. (Before 1.0.0 it kept our 1-based numbers.)

Batch is $0.09 per audio hour; the add-ons above are charged per audio hour only when turned on.
`result.summary` (`{ text, bullets }`) and `result.paragraphs` (`{ text, speaker, start, end,
sentences }`) are set when requested. `await client.deleteJob(jobId)` deletes a job's transcripts
before the automatic purge.

## Real-time streaming

Real-time transcription over WebSocket, $0.15 per session hour (early access). Audio is PCM16
mono 16 kHz. On Node 18/20 install `ws`; Node 22+ works as is.

```ts
import { SpeechRevolutions } from "speechrevolutions";

const client = new SpeechRevolutions();
const session = await client.stream({
  language: "en", // or languages: ["en", "ja"], or omit to detect
  vocabulary: ["Northwind"],
  onEvent: (e) => {
    if (e.type === "transcription.partial") process.stdout.write(`\r${e.text}`);
    if (e.type === "final") console.log(`\n[${e.start}-${e.end}] ${e.text}`);
  },
});

for await (const chunk of microphone()) session.sendAudio(chunk); // PCM16 mono 16 kHz
const result = await session.finish(); // waits for transcription.done
console.log(result.text);
```

| Event | Fields |
|---|---|
| `session.created` | `jobId` |
| `transcription.partial` | `index`, `text`, `stable` (`text.slice(0, stable)` is settled), `audioS` |
| `final` | `index`, `text`, `start`, `end` |
| `final.revised` | `index`, `text`: a better version of an earlier final |
| `speech.started` / `turn.ended` | `audioS` / `index`, `start`, `end`, `probability`, `forced` |
| `language.detected` | `language`, `index` |
| `transcription.done` | `text` |
| `error` | `code`, `message` |

- `for await (const e of session)` reads the same events as `onEvent`.
- `turnDetection: { threshold: 0.5, max_silence_ms: 800 }` tunes when a turn ends;
  `session.endTurn()` ends one now (push-to-talk).
- **Dropped connections are handled:** the session keeps unacknowledged audio, reconnects with
  its job id for up to 60 s, and replays it. The result comes back complete under the same `jobId`.
- `await client.streamFile("call.mp3", { language: "en" })` streams a recording in real time
  (Node; ffmpeg converts other formats). For recordings in production, `transcribe` is faster and
  cheaper.
- Audio must arrive in real time: the server takes at most about 10 seconds ahead of the clock.
- In a browser, the API key would go in the URL, so don't stream from a browser with a secret key.

## Webhooks & retrieving results later

`submit()` uploads and enqueues a job and returns its id **without waiting** —
ideal for batch/background work. Collect the result later via a webhook
(`callbackUrl`, a signed POST — verify `X-SR-Signature: sha256=…` against the raw
bytes) or by polling:

```ts
const jobId = await client.submit("meeting.mp3");  // returns immediately, no waiting
// ...or have a webhook notified instead of polling:
await client.submit("meeting.mp3", { callbackUrl: "https://you.example.com/hook" });

const status = await client.getJobStatus(jobId);   // .status: processing|completed|failed
if (status.status === "completed") {
  const result = await client.getTranscript(jobId); // downloads + parses
}
const page = await client.listJobs({ limit: 50 });  // { jobs, nextBefore }
```

The signature is HMAC-SHA256 over the raw request body, keyed with **your account's own
webhook signing secret** — find it under API Keys in the
[console](https://console.speechrevolutions.com). Compare it with a constant-time function,
and verify against the bytes you received rather than a re-serialised copy. Worked receivers
for Python, Node, Go and C# are in the
[webhooks guide](https://docs.speechrevolutions.com/guides/webhooks).

## Robustness

Transient 429/5xx/network errors are retried (honoring `Retry-After`). Errors are
typed and carry `.statusCode` and `.requestId`.

Behind an HTTP proxy, pass an undici `dispatcher` through `requestInit`. It is used for
every request — API calls, the progress stream, and the audio upload and result
download, which go to presigned storage URLs:

```ts
import { ProxyAgent } from "undici"; // npm install undici
import { SpeechRevolutions } from "speechrevolutions";

const client = new SpeechRevolutions({
  requestInit: { dispatcher: new ProxyAgent("http://proxy.internal:3128") },
});
```

Storage requests get the transport options only: your API key and any `headers` you put
in `requestInit` are never sent to a storage URL.

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

## MCP server

The package ships an MCP server, so an assistant can transcribe audio directly instead of
you writing the call. Add it to any MCP client:

```json
{
  "mcpServers": {
    "speechrevolutions": {
      "command": "npx",
      "args": ["-y", "speechrevolutions", "mcp"],
      "env": { "SPEECHREVOLUTIONS_API_KEY": "stt_..." }
    }
  }
}
```

Five tools: `transcribe_audio` (short files, waits for the result), `submit_transcription_job`
(long files, returns a job id), `check_job`, `get_transcript` and `list_jobs`.

Transcripts come back as readable text with speaker labels rather than raw JSON — the caller
is a language model, and word-level JSON for a long recording spends the context it needs to
answer the question. Ask `get_transcript` for `format: "json"` when you actually want the
timings, or `"srt"` / `"vtt"` for subtitles (phrase-length cues, at most two lines of 42
characters, never spanning two speakers).


## Links

- [Speech Revolutions](https://www.speechrevolutions.com) — the speech-to-text API this library talks to
- [Documentation](https://docs.speechrevolutions.com) — API reference, guides and quickstarts
