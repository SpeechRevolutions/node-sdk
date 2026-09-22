/**
 * Live progress for a web app.
 *
 * You're building a transcription app and want a live progress bar per user.
 * `transcribe()` surfaces progress through two callbacks:
 *   - onUploadProgress  (event.step === "upload")  while the file uploads
 *   - onProgress                                    while the server transcribes
 * Each gets a ProgressEvent with `event.percent` (0–100, or undefined before
 * totals are known). Turn that into one number you store per job and serve to
 * your frontend (poll it, or push over a WebSocket).
 *
 *   node examples/progress-webapp.mjs
 */

import { SpeechRevolutions } from "../dist/esm/index.js";

// Weight the two phases into a single 0–100 bar (upload is usually quick).
const UPLOAD_WEIGHT = 0.15; // upload spans 0–15%
const TRANSCRIBE_WEIGHT = 0.85; // transcription spans 15–100%

/** The latest progress for one job — the shape you'd serve to your frontend. */
class JobProgress {
  constructor() {
    this.phase = "starting"; // "upload" | "transcribe" | "done"
    this.percent = 0; // overall 0–100 across both phases
  }
  #set(phase, overall) {
    this.phase = phase;
    // never let the bar go backwards (events can arrive slightly out of order)
    this.percent = Math.max(this.percent, Math.round(overall * 10) / 10);
  }
  onUpload = (event) => this.#set("upload", (event.percent ?? 0) * UPLOAD_WEIGHT);
  onTranscribe = (event) =>
    this.#set("transcribe", UPLOAD_WEIGHT * 100 + (event.percent ?? 0) * TRANSCRIBE_WEIGHT);
  done() {
    this.#set("done", 100);
  }
  snapshot() {
    return { phase: this.phase, percent: this.percent };
  }
}

const client = new SpeechRevolutions(); // reads SPEECHREVOLUTIONS_API_KEY
const store = new JobProgress();

// In a real app you'd read store.snapshot() from an HTTP handler; here we just
// log whenever it changes so you can watch the number climb.
let last = "";
const timer = setInterval(() => {
  const snap = JSON.stringify(store.snapshot());
  if (snap !== last) {
    const { phase, percent } = store.snapshot();
    console.log(`  [${phase.padStart(10)}] ${percent.toFixed(1)}%`);
    last = snap;
  }
}, 200);

const result = await client.transcribe("audio.mp3", {
  onUploadProgress: store.onUpload, // <- your handler; do anything with event.percent
  onProgress: store.onTranscribe,
});
store.done();
clearInterval(timer);
console.log(`\nDone — ${result.text.length} chars, ${result.utterances.length} utterances`);

// --- Express sketch ---------------------------------------------------------
// const jobs = new Map();                       // job_id -> JobProgress
// app.post("/transcribe", (req, res) => {
//   const store = new JobProgress();
//   jobs.set(req.body.jobId, store);
//   client.transcribe(req.body.url, { onUploadProgress: store.onUpload, onProgress: store.onTranscribe });
//   res.json({ jobId: req.body.jobId });        // returns immediately; runs in background
// });
// app.get("/progress/:jobId", (req, res) => res.json(jobs.get(req.params.jobId).snapshot()));
