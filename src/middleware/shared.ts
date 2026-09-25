import { ValidationError } from '../errors.js';
import type { MediaInput, OptimizationOptions } from '../types.js';

export interface ParsedJsonRequest {
  input: MediaInput;
  options: OptimizationOptions | undefined;
}

export interface HttpAdapterConfig {
  maxJsonBytes?: number;
  maxBinaryBytes?: number;
  allowUrlInput?: boolean;
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

export function parseJsonBody(body: unknown, cfg: HttpAdapterConfig): ParsedJsonRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('Body must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (k !== 'options' && k !== 'data' && k !== 'url') throw new ValidationError(`Unknown field "${k}"`);
  }
  const options = b.options as OptimizationOptions | undefined;

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

export function parseOptionsHeader(value: string | null | undefined): OptimizationOptions | undefined {
  if (!value) return undefined;
  if (value.length > 4096) throw new ValidationError('X-Optimize-Options header too large');
  try {
    return JSON.parse(value) as OptimizationOptions;
  } catch {
    throw new ValidationError('X-Optimize-Options must be valid JSON');
  }
}

export function metricHeaders(r: { originalSize: number; optimizedSize: number; compressionRatio: string; format: string }): Record<string, string> {
  return {
    'X-Optimize-Original-Size': String(r.originalSize),
    'X-Optimize-Optimized-Size': String(r.optimizedSize),
    'X-Optimize-Compression-Ratio': r.compressionRatio,
    'X-Optimize-Format': r.format,
  };
}
