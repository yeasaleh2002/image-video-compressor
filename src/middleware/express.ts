import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MediaOptimizer } from '../core/MediaOptimizer.js';
import { OptimizerError, PayloadTooLargeError, toErrorResponse, UnsupportedMediaError, ValidationError } from '../errors.js';
import {
  DEFAULT_MAX_BINARY, DEFAULT_MAX_JSON, type HttpAdapterConfig, isBinaryContentType, isJsonContentType,
  metricHeaders, parseJsonBody, parseOptionsHeader, SECURITY_HEADERS,
} from './shared.js';

export interface ExpressMiddlewareConfig extends HttpAdapterConfig {
  optimizer: MediaOptimizer;
}

type Req = IncomingMessage & { body?: unknown };
type Next = (err?: unknown) => void;

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      return reject(new PayloadTooLargeError('Request body too large'));
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > max) {
        req.removeAllListeners('data');
        req.resume();
        reject(new PayloadTooLargeError('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string>): void {
  if (res.headersSent) return;
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, 'Content-Length': String(Buffer.byteLength(body)) });
  res.end(body);
}

function sendError(res: ServerResponse, err: unknown, cfg: HttpAdapterConfig): void {
  const payload = toErrorResponse(err);
  if (payload.code >= 500) (cfg.onError ?? ((e) => console.error('[image-video-compressor]', e)))(err);
  send(res, payload.code, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8' });
}

export function optimizeMiddleware(config: ExpressMiddlewareConfig) {
  const { optimizer } = config;
  const maxJson = config.maxJsonBytes ?? DEFAULT_MAX_JSON;
  const maxBinary = config.maxBinaryBytes ?? DEFAULT_MAX_BINARY;

  return async function secureOptimize(req: Req, res: ServerResponse, _next?: Next): Promise<void> {
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new OptimizerError('Method not allowed', 405);
      }
      const ct = req.headers['content-type'];

      if (isJsonContentType(ct)) {
        let body = req.body;
        if (body === undefined || Buffer.isBuffer(body)) {
          const raw = Buffer.isBuffer(body) ? body : await readBody(req, maxJson);
          if (raw.length > maxJson) throw new PayloadTooLargeError('Request body too large');
          try { body = JSON.parse(raw.toString('utf8')); } catch { throw new ValidationError('Malformed JSON'); }
        }
        const { input, options } = parseJsonBody(body, config);
        const result = await optimizer.optimize(input, options);
        send(res, 200, JSON.stringify(result), { 'Content-Type': 'application/json; charset=utf-8' });
        return;
      }

      if (isBinaryContentType(ct)) {
        const options = parseOptionsHeader(req.headers['x-optimize-options'] as string | undefined);
        const raw = Buffer.isBuffer(req.body) ? req.body : await readBody(req, maxBinary);
        if (raw.length > maxBinary) throw new PayloadTooLargeError('Request body too large');
        const result = await optimizer.optimize(raw, options);
        send(res, 200, result.data as Buffer, {
          'Content-Type': result.details.mimeType,
          'Content-Disposition': `attachment; filename="optimized.${result.format === 'jpeg' ? 'jpg' : result.format}"`,
          ...metricHeaders(result),
        });
        return;
      }

      throw new UnsupportedMediaError('Content-Type must be application/json, application/octet-stream, image/* or video/*');
    } catch (err) {
      sendError(res, err, config);
    }
  };
}
