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
  /**
   * ISO 639-1 code of the spoken language (e.g. `"en"`, `"ru"`). Omit (or pass
   * `"auto"`) for automatic language detection. When set, detection is skipped
   * and the whole job is transcribed in that language — pinning the wrong one
   * makes the model translate into it. An unsupported code is rejected with 422.
   */
  language?: string;
  /** Webhook URL POSTed a signed completion/failure notification. */
  callbackUrl?: string;
  /** Your own id for the person the audio belongs to (automatic per-user vocabulary, when enabled). */
  endUserId?: string;
  /** Replace PII in the transcript, timings kept. */
  redactPii?: boolean;
  /** email_address, phone_number, credit_card_number, us_social_security_number, ip_address (default: all). */
  redactPiiPolicies?: string[];
  /** "entity_name" (default, e.g. [PHONE_NUMBER]) or "hash" (####). */
  redactPiiSub?: "entity_name" | "hash";
  /** JSON output gains `entities` [{entity_type, text, start, end}]. */
  entityDetection?: boolean;
  /** Mask profanity ("f***"). */
  filterProfanity?: boolean;
  /** JSON output gains `paragraphs` [{start, end, speaker, text, sentences}]. */
  paragraphs?: boolean;
  /** Keep fillers and false starts (verbatim). Omit for the account's default style. */
  verbatim?: boolean;
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
   * Node: pass `{ dispatcher: new ProxyAgent(url) }` (from `undici`). Applied to
   * API calls, the progress stream, and storage uploads/downloads (which get the
   * transport options only, never `headers`).
   *
   * `dispatcher` is declared here because Node's fetch accepts it while the
   * standard `RequestInit` type does not.
   */
  requestInit?: RequestInit & { dispatcher?: unknown };
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
  Pick<TranscribeOptions, "customVocabulary" | "language" | "callbackUrl" | "endUserId" | "redactPii" | "redactPiiPolicies" | "redactPiiSub" | "entityDetection" | "filterProfanity" | "paragraphs" | "verbatim"> {
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
    language: options.language,
    callbackUrl: options.callbackUrl,
    endUserId: options.endUserId,
    redactPii: options.redactPii,
    redactPiiPolicies: options.redactPiiPolicies,
    redactPiiSub: options.redactPiiSub,
    entityDetection: options.entityDetection,
    filterProfanity: options.filterProfanity,
    paragraphs: options.paragraphs,
    verbatim: options.verbatim,
  };
}
