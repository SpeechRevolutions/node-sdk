import {
  APIError,
  AuthenticationError,
  JobFailedError,
  JobNotFoundError,
  RateLimitError,
  TimeoutError,
  UploadError,
} from "./exceptions.js";
import { resolveProgress } from "./progress.js";
import { parseSSEStream } from "./sse.js";
import { parseTranscript, type Transcript } from "./transcript.js";
import {
  byteProgressAdapter,
  iterWithProgress,
  type ByteProgressFn,
} from "./upload.js";
import {
  makeProgressEvent,
  resolveOptions,
  type JobStatus,
  type OutputType,
  type ProgressCallback,
  type STTClientOptions,
  type TranscribeOptions,
  type UploadJob,
} from "./types.js";

/**
 * Identifies the SDK to the platform, which makes a client-side problem findable
 * in our edge logs without the caller reproducing it. It is also insurance: the
 * edge answers a request with NO User-Agent with a bare 403, which is how the C#
 * client turned out to be unable to reach production at all while passing every
 * test that pointed at a local mock.
 */
const USER_AGENT = "speechrevolutions-node/0.2.0";

const DEFAULT_BASE_URL = "https://api.speechrevolutions.com";
const UPLOAD_PROGRESS_INTERVAL_MS = 10_000;
const UPLOAD_MAX_ATTEMPTS = 4;
const UPLOAD_BASE_DELAY_MS = 1_000;
const SSE_MAX_RECONNECTS = 10;
const SSE_RECONNECT_DELAY_MS = 3_000;
const POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 500;
const RETRY_BACKOFF_MAX_MS = 30_000;
const RETRY_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const REQUEST_ID_HEADERS = ["x-request-id", "x-amzn-requestid", "cf-ray"];

/**
 * Endpoints that CREATE a job, and so are not safe to blindly retry.
 *
 * A job is created the moment the server handles one of these; the response
 * carrying the job_id back is what can be lost. Retrying after the request may
 * have arrived creates a SECOND job for the same audio — two transcripts, two
 * charges — and the caller never learns about the orphan. The API has no
 * idempotency key, so the only safe rule is to retry these solely when the
 * request provably never reached the server.
 *
 * Every other endpoint either reads, or acts on a jobId the caller already
 * holds, and stays fully retryable.
 */
const JOB_CREATING_PATHS = new Set([
  "/api/v1/upload",
  "/api/v1/upload/multipart/create",
]);

function createsJob(path: string): boolean {
  const clean = path.split("?")[0].replace(/\/+$/, "");
  return JOB_CREATING_PATHS.has(clean);
}

/**
 * Network error codes that mean no connection was ever established, so the
 * request cannot have been processed. Anything else (a reset mid-flight, a
 * headers timeout) is ambiguous and must not be retried for a create.
 */
const NEVER_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function neverReachedServer(err: unknown): boolean {
  const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code
    ?? (err as { code?: string })?.code;
  return typeof code === "string" && NEVER_SENT_CODES.has(code);
}

function extractRequestId(headers: Headers): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value) return value;
  }
  return undefined;
}

/** Parse a Retry-After header (delta-seconds form) into milliseconds. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  return Number.isFinite(secs) ? Math.max(0, secs) * 1000 : undefined;
}

function resolveApiKey(apiKey?: string): string {
  if (apiKey) return apiKey;
  const env =
    (typeof process !== "undefined" &&
      (process.env.SPEECHREVOLUTIONS_API_KEY || process.env.STT_API_KEY)) ||
    undefined;
  if (env) return env;
  throw new AuthenticationError(
    "apiKey is required (pass apiKey or set SPEECHREVOLUTIONS_API_KEY / STT_API_KEY)",
  );
}

/**
 * Resolves the API host: an explicit option, then the environment, then
 * production.
 *
 * Symmetric with the API key — if a caller can supply a key from the
 * environment, they can point it at an environment too. Needed for staging, for
 * an egress proxy or gateway, and for running any published example against
 * something that is not production.
 */
function resolveBaseUrl(baseUrl?: string): string {
  const env =
    (typeof process !== "undefined" &&
      (process.env.SPEECHREVOLUTIONS_BASE_URL || process.env.STT_BASE_URL)) ||
    undefined;
  return (baseUrl ?? env ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

/** Internal signal that a multipart upload should fall back to single-shot. */
class MultipartUnavailable extends Error {}

interface MultipartCreateResponse {
  job_id: string;
  upload_id: string;
  download_url: string;
  part_size: number;
  num_parts: number;
  parts: { part_number: number; url: string }[];
}

export class STTClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeout: number;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly requestInit: RequestInit;
  private readonly multipart: boolean;

  constructor(opts: STTClientOptions | string = {}) {
    const options: STTClientOptions =
      typeof opts === "string" ? { apiKey: opts } : opts ?? {};
    this.apiKey = resolveApiKey(options.apiKey);
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.timeout = options.timeout ?? 600;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.requestInit = options.requestInit ?? {};
    // Prefer multipart; falls back to a single presigned PUT if the server has
    // multipart disabled (404) or a multipart upload fails mid-flight.
    this.multipart = options.multipart ?? true;
  }

  private retryDelayMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, RETRY_BACKOFF_MAX_MS);
    return Math.min(this.retryBackoffMs * 2 ** (attempt - 1), RETRY_BACKOFF_MAX_MS);
  }

  // high-level

  /**
   * Transcribe a local file path, remote URL, bytes, or Blob. A URL is handed
   * to the platform to fetch, so nothing is uploaded from here.
   */
  async transcribe(
    audio: Uint8Array | ArrayBuffer | Blob | string,
    options: TranscribeOptions = {},
    onProgress?: ProgressCallback,
  ): Promise<Transcript> {
    const opts = resolveOptions(options);
    const onTranscribeProgress = onProgress ?? options.onProgress;
    const show = options.progress ?? false;

    if (typeof audio === "string" && isUrl(audio)) {
      const { jobId, downloadUrl } = await this.submitUrl(audio, opts);
      return this.awaitTranscript(jobId, downloadUrl, opts, onTranscribeProgress, show);
    }

    const { data, fileSize } = await readAudio(audio);

    // Upload phase: byte-level "Uploading" bar, then a "Transcribing" bar.
    const upload = resolveProgress(options.onUploadProgress, show, {
      label: "Uploading",
      bytesMode: true,
    });
    let jobId: string;
    let jobDownloadUrl: string;
    try {
      ({ jobId, downloadUrl: jobDownloadUrl } = await this.ingestUpload(
        data,
        fileSize,
        opts,
        upload.callback,
      ));
    } finally {
      upload.printer?.close();
    }

    return this.awaitTranscript(jobId, jobDownloadUrl, opts, onTranscribeProgress, show);
  }

  /** Waits out the transcription phase and parses the result. */
  private async awaitTranscript(
    jobId: string,
    jobDownloadUrl: string,
    opts: ReturnType<typeof resolveOptions>,
    onProgress: ProgressCallback | undefined,
    show: boolean,
  ): Promise<Transcript> {
    const transcribeProgress = resolveProgress(onProgress, show, { label: "Transcribing" });
    let content: Uint8Array;
    let downloadUrl: string;
    try {
      ({ content, downloadUrl } = await this.waitForResult(
        jobId,
        jobDownloadUrl,
        transcribeProgress.callback,
      ));
    } finally {
      transcribeProgress.printer?.close();
    }

    return parseTranscript({
      jobId,
      content,
      outputType: opts.outputType,
      downloadUrl,
    });
  }

  /** Registers a job the platform fetches itself. No bytes leave this process. */
  private async submitUrl(
    audioUrl: string,
    opts: ReturnType<typeof resolveOptions>,
  ): Promise<{ jobId: string; downloadUrl: string }> {
    const data = await this.apiRequest<{ job_id: string; download_url: string }>(
      "POST",
      "/api/v1/upload",
      { ...this.uploadBody(undefined, opts), audio_url: audioUrl },
    );
    return { jobId: String(data.job_id), downloadUrl: String(data.download_url) };
  }

  async transcribeUrl(
    url: string,
    options: TranscribeOptions = {},
    onProgress?: ProgressCallback,
  ): Promise<Transcript> {
    return this.transcribe(url, options, onProgress);
  }

  async transcribeFile(
    path: string,
    options: TranscribeOptions = {},
    onProgress?: ProgressCallback,
  ): Promise<Transcript> {
    return this.transcribe(path, options, onProgress);
  }

  /**
   * Upload and enqueue a job, returning its `jobId` WITHOUT waiting for the
   * result. Collect it later via a webhook (`callbackUrl`) or by polling
   * `getJobStatus` / `getTranscript`. Ideal for batch workloads — submit many,
   * then gather — since it holds no long-lived connection per job.
   */
  async submit(
    audio: Uint8Array | ArrayBuffer | Blob | string,
    options: TranscribeOptions = {},
  ): Promise<string> {
    const opts = resolveOptions(options);

    if (typeof audio === "string" && isUrl(audio)) {
      const { jobId } = await this.submitUrl(audio, opts);
      return jobId;
    }

    const { data, fileSize } = await readAudio(audio);
    const upload = resolveProgress(options.onUploadProgress, options.progress ?? false, {
      label: "Uploading",
      bytesMode: true,
    });
    let jobId: string;
    try {
      ({ jobId } = await this.ingestUpload(data, fileSize, opts, upload.callback));
    } finally {
      upload.printer?.close();
    }
    return jobId;
  }

  // upload flow

  /** JSON body shared by the single-shot and multipart create endpoints. */
  private uploadBody(
    fileSize: number | undefined,
    opts: ReturnType<typeof resolveOptions>,
  ): Record<string, unknown> {
    return {
      ...(fileSize === undefined ? {} : { file_size: fileSize }),
      output_type: opts.outputType,
      word_timestamps: opts.wordTimestamps,
      speaker_labels: opts.speakerLabels,
      nltk: opts.nltk,
      tier: opts.tier,
      ...(opts.customVocabulary ? { custom_vocabulary: opts.customVocabulary } : {}),
      ...(opts.callbackUrl ? { callback_url: opts.callbackUrl } : {}),
    };
  }

  /**
   * Get audio into the platform and return `{ jobId, downloadUrl }`. Prefers a
   * multipart upload (when enabled) and falls back to a single presigned PUT if
   * the server has multipart disabled or a multipart upload fails mid-flight.
   */
  private async ingestUpload(
    data: Uint8Array,
    fileSize: number,
    opts: ReturnType<typeof resolveOptions>,
    onProgress?: ProgressCallback,
  ): Promise<{ jobId: string; downloadUrl: string }> {
    if (this.multipart) {
      try {
        return await this.uploadMultipart(data, fileSize, opts, onProgress);
      } catch (err) {
        if (!(err instanceof MultipartUnavailable)) throw err;
        // multipart unavailable — fall through to the single-shot path
      }
    }
    const job = await this.createUploadJob(fileSize, opts);
    await this.uploadAudio(job.uploadUrl, data, { jobId: job.jobId, onProgress });
    await this.completeUpload(job.jobId);
    return { jobId: job.jobId, downloadUrl: job.downloadUrl };
  }

  /**
   * S3 multipart flow: create -> PUT each part -> complete. Throws
   * {@link MultipartUnavailable} if the server has multipart disabled (404) or a
   * mid-flight failure means we should retry via the single-shot path.
   */
  private async uploadMultipart(
    data: Uint8Array,
    fileSize: number,
    opts: ReturnType<typeof resolveOptions>,
    onProgress?: ProgressCallback,
  ): Promise<{ jobId: string; downloadUrl: string }> {
    let created: MultipartCreateResponse;
    try {
      created = await this.apiRequest<MultipartCreateResponse>(
        "POST",
        "/api/v1/upload/multipart/create",
        this.uploadBody(fileSize, opts),
      );
    } catch (err) {
      // The route returns 404 when multipart is disabled.
      if (err instanceof JobNotFoundError) throw new MultipartUnavailable();
      throw err;
    }

    const jobId = String(created.job_id);
    const partSize = Number(created.part_size);
    const byteCb = byteProgressAdapter(onProgress);
    const completedParts: { part_number: number; etag: string }[] = [];
    let uploaded = 0;
    try {
      for (const part of created.parts) {
        const number = Number(part.part_number);
        const start = (number - 1) * partSize;
        const chunk = data.subarray(start, start + partSize);
        const etag = await this.putPart(part.url, chunk);
        completedParts.push({ part_number: number, etag });
        uploaded += chunk.length;
        byteCb?.(uploaded, fileSize);
      }
      await this.apiRequest("POST", "/api/v1/upload/multipart/complete", {
        job_id: jobId,
        parts: completedParts,
      });
    } catch (err) {
      // Roll back the partial upload, then fall back to a single-shot PUT.
      try {
        await this.apiRequest("POST", "/api/v1/upload/multipart/abort", { job_id: jobId });
      } catch {
        /* best effort */
      }
      throw new MultipartUnavailable(String(err));
    }

    return { jobId, downloadUrl: String(created.download_url) };
  }

  /** PUT one part to its presigned URL and return the S3 ETag. */
  private async putPart(url: string, chunk: Uint8Array): Promise<string> {
    const resp = await this.fetchFn(url, { method: "PUT", body: toArrayBuffer(chunk) });
    if (resp.status !== 200 && resp.status !== 204) {
      throw new UploadError(`part upload failed (HTTP ${resp.status})`);
    }
    const etag = resp.headers.get("ETag") ?? resp.headers.get("etag");
    if (!etag) throw new UploadError("part upload response missing ETag header");
    return etag;
  }

  async createUploadJob(
    fileSize: number,
    options: TranscribeOptions = {},
  ): Promise<UploadJob> {
    const opts = resolveOptions(options);
    const body = this.uploadBody(fileSize, opts);

    const data = await this.apiRequest<{
      job_id: string;
      upload_url: string;
      download_url: string;
      content_type?: string;
      expires_in?: number;
    }>("POST", "/api/v1/upload", body);

    return {
      jobId: String(data.job_id),
      uploadUrl: data.upload_url,
      downloadUrl: data.download_url,
      contentType: data.content_type ?? "application/octet-stream",
      expiresIn: data.expires_in ?? 0,
    };
  }

  async touchUploadProgress(jobId: string): Promise<void> {
    await this.apiRequest("POST", "/api/v1/upload/progress", { job_id: jobId });
  }

  async uploadAudio(
    uploadUrl: string,
    data: Uint8Array,
    opts: {
      jobId?: string;
      contentType?: string;
      onProgress?: ProgressCallback;
    } = {},
  ): Promise<void> {
    const contentType = opts.contentType ?? "application/octet-stream";
    const byteCb = byteProgressAdapter(opts.onProgress);
    const stop = { stopped: false };
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    if (opts.jobId) {
      heartbeat = setInterval(() => {
        if (stop.stopped) return;
        void this.touchUploadProgress(opts.jobId!).catch(() => undefined);
      }, UPLOAD_PROGRESS_INTERVAL_MS);
    }

    let lastError: unknown;
    try {
      for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
        try {
          // A fresh streamed body per attempt so retries restart progress from 0.
          await this.putUpload(uploadUrl, data, contentType, byteCb);
          return;
        } catch (err) {
          lastError = err;
          if (attempt < UPLOAD_MAX_ATTEMPTS) {
            await sleep(UPLOAD_BASE_DELAY_MS * 2 ** (attempt - 1));
          }
        }
      }
    } finally {
      stop.stopped = true;
      if (heartbeat) clearInterval(heartbeat);
    }

    throw new UploadError(
      `Upload failed after ${UPLOAD_MAX_ATTEMPTS} attempts: ${String(lastError)}`,
    );
  }

  async completeUpload(jobId: string): Promise<void> {
    await this.apiRequest("POST", "/api/v1/upload/complete", { job_id: jobId });
  }

  // progress / result

  async waitForResult(
    jobId: string,
    downloadUrl: string,
    onProgress?: ProgressCallback,
    timeout = this.timeout,
  ): Promise<{ content: Uint8Array; downloadUrl: string }> {
    const sseUrl = await this.waitSSE(jobId, downloadUrl, onProgress, timeout);
    if (sseUrl === null) {
      const content = await this.waitPoll(jobId, downloadUrl, timeout);
      return { content, downloadUrl };
    }
    const content = await this.downloadResult(sseUrl);
    return { content, downloadUrl: sseUrl };
  }

  async downloadResult(downloadUrl: string): Promise<Uint8Array> {
    const resp = await this.fetchFn(downloadUrl);
    if (!resp.ok) {
      throw new APIError(`Download failed (HTTP ${resp.status})`, {
        statusCode: resp.status,
        body: await resp.text().then((t) => t.slice(0, 300)),
      });
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  // job management

  async cancelJob(jobId: string): Promise<void> {
    await this.apiRequest("POST", "/api/v1/jobs/cancel", { job_id: jobId });
  }

  async checkFailed(jobIds: string[]): Promise<boolean[]> {
    const data = await this.apiRequest<{ failed_jobs: boolean[] }>(
      "POST",
      "/api/v1/jobs/check-failed",
      { job_ids: jobIds.map(String) },
    );
    return data.failed_jobs ?? [];
  }

  // retrieval (get by id / list)

  /** Fetch a job's current status (and a fresh download URL once complete). */
  async getJobStatus(jobId: string): Promise<JobStatus> {
    const data = await this.apiRequest<{
      job_id?: string;
      status?: string;
      download_url?: string;
      failed_stage?: string;
      reason?: string;
    }>("GET", `/api/v1/jobs/${encodeURIComponent(jobId)}`);
    return {
      jobId: String(data.job_id ?? jobId),
      status: String(data.status ?? ""),
      downloadUrl: data.download_url,
      failedStage: data.failed_stage,
      reason: data.reason,
    };
  }

  /**
   * Fetch and parse a completed job's transcript by id. Throws
   * {@link JobFailedError} if it failed, or {@link APIError} if still processing.
   */
  async getTranscript(
    jobId: string,
    opts: { outputType?: OutputType } = {},
  ): Promise<Transcript> {
    const status = await this.getJobStatus(jobId);
    if (status.status === "failed") {
      throw new JobFailedError(`Job ${jobId} failed`, {
        step: status.failedStage,
        reason: status.reason,
      });
    }
    if (status.status !== "completed" || !status.downloadUrl) {
      throw new APIError(`Job ${jobId} is not complete (status=${status.status})`);
    }
    const content = await this.downloadResult(status.downloadUrl);
    return parseTranscript({
      jobId,
      content,
      outputType: opts.outputType ?? "json",
      downloadUrl: status.downloadUrl,
    });
  }

  /** List the caller's most-recent jobs (newest first), cursor-paginated. */
  async listJobs(
    opts: { limit?: number; before?: string } = {},
  ): Promise<{ jobs: { jobId: string; createdAt: string }[]; nextBefore: string | null }> {
    const params = new URLSearchParams();
    params.set("limit", String(opts.limit ?? 50));
    if (opts.before) params.set("before", opts.before);
    const data = await this.apiRequest<{
      jobs?: { job_id: string; created_at: string }[];
      next_before?: string | null;
    }>("GET", `/api/v1/jobs?${params.toString()}`);
    return {
      jobs: (data.jobs ?? []).map((j) => ({ jobId: j.job_id, createdAt: j.created_at })),
      nextBefore: data.next_before ?? null,
    };
  }

  // internals

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      ...extra,
    };
  }

  private async apiRequest<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    // Job-creating calls retry only when the request provably never landed;
    // anything else would risk a duplicate job and a duplicate charge.
    const creating = createsJob(path);
    let attempt = 0;
    while (true) {
      attempt += 1;
      let resp: Response;
      try {
        resp = await this.fetchFn(url, {
          ...this.requestInit,
          method,
          headers: this.headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (isAbort(err)) throw err;
        // Retry transient network failures with exponential backoff.
        const safe = !creating || neverReachedServer(err);
        if (safe && attempt <= this.maxRetries) {
          await sleep(this.retryDelayMs(attempt));
          continue;
        }
        throw new APIError(`Cannot connect to ${this.baseUrl}: ${String(err)}`);
      }

      // Retry throttling / transient server errors, honoring Retry-After.
      // For a create, only 429 is safe: the server refused it outright, so no
      // job exists. A 5xx may well have created one before failing.
      if (
        RETRY_STATUS_CODES.has(resp.status) &&
        attempt <= this.maxRetries &&
        (!creating || resp.status === 429)
      ) {
        const retryAfterMs = parseRetryAfterMs(resp.headers.get("Retry-After"));
        await sleep(this.retryDelayMs(attempt, retryAfterMs));
        continue;
      }

      await this.raiseForStatus(resp);
      if (!resp.body || resp.status === 204) return {} as T;
      const text = await resp.text();
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return { raw: text } as T;
      }
    }
  }

  private async raiseForStatus(resp: Response): Promise<void> {
    if (resp.status === 200 || resp.status === 204) return;
    const body = await resp.text().then((t) => t.slice(0, 300)).catch(() => undefined);
    const requestId = extractRequestId(resp.headers);
    if (resp.status === 401) throw new AuthenticationError(undefined, { statusCode: 401, requestId, body });
    if (resp.status === 404) throw new JobNotFoundError(undefined, { statusCode: 404, requestId, body });
    if (resp.status === 429) {
      throw new RateLimitError(undefined, {
        statusCode: 429,
        requestId,
        body,
        retryAfter: (parseRetryAfterMs(resp.headers.get("Retry-After")) ?? 0) / 1000 || undefined,
      });
    }
    throw new APIError(`Unexpected response (HTTP ${resp.status})`, {
      statusCode: resp.status,
      requestId,
      body,
    });
  }

  private async putUpload(
    uploadUrl: string,
    data: Uint8Array,
    contentType: string,
    byteCb?: ByteProgressFn,
  ): Promise<void> {
    let resp: Response;
    if (byteCb) {
      // Presigned PUT with progress: stream the body in chunks and report after
      // each. An explicit Content-Length keeps undici from switching to
      // Transfer-Encoding: chunked (which S3 rejects); `duplex: "half"` is
      // required by Node when the body is a stream / async iterable.
      const init = {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(data.byteLength),
        },
        body: iterWithProgress(data, byteCb),
        duplex: "half",
      };
      resp = await this.fetchFn(uploadUrl, init as unknown as RequestInit);
    } else {
      resp = await this.fetchFn(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: toArrayBuffer(data),
      });
    }

    if (resp.status !== 200 && resp.status !== 204) {
      const text = await resp.text().then((t) => t.slice(0, 200));
      throw new UploadError(`HTTP ${resp.status}: ${text}`);
    }
  }

  private async waitSSE(
    jobId: string,
    fallbackDownloadUrl: string,
    onProgress: ProgressCallback | undefined,
    timeout: number,
  ): Promise<string | null> {
    const start = Date.now();
    let lastEventId: string | undefined;
    let reconnects = 0;

    while (true) {
      const elapsed = (Date.now() - start) / 1000;
      if (elapsed >= timeout) {
        throw new TimeoutError(`Timed out after ${timeout}s waiting for job ${jobId}`);
      }
      if (reconnects > SSE_MAX_RECONNECTS) return null;
      if (reconnects > 0) await sleep(SSE_RECONNECT_DELAY_MS);

      const result = await this.sseAttempt(
        jobId,
        start,
        timeout,
        lastEventId,
        fallbackDownloadUrl,
        onProgress,
      );
      lastEventId = result.lastEventId;

      if (result.outcome === "done") return result.downloadUrl ?? fallbackDownloadUrl;
      if (result.outcome === "failed") throw new JobFailedError("Job failed");
      if (result.outcome === "timeout") {
        throw new TimeoutError(`Timed out after ${timeout}s waiting for job ${jobId}`);
      }
      reconnects += 1;
    }
  }

  private async sseAttempt(
    jobId: string,
    start: number,
    timeout: number,
    lastEventId: string | undefined,
    fallbackDownloadUrl: string,
    onProgress?: ProgressCallback,
  ): Promise<{
    outcome: "done" | "failed" | "reconnect" | "timeout";
    downloadUrl?: string;
    lastEventId?: string;
  }> {
    const elapsed = (Date.now() - start) / 1000;
    if (elapsed >= timeout) return { outcome: "timeout", lastEventId };

    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      "User-Agent": USER_AGENT,
      Accept: "text/event-stream",
    };
    if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;

    let resp: Response;
    try {
      const controller = new AbortController();
      const remainingMs = Math.max(1000, (timeout - elapsed) * 1000);
      const timer = setTimeout(() => controller.abort(), remainingMs);
      try {
        resp = await this.fetchFn(`${this.baseUrl}/api/v1/jobs/${jobId}/stream`, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { outcome: "reconnect", lastEventId };
    }

    if (resp.status === 401) throw new AuthenticationError();
    if (resp.status === 429) throw new RateLimitError();
    if (resp.status !== 200) return { outcome: "reconnect", lastEventId };

    if (!resp.body) return { outcome: "reconnect", lastEventId };

    const reader = resp.body.getReader();
    try {
      for await (const sse of parseSSEStream(reader)) {
        if (sse.id) lastEventId = sse.id;
        const nowElapsed = (Date.now() - start) / 1000;
        if (nowElapsed >= timeout) return { outcome: "timeout", lastEventId };

        const eventType = sse.event ?? "message";
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(sse.data ?? "{}") as Record<string, unknown>;
        } catch {
          data = { raw: sse.data };
        }

        if (eventType === "progress") {
          // Fire the callback inline so progress is live, not replayed in a
          // burst after the stream closes.
          onProgress?.(
            makeProgressEvent({
              completed: asInt(data.completed),
              total: asInt(data.total),
              step: typeof data.step === "string" ? data.step : undefined,
              elapsedSeconds: nowElapsed,
              raw: data,
            }),
          );
        } else if (eventType === "completed") {
          const dl =
            typeof data.download_url === "string"
              ? data.download_url
              : fallbackDownloadUrl;
          return { outcome: "done", downloadUrl: dl, lastEventId };
        } else if (eventType === "failed") {
          const step = String(data.step ?? "unknown");
          const reason = String(data.reason ?? "unknown");
          throw new JobFailedError(`Job failed at step=${step}: ${reason}`, {
            step,
            reason,
          });
        }
      }
      return { outcome: "reconnect", lastEventId };
    } catch (err) {
      if (err instanceof JobFailedError || err instanceof AuthenticationError) throw err;
      return { outcome: "reconnect", lastEventId };
    } finally {
      reader.releaseLock();
    }
  }

  private async waitPoll(
    jobId: string,
    downloadUrl: string,
    timeout: number,
  ): Promise<Uint8Array> {
    const start = Date.now();
    const maxAttempts = Math.max(1, Math.floor(timeout / (POLL_INTERVAL_MS / 1000)));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if ((Date.now() - start) / 1000 >= timeout) break;

      try {
        const failed = await this.checkFailed([jobId]);
        if (failed[0]) throw new JobFailedError(`Job ${jobId} has failed`);
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof JobFailedError) throw err;
      }

      try {
        const resp = await this.fetchFn(downloadUrl);
        if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
      } catch {
        // ignore probe errors
      }

      if (attempt < maxAttempts) await sleep(POLL_INTERVAL_MS);
    }

    throw new TimeoutError(`Job ${jobId} did not complete within ${timeout}s`);
  }
}

// helpers

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for an aborted request, which must propagate rather than be retried. */
function isAbort(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function asInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function readAudio(
  audio: Uint8Array | ArrayBuffer | Blob | string,
): Promise<{ data: Uint8Array; fileSize: number }> {
  let data: Uint8Array;

  if (typeof audio === "string") {
    const { readFile } = await import("node:fs/promises");
    data = new Uint8Array(await readFile(audio));
  } else if (audio instanceof ArrayBuffer) {
    data = new Uint8Array(audio);
  } else if (audio instanceof Uint8Array) {
    data = audio;
  } else if (typeof Blob !== "undefined" && audio instanceof Blob) {
    data = new Uint8Array(await audio.arrayBuffer());
  } else {
    throw new TypeError(`Unsupported audio type: ${typeof audio}`);
  }

  if (data.byteLength === 0) throw new Error("Audio is empty");
  return { data, fileSize: data.byteLength };
}

/** @deprecated Use STTClient — alias for Deepgram / ElevenLabs naming. */
export class SpeechRevolutions extends STTClient {}
export { SpeechRevolutions as SpeechRevolutionsClient };
