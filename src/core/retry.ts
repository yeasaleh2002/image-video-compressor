/**
 * @file Exponential backoff with full jitter.
 *
 * Only *transient* failures are retried (network resets, timeouts, 408/429/5xx).
 * Security rejections and 4xx responses fail immediately — retrying an SSRF
 * block would just hammer the guard.
 */

export interface RetryOptions {
  /** Total attempts including the first. */
  attempts: number;
  /** First backoff ceiling in ms. Default 250. */
  baseDelayMs?: number;
  /** Largest backoff ceiling in ms. Default 4000. */
  maxDelayMs?: number;
  /** Return `false` to stop retrying and rethrow immediately. */
  shouldRetry: (err: unknown, attempt: number) => boolean;
  signal?: AbortSignal;
}

/** Marks an error as retryable (used by fetchers for 5xx / network failures). */
export class TransientError extends Error {
  constructor(message: string, readonly retryAfterMs?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientError';
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 250;
  const cap = opts.maxDelayMs ?? 4000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === opts.attempts || !opts.shouldRetry(err, attempt)) throw err;
      // Full jitter: uniform in [0, min(cap, base * 2^(n-1))]. Honour Retry-After when larger.
      const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
      let delay = Math.random() * ceiling;
      if (err instanceof TransientError && err.retryAfterMs) delay = Math.min(cap, Math.max(delay, err.retryAfterMs));
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}

/** Parses a Retry-After header (seconds or HTTP date) into ms. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
