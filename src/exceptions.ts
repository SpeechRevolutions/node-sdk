/** SDK exception hierarchy.
 *
 * Every error carries the HTTP `statusCode` and the server `requestId` (from the
 * response headers, when present) so failures can be correlated with server
 * logs. `RateLimitError` also exposes `retryAfter` seconds.
 */

export interface SpeechRevolutionsErrorOptions {
  statusCode?: number;
  requestId?: string;
  body?: string;
}

export class SpeechRevolutionsError extends Error {
  statusCode?: number;
  requestId?: string;
  body?: string;

  constructor(message: string, opts?: SpeechRevolutionsErrorOptions) {
    super(opts?.requestId ? `${message} (request_id=${opts.requestId})` : message);
    this.name = "SpeechRevolutionsError";
    this.statusCode = opts?.statusCode;
    this.requestId = opts?.requestId;
    this.body = opts?.body;
  }
}

export class AuthenticationError extends SpeechRevolutionsError {
  constructor(message = "Unauthorized — check your API key", opts?: SpeechRevolutionsErrorOptions) {
    super(message, opts);
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends SpeechRevolutionsError {
  retryAfter?: number;

  constructor(
    message = "Rate limit exceeded — try again shortly",
    opts?: SpeechRevolutionsErrorOptions & { retryAfter?: number },
  ) {
    super(message, opts);
    this.name = "RateLimitError";
    this.retryAfter = opts?.retryAfter;
  }
}

export class JobNotFoundError extends SpeechRevolutionsError {
  constructor(
    message = "Job not found or upload session expired",
    opts?: SpeechRevolutionsErrorOptions,
  ) {
    super(message, opts);
    this.name = "JobNotFoundError";
  }
}

export class JobFailedError extends SpeechRevolutionsError {
  step?: string;
  reason?: string;

  constructor(
    message: string,
    opts?: SpeechRevolutionsErrorOptions & { step?: string; reason?: string },
  ) {
    super(message, opts);
    this.name = "JobFailedError";
    this.step = opts?.step;
    this.reason = opts?.reason;
  }
}

export class UploadError extends SpeechRevolutionsError {
  constructor(message: string, opts?: SpeechRevolutionsErrorOptions) {
    super(message, opts);
    this.name = "UploadError";
  }
}

export class TimeoutError extends SpeechRevolutionsError {
  constructor(message: string, opts?: SpeechRevolutionsErrorOptions) {
    super(message, opts);
    this.name = "TimeoutError";
  }
}

export class APIError extends SpeechRevolutionsError {
  constructor(message: string, opts?: SpeechRevolutionsErrorOptions) {
    super(message, opts);
    this.name = "APIError";
  }
}
