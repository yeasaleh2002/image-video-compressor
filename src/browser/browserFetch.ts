/**
 * @file Browser URL fetching with CORS-aware errors, per-attempt timeout,
 * streaming byte cap and exponential-backoff retry.
 *
 * Browsers hide resolved IPs and cross-origin redirect targets from scripts,
 * so the SSRF guard here is the static `validateUrl` check. That's adequate:
 * a browser request runs with the *user's* network position, not a server's,
 * and the browser's own Private Network Access rules apply on top.
 */
import { parseRetryAfter, TransientError, withRetry } from '../core/retry.js';
import { FetchFailedError, OptimizerError, PayloadTooLargeError } from '../errors.js';
import type { SecurityGuard } from '../security/SecurityGuard.js';

/** `AbortSignal.any` fallback for browsers that predate it. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (native) return native(signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  return c.signal;
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new PayloadTooLargeError('Remote file exceeds the size limit');
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new PayloadTooLargeError('Remote file exceeds the size limit');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

export async function browserFetch(rawUrl: string, guard: SecurityGuard, outer: AbortSignal): Promise<Uint8Array> {
  const url = guard.validateUrl(rawUrl);
  const max = guard.maxBytesFor('unknown');
  try {
    return await withRetry(async () => {
      let res: Response;
      try {
        res = await fetch(url, {
          mode: 'cors',
          credentials: 'omit',          // never leak the user's cookies to third parties
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          signal: anySignal([outer, timeoutSignal(guard.limits.fetchTimeoutMs)]),
        });
      } catch (err) {
        // A CORS rejection and a network outage are indistinguishable to scripts
        // (both are TypeError). Treat as transient; the final error mentions CORS.
        throw new TransientError('Network or CORS failure', undefined, { cause: err });
      }
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        throw new TransientError(`Upstream responded ${res.status}`, parseRetryAfter(res.headers.get('retry-after')));
      }
      if (!res.ok) throw new FetchFailedError(`Upstream responded ${res.status}`);
      return readCapped(res, max);
    }, {
      attempts: guard.limits.fetchRetries,
      signal: outer,
      shouldRetry: (err) => !outer.aborted && !(err instanceof OptimizerError),
    });
  } catch (err) {
    if (err instanceof OptimizerError) throw err;
    throw new FetchFailedError(
      'Could not fetch the URL. If it is on another origin, the server must send Access-Control-Allow-Origin.',
      { cause: err },
    );
  }
}
