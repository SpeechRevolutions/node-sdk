export type OutputType = "txt" | "json" | "srt" | "vtt" | "docx" | "pdf";
export type ProcessingTier = "standard" | "economy";

export interface TranscribeOptions {
  outputType?: OutputType;
  wordTimestamps?: boolean;
  speakerLabels?: boolean;
  /** Alias for speakerLabels (ElevenLabs / Deepgram). */
  diarize?: boolean;
  nltk?: boolean;
  /** Processing / pricing tier. Default: standard. */
  tier?: ProcessingTier;
  customVocabulary?: string[];
  /** Webhook URL POSTed a signed completion/failure notification. */
  callbackUrl?: string;
  /** Callback fired for every transcription progress event (read `event.percent`). */
  onProgress?: ProgressCallback;
  /** Callback fired for byte-level upload progress (`event.step === "upload"`). */
  onUploadProgress?: ProgressCallback;
  /** Render live `Uploading` + `Transcribing` bars to stderr. Default: false. */
  progress?: boolean;
}

export interface UploadJob {
  jobId: string;
  uploadUrl: string;
  downloadUrl: string;
  contentType: string;
  expiresIn: number;
}

export interface JobStatus {
  jobId: string;
  status: "processing" | "completed" | "failed" | string;
  downloadUrl?: string;
  failedStage?: string;
  reason?: string;
}

export interface ProgressEvent {
  completed?: number;
  total?: number;
  step?: string;
  elapsedSeconds?: number;
  raw?: Record<string, unknown>;
  /** Completion as a 0–100 number, or `undefined` when the total is unknown. */
  percent?: number;
}

export type ProgressCallback = (event: ProgressEvent) => void;

/** Completion as a 0–100 number clamped to [0, 100], or `undefined` if unknown. */
export function computePercent(
  completed?: number,
  total?: number,
): number | undefined {
  if (completed === undefined || completed === null || !total) return undefined;
  return Math.max(0, Math.min(100, (completed / total) * 100));
}

/** Build a {@link ProgressEvent} with its `percent` derived from completed/total. */
export function makeProgressEvent(
  event: Omit<ProgressEvent, "percent">,
): ProgressEvent {
  return { ...event, percent: computePercent(event.completed, event.total) };
}

export interface SpeechRevolutionsOptions {
  /** Defaults to SPEECHREVOLUTIONS_API_KEY. */
  apiKey?: string;
  baseUrl?: string;
  /** Total seconds to wait for a job (default 600). */
  timeout?: number;
  fetch?: typeof fetch;
  /** Retry attempts for transient JSON API failures (429/5xx/network). Default 3. */
  maxRetries?: number;
  /** Base backoff in ms; exponential and capped at 30s. Default 500. */
  retryBackoffMs?: number;
  /**
   * Extra `fetch` init merged into every request — the idiomatic proxy hook in
   * Node: pass `{ dispatcher: new ProxyAgent(url) }` (from `undici`).
   */
  requestInit?: RequestInit;
  /**
   * Prefer S3 multipart uploads and fall back to a single presigned PUT if the
   * server has multipart disabled or a multipart upload fails mid-flight.
   * Default true.
   */
  multipart?: boolean;
}

export function resolveOptions(options: TranscribeOptions = {}): Required<
  Pick<
    TranscribeOptions,
    "outputType" | "wordTimestamps" | "speakerLabels" | "nltk" | "tier"
  >
> &
  Pick<TranscribeOptions, "customVocabulary" | "callbackUrl"> {
  const speakerLabels =
    options.diarize !== undefined
      ? options.diarize
      : options.speakerLabels !== undefined
        ? options.speakerLabels
        : true;
  return {
    outputType: options.outputType ?? "json",
    wordTimestamps: options.wordTimestamps ?? true,
    speakerLabels,
    nltk: options.nltk ?? true,
    tier: options.tier ?? "standard",
    customVocabulary: options.customVocabulary,
    callbackUrl: options.callbackUrl,
  };
}
