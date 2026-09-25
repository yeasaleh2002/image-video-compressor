/**
 * @file Framework-neutral request parsing shared by the Express and Next.js
 * adapters.
 *
 * Wire formats:
 *  - **JSON** (`Content-Type: application/json`):
 *      `{ "options": OptimizationOptions, "data": "<base64 | data: URL>" }`
 *   or `{ "options": OptimizationOptions, "url": "https://…" }`
 *    → JSON response; `data` comes back in the same encoding it was sent in.
 *  - **Binary** (`application/octet-stream`, `image/*`, `video/*`): the body is
 *    the file; options go in the `X-Optimize-Options` header as JSON
 *    → binary response, metrics in `X-Optimize-*` headers.
 *
 * `{ path }` inputs are deliberately **not reachable over HTTP**: a network
 * client must never be able to name files on the server.
 */
import { ValidationError } from '../errors.js';
import type { MediaInput, OptimizationOptions } from '../types.js';

export interface ParsedJsonRequest {
  input: MediaInput;
  options: OptimizationOptions | undefined;
}

export interface HttpAdapterConfig {
  /** Max JSON body bytes. Default 35 MiB (≈ 25 MiB image after base64 overhead). */
  maxJsonBytes?: number;
  /** Max raw binary body bytes. Default 100 MiB. */
  maxBinaryBytes?: number;
  /** Allow `{ url }` in JSON bodies (server-side fetch, SSRF-guarded). Default `true`. */
  allowUrlInput?: boolean;
  /** Called for every failure with status >= 500 (log it; the client only sees a generic message). */
  onError?: (err: unknown) => void;
}

export const DEFAULT_MAX_JSON = 35 * 1024 * 1024;
export const DEFAULT_MAX_BINARY = 100 * 1024 * 1024;

export const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
};

export function isJsonContentType(ct: string | null | undefined): boolean {
  return /^application\/json\b/i.test(ct ?? '');
}

export function isBinaryContentType(ct: string | null | undefined): boolean {
  return /^(application\/octet-stream|image\/[\w.+-]+|video\/[\w.+-]+)\b/i.test(ct ?? '');
}

/** Validates an already-parsed JSON body. Accepts exactly one of `data` / `url`. */
export function parseJsonBody(body: unknown, cfg: HttpAdapterConfig): ParsedJsonRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('Body must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (k !== 'options' && k !== 'data' && k !== 'url') throw new ValidationError(`Unknown field "${k}"`);
  }
  const options = b.options as OptimizationOptions | undefined; // validated by SecurityGuard.normalizeOptions

  if (typeof b.data === 'string' && b.url === undefined) {
    const input: MediaInput = b.data.startsWith('data:') ? (b.data as `data:${string}`) : { base64: b.data };
    return { input, options };
  }
  if (typeof b.url === 'string' && b.data === undefined) {
    if (cfg.allowUrlInput === false) throw new ValidationError('URL inputs are disabled');
    return { input: { url: b.url }, options };
  }
  throw new ValidationError('Provide exactly one of "data" (base64 / data URL) or "url"');
}

/** Parses the `X-Optimize-Options` header used by binary uploads. */
export function parseOptionsHeader(value: string | null | undefined): OptimizationOptions | undefined {
  if (!value) return undefined;
  if (value.length > 4096) throw new ValidationError('X-Optimize-Options header too large');
  try {
    return JSON.parse(value) as OptimizationOptions;
  } catch {
    throw new ValidationError('X-Optimize-Options must be valid JSON');
  }
}

/** Metric headers for binary responses. */
export function metricHeaders(r: { originalSize: number; optimizedSize: number; compressionRatio: string; format: string }): Record<string, string> {
  return {
    'X-Optimize-Original-Size': String(r.originalSize),
    'X-Optimize-Optimized-Size': String(r.optimizedSize),
    'X-Optimize-Compression-Ratio': r.compressionRatio,
    'X-Optimize-Format': r.format,
  };
}
