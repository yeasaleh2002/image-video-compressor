/**
 * @file SSRF-hardened HTTP(S) downloader for Node.
 *
 * Defences, in order:
 *  1. `SecurityGuard.validateUrl` — scheme (http/https only), no credentials,
 *     port allow-list, hostname deny-list, IP-literal range check.
 *  2. **DNS pinning.** We pass a custom `lookup` to the socket. It resolves
 *     *all* A/AAAA records, rejects the request if *any* is non-public, and the
 *     socket then connects to exactly that vetted address. There is no second
 *     resolution, so DNS-rebinding (public IP at check time, 127.0.0.1 at
 *     connect time) is impossible.
 *  3. **Manual redirects.** Each hop goes back through steps 1-2 (max N hops),
 *     so `https://good.com → http://169.254.169.254/` is blocked.
 *  4. **Hard caps.** 10 s per attempt (connect + headers + body), streaming
 *     byte counter that aborts as soon as the limit is crossed (Content-Length
 *     is checked early but never trusted), `Accept-Encoding: identity` so no
 *     gzip bombs are inflated.
 *  5. **Retry** with exponential backoff + jitter for transient failures only.
 */
import { lookup as dnsLookup } from 'node:dns';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseRetryAfter, TransientError, withRetry } from '../core/retry.js';
import {
  FetchFailedError, OptimizerError, PayloadTooLargeError, SsrfBlockedError, UnsupportedMediaError,
} from '../errors.js';
import { isBlockedIp } from '../security/ip.js';
import type { SecurityGuard } from '../security/SecurityGuard.js';

const USER_AGENT = 'image-video-compressor/1.0';
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_SOCKET']);

/** Resolves every address and fails closed if any one of them is internal. */
const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    if (addresses.length === 0 || addresses.some((a) => isBlockedIp(a.address))) {
      // Node's lookup callback is typed for ErrnoException; our error still propagates as the request error.
      return callback(new SsrfBlockedError() as unknown as NodeJS.ErrnoException, '', 0);
    }
    // Node >= 20 may ask for all addresses (happy-eyeballs); older versions want one.
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
};

function request(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'GET',
      lookup: pinnedLookup,
      agent: false, // fresh socket per request: no pooled connection to an unvetted IP
      signal,
      maxHeaderSize: 16 * 1024,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'image/*,video/*;q=0.9,*/*;q=0.1',
        'accept-encoding': 'identity',
      },
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

/** Counts bytes and errors the pipeline the moment `max` is crossed. */
function byteLimiter(max: number, onChunk?: (chunk: Buffer) => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > max) return cb(new PayloadTooLargeError(`Remote file exceeds the ${Math.floor(max / 1048576)} MiB limit`));
      onChunk?.(chunk);
      cb(null, chunk);
    },
  });
}

async function downloadOnce(
  startUrl: string, guard: SecurityGuard, dest: string, maxBytes: number, outer: AbortSignal,
): Promise<number> {
  let current = startUrl;
  for (let hop = 0; hop <= guard.limits.maxRedirects; hop++) {
    const url = guard.validateUrl(current);
    const signal = AbortSignal.any([outer, AbortSignal.timeout(guard.limits.fetchTimeoutMs)]);
    const res = await request(url, signal);
    const status = res.statusCode ?? 0;

    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume(); // drain; we don't want the body
      current = new URL(res.headers.location, url).toString();
      continue;
    }
    if (status === 408 || status === 429 || status >= 500) {
      res.resume();
      throw new TransientError(`Upstream responded ${status}`, parseRetryAfter(res.headers['retry-after']));
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new FetchFailedError(`Upstream responded ${status}`);
    }
    const encoding = (res.headers['content-encoding'] ?? 'identity').toLowerCase();
    if (encoding !== 'identity') {
      res.resume();
      throw new UnsupportedMediaError(`Compressed transfer encoding "${encoding}" is not accepted`);
    }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      throw new PayloadTooLargeError(`Remote file exceeds the ${Math.floor(maxBytes / 1048576)} MiB limit`);
    }

    let size = 0;
    await pipeline(res, byteLimiter(maxBytes, (c) => { size += c.length; }), createWriteStream(dest, { flags: 'wx' }), { signal });
    return size;
  }
  throw new SsrfBlockedError(`More than ${guard.limits.maxRedirects} redirects`);
}

/**
 * Streams a remote file to `dest` (never buffered in memory).
 * @returns Bytes written.
 */
export async function safeDownload(
  url: string, guard: SecurityGuard, dest: string, signal: AbortSignal,
): Promise<number> {
  const maxBytes = guard.maxBytesFor('unknown');
  let attemptNo = 0;
  try {
    return await withRetry(
      async () => {
        attemptNo++;
        // Each attempt writes a fresh file; `wx` refuses to clobber, so remove a partial one first.
        if (attemptNo > 1) await rm(dest, { force: true });
        return downloadOnce(url, guard, dest, maxBytes, signal);
      },
      {
        attempts: guard.limits.fetchRetries,
        signal,
        shouldRetry: (err) => {
          if (signal.aborted) return false;
          if (err instanceof TransientError) return true;
          if (err instanceof OptimizerError) return false; // security / size / 4xx: permanent
          const e = err as { code?: string; name?: string };
          return RETRYABLE_CODES.has(e.code ?? '') || e.name === 'TimeoutError' || e.name === 'AbortError';
        },
      },
    );
  } catch (err) {
    if (err instanceof OptimizerError) throw err;
    throw new FetchFailedError('Could not download the URL', { cause: err });
  }
}
