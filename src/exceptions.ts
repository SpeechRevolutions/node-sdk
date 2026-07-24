/** SDK exception hierarchy.
 *
 * Every error carries the HTTP `statusCode` and the server `requestId` (from the
 * response headers, when present) so failures can be correlated with server
 * logs. `RateLimitError` also exposes `retryAfter` seconds.
 */

export interface STTErrorOptions {
  statusCode?: number;
  requestId?: string;
  body?: string;
}

export class STTError extends Error {
  statusCode?: number;
  requestId?: string;
  body?: string;

  constructor(message: string, opts?: STTErrorOptions) {
    super(opts?.requestId ? `${message} (request_id=${opts.requestId})` : message);
    this.name = "STTError";
    this.statusCode = opts?.statusCode;
    this.requestId = opts?.requestId;
    this.body = opts?.body;
  }
}

export class AuthenticationError extends STTError {
  constructor(message = "Unauthorized — check your API key", opts?: STTErrorOptions) {
    super(message, opts);
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends STTError {
  retryAfter?: number;

  constructor(
    message = "Rate limit exceeded — try again shortly",
    opts?: STTErrorOptions & { retryAfter?: number },
  ) {
    super(message, opts);
    this.name = "RateLimitError";
    this.retryAfter = opts?.retryAfter;
  }
}

export class JobNotFoundError extends STTError {
  constructor(
    message = "Job not found or upload session expired",
    opts?: STTErrorOptions,
  ) {
    super(message, opts);
    this.name = "JobNotFoundError";
  }
}

export class JobFailedError extends STTError {
  step?: string;
  reason?: string;

  constructor(
    message: string,
    opts?: STTErrorOptions & { step?: string; reason?: string },
  ) {
    super(message, opts);
    this.name = "JobFailedError";
    this.step = opts?.step;
    this.reason = opts?.reason;
  }
}

export class UploadError extends STTError {
  constructor(message: string, opts?: STTErrorOptions) {
    super(message, opts);
    this.name = "UploadError";
  }
}

export class TimeoutError extends STTError {
  constructor(message: string, opts?: STTErrorOptions) {
    super(message, opts);
    this.name = "TimeoutError";
  }
}

export class APIError extends STTError {
  constructor(message: string, opts?: STTErrorOptions) {
    super(message, opts);
    this.name = "APIError";
  }
}
