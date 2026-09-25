/**
 * @file Error taxonomy. Every error the package throws on purpose is an
 * {@link OptimizerError} carrying an HTTP-compatible `code`, so middleware can
 * map it straight to a response without string matching.
 *
 * Messages are written to be safe to show to API clients: they never include
 * resolved file-system paths, internal IPs or stack traces.
 */
import type { OptimizationErrorResponse } from './types.js';

export class OptimizerError extends Error {
  /** HTTP-compatible status code. */
  readonly code: number;

  constructor(message: string, code = 500, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }

  /** The standard failure envelope: `{ success: false, error, code }`. */
  toJSON(): OptimizationErrorResponse {
    return { success: false, error: this.message, code: this.code };
  }
}

/** 400 — malformed options or input. */
export class ValidationError extends OptimizerError {
  constructor(message: string) { super(message, 400); }
}

/** 403 — URL points at a private / loopback / link-local / disallowed destination. */
export class SsrfBlockedError extends OptimizerError {
  constructor(message = 'URL destination is not allowed') { super(message, 403); }
}

/** 403 — path escapes the configured root, is a symlink out, or path inputs are disabled. */
export class PathTraversalError extends OptimizerError {
  constructor(message = 'Path is outside the allowed directories') { super(message, 403); }
}

/** 413 — byte size above the configured limit. */
export class PayloadTooLargeError extends OptimizerError {
  constructor(message: string) { super(message, 413); }
}

/** 413 — pixel / frame / duration limits exceeded (decompression bomb guard). */
export class DimensionLimitError extends OptimizerError {
  constructor(message: string) { super(message, 413); }
}

/** 415 — magic numbers don't match any allow-listed format, or don't match the requested mediaType. */
export class UnsupportedMediaError extends OptimizerError {
  constructor(message = 'Unsupported media type') { super(message, 415); }
}

/** 422 — recognised format, but the header/body is damaged or truncated. */
export class CorruptMediaError extends OptimizerError {
  constructor(message = 'Media is corrupt or truncated', options?: { cause?: unknown }) {
    super(message, 422, options);
  }
}

/** 502 — remote fetch failed after all retries (includes browser CORS rejections). */
export class FetchFailedError extends OptimizerError {
  constructor(message: string, options?: { cause?: unknown }) { super(message, 502, options); }
}

/** 503 — the job queue is full; the client should retry later. */
export class QueueFullError extends OptimizerError {
  constructor(message = 'Server busy, try again later') { super(message, 503); }
}

/** 504 — a job exceeded its processing time budget and was killed. */
export class ProcessingTimeoutError extends OptimizerError {
  constructor(message = 'Processing timed out') { super(message, 504); }
}

/** 500 — encoder failure that isn't attributable to the input. */
export class ProcessingError extends OptimizerError {
  constructor(message = 'Media processing failed', options?: { cause?: unknown }) {
    super(message, 500, options);
  }
}

/**
 * Converts anything thrown into the standard failure envelope. Unknown errors
 * are reported generically so internals never leak to clients.
 */
export function toErrorResponse(err: unknown): OptimizationErrorResponse {
  if (err instanceof OptimizerError) return err.toJSON();
  return { success: false, error: 'Internal processing error', code: 500 };
}
