/**
 * Upload-body helpers that report byte-level progress.
 *
 * The HTTP client can only observe upload progress if it reads the body through
 * something we control. For a presigned S3 PUT that's a byte-chunk async
 * generator (`iterWithProgress`) paired with an explicit `Content-Length`
 * header, which keeps S3 happy — undici (Node's fetch) would otherwise switch a
 * streamed body to `Transfer-Encoding: chunked`, which presigned PUTs reject.
 */

import { makeProgressEvent, type ProgressCallback } from "./types.js";

/** Callback receives (bytesSent, totalBytes). */
export type ByteProgressFn = (sent: number, total: number) => void;

export const UPLOAD_CHUNK_SIZE = 64 * 1024;

/**
 * Adapt a {@link ProgressCallback} to a `(sent, total)` byte callback.
 *
 * Upload events are reported as `ProgressEvent(step="upload")` so they share the
 * same shape (and `.percent`) as transcription progress.
 */
export function byteProgressAdapter(
  onProgress?: ProgressCallback,
): ByteProgressFn | undefined {
  if (!onProgress) return undefined;
  return (sent: number, total: number) => {
    onProgress(makeProgressEvent({ completed: sent, total, step: "upload" }));
  };
}

/**
 * Yield `data` in chunks, reporting progress after each — used as the streamed
 * PUT body. A fresh generator is created per upload attempt, so a retry simply
 * restarts progress from 0.
 */
export async function* iterWithProgress(
  data: Uint8Array,
  callback?: ByteProgressFn,
): AsyncGenerator<Uint8Array> {
  const total = data.byteLength;
  let sent = 0;
  for (let start = 0; start < total; start += UPLOAD_CHUNK_SIZE) {
    const chunk = data.subarray(start, Math.min(start + UPLOAD_CHUNK_SIZE, total));
    sent += chunk.byteLength;
    yield chunk;
    callback?.(sent, total);
  }
}
