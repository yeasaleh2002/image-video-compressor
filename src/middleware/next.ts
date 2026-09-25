import type { MediaOptimizer } from '../core/MediaOptimizer.js';
import { PayloadTooLargeError, toErrorResponse, UnsupportedMediaError, ValidationError } from '../errors.js';
import {
  DEFAULT_MAX_BINARY, DEFAULT_MAX_JSON, type HttpAdapterConfig, isBinaryContentType, isJsonContentType,
  metricHeaders, parseJsonBody, parseOptionsHeader, SECURITY_HEADERS,
} from './shared.js';

export interface NextHandlerConfig extends HttpAdapterConfig {
  optimizer: MediaOptimizer;
}

async function readCapped(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new PayloadTooLargeError('Request body too large');
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new PayloadTooLargeError('Request body too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function createNextRouteHandler(config: NextHandlerConfig): (req: Request) => Promise<Response> {
  const { optimizer } = config;
  const maxJson = config.maxJsonBytes ?? DEFAULT_MAX_JSON;
  const maxBinary = config.maxBinaryBytes ?? DEFAULT_MAX_BINARY;

  return async function POST(req: Request): Promise<Response> {
    try {
      const ct = req.headers.get('content-type');

      if (isJsonContentType(ct)) {
        const raw = await readCapped(req, maxJson);
        let body: unknown;
        try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new ValidationError('Malformed JSON'); }
        const { input, options } = parseJsonBody(body, config);
        return json(await optimizer.optimize(input, options), 200);
      }

      if (isBinaryContentType(ct)) {
        const options = parseOptionsHeader(req.headers.get('x-optimize-options'));
        const raw = await readCapped(req, maxBinary);
        const result = await optimizer.optimize(raw, options);
        const bytes = result.data as Uint8Array;
        return new Response(bytes as Uint8Array<ArrayBuffer>, {
          status: 200,
          headers: {
            ...SECURITY_HEADERS,
            'Content-Type': result.details.mimeType,
            'Content-Length': String(bytes.byteLength),
            ...metricHeaders(result),
          },
        });
      }

      throw new UnsupportedMediaError('Content-Type must be application/json, application/octet-stream, image/* or video/*');
    } catch (err) {
      const payload = toErrorResponse(err);
      if (payload.code >= 500) (config.onError ?? ((e) => console.error('[image-video-compressor]', e)))(err);
      return json(payload, payload.code);
    }
  };
}
