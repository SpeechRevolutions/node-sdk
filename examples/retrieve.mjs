/**
 * Submit without waiting, then retrieve later: submit() + get-by-id + list.
 *
 * submit() enqueues a job and returns its id immediately (no waiting); collect
 * the result later by polling getJobStatus / getTranscript (or via a webhook).
 *
 *   node examples/retrieve.mjs
 */

import { SpeechRevolutions } from "../dist/esm/index.js";
import { JobFailedError } from "../dist/esm/exceptions.js";

const client = new SpeechRevolutions(); // reads SPEECHREVOLUTIONS_API_KEY

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntilDone(jobId, intervalMs = 3000) {
  for (; ;) {
    const status = await client.getJobStatus(jobId); // { status, downloadUrl, ... }
    console.log(`  status: ${status.status}`);
    if (status.status === "completed") return client.getTranscript(jobId); // downloads + parses
    if (status.status === "failed") {
      throw new JobFailedError(`job ${jobId} failed`, {
        step: status.failedStage,
        reason: status.reason,
      });
    }
    await sleep(intervalMs);
  }
}

// 1. Fire-and-forget: submit() returns a job id immediately, without waiting.
const jobId = await client.submit("audio.mp3");
console.log(`submitted job ${jobId}`);

// 2. Collect later: poll status, then fetch the transcript by id.
const result = await pollUntilDone(jobId);
console.log(result.text.slice(0, 500));

// (Bonus) list most-recent jobs (newest first), cursor-paginated.
const page = await client.listJobs({ limit: 10 });
console.log(`\n${page.jobs.length} recent job(s); nextBefore=${page.nextBefore}`);
