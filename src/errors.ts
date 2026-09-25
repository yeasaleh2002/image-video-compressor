import type { OptimizationErrorResponse } from './types.js';

export class OptimizerError extends Error {
  readonly code: number;

  constructor(message: string, code = 500, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }

  toJSON(): OptimizationErrorResponse {
    return { success: false, error: this.message, code: this.code };
  }
}

export class ValidationError extends OptimizerError {
  constructor(message: string) { super(message, 400); }
}

export class SsrfBlockedError extends OptimizerError {
  constructor(message = 'URL destination is not allowed') { super(message, 403); }
}

export class PathTraversalError extends OptimizerError {
  constructor(message = 'Path is outside the allowed directories') { super(message, 403); }
}

export class PayloadTooLargeError extends OptimizerError {
  constructor(message: string) { super(message, 413); }
}

export class DimensionLimitError extends OptimizerError {
  constructor(message: string) { super(message, 413); }
}

export class UnsupportedMediaError extends OptimizerError {
  constructor(message = 'Unsupported media type') { super(message, 415); }
}

export class CorruptMediaError extends OptimizerError {
  constructor(message = 'Media is corrupt or truncated', options?: { cause?: unknown }) {
    super(message, 422, options);
  }
}

export class FetchFailedError extends OptimizerError {
  constructor(message: string, options?: { cause?: unknown }) { super(message, 502, options); }
}

export class QueueFullError extends OptimizerError {
  constructor(message = 'Server busy, try again later') { super(message, 503); }
}

export class ProcessingTimeoutError extends OptimizerError {
  constructor(message = 'Processing timed out') { super(message, 504); }
}

export class ProcessingError extends OptimizerError {
  constructor(message = 'Media processing failed', options?: { cause?: unknown }) {
    super(message, 500, options);
  }
}

export function toErrorResponse(err: unknown): OptimizationErrorResponse {
  if (err instanceof OptimizerError) return err.toJSON();
  return { success: false, error: 'Internal processing error', code: 500 };
}
