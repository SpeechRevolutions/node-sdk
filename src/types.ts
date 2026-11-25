export type OutputType = "txt" | "json" | "srt" | "vtt" | "docx" | "pdf";
export type ProcessingTier = "standard" | "economy";

/** Types `redactPiiPolicies` accepts (the server's list; the default is all of them). */
export const PII_POLICIES = [
  "person_name",
  "organization",
  "location",
  "address",
  "date_of_birth",
  "date",
  "account_number",
  "email_address",
  "phone_number",
  "credit_card_number",
  "us_social_security_number",
  "ip_address",
] as const;

export type PiiPolicy = (typeof PII_POLICIES)[number];

export interface TranscribeOptions {
  outputType?: OutputType;
  wordTimestamps?: boolean;
  /** Speaker diarization. An add-on (+$0.02 per audio hour), so off unless set. */
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
  /** Add-on: a summary (`transcript.summary`). +$0.02 per audio hour. */
  summarize?: boolean;
  /** Add-on: strong profanity masked ("s***") in every output format. +$0.01 per audio hour. */
  filterProfanity?: boolean;
  /** Speaker-aware paragraphs in the JSON output (`transcript.paragraphs`). Free. */
  paragraphs?: boolean;
  /**
   * Chapters covering the whole recording (`transcript.chapters`). Billed with summarization:
   * +$0.02 per audio hour, once, with or without `summarize`.
   */
  autoChapters?: boolean;
  /**
   * Speaker identification: the names or roles who may be speaking (up to 20). Each diarized
   * speaker is matched to one, or left unnamed (`transcript.speakerNames`). Needs `speakerLabels`.
   * +$0.02 per audio hour.
   */
  knownSpeakers?: string[];
  /**
   * PII redaction in every output format: names, organisations, places, addresses, dates,
   * account / card / phone / SSN / IP numbers. +$0.08 per audio hour.
   */
  redactPii?: boolean;
  /** Narrow `redactPii` to these types (default all; see {@link PII_POLICIES}). Sent only with `redactPii`. */
  redactPiiPolicies?: (PiiPolicy | string)[];
  /** `"entity_name"` (`[PERSON_NAME]`, the default) or `"hash"` (`####`). Sent only with `redactPii`. */
  redactPiiSub?: "entity_name" | "hash";
  /** Entity detection (`transcript.entities`): the same types, typed and timed. +$0.08 per audio hour. */
  entityDetection?: boolean;
  /** Keep (true) or drop (false) fillers and false starts. Omit for the server default. */
  verbatim?: boolean;
  /** Any other API option, sent as given (snake_case, as the API names it). */
  extra?: Record<string, unknown>;
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
  Pick<
    TranscribeOptions,
    | "customVocabulary"
    | "language"
    | "callbackUrl"
    | "summarize"
    | "filterProfanity"
    | "paragraphs"
    | "autoChapters"
    | "knownSpeakers"
    | "redactPii"
    | "redactPiiPolicies"
    | "redactPiiSub"
    | "entityDetection"
    | "verbatim"
    | "extra"
  > {
  const speakerLabels =
    options.diarize !== undefined
      ? options.diarize
      : options.speakerLabels !== undefined
        ? options.speakerLabels
        : false;
  return {
    outputType: options.outputType ?? "json",
    wordTimestamps: options.wordTimestamps ?? true,
    speakerLabels,
    nltk: options.nltk ?? true,
    tier: options.tier ?? "standard",
    customVocabulary: options.customVocabulary,
    language: options.language,
    callbackUrl: options.callbackUrl,
    summarize: options.summarize,
    filterProfanity: options.filterProfanity,
    paragraphs: options.paragraphs,
    autoChapters: options.autoChapters,
    knownSpeakers: options.knownSpeakers,
    redactPii: options.redactPii,
    redactPiiPolicies: options.redactPiiPolicies,
    redactPiiSub: options.redactPiiSub,
    entityDetection: options.entityDetection,
    verbatim: options.verbatim,
    extra: options.extra,
  };
}
