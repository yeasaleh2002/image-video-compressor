import {
  DimensionLimitError, PayloadTooLargeError, SsrfBlockedError, UnsupportedMediaError, ValidationError,
} from '../errors.js';
import type {
  DetectedMedia, ImageOutputFormat, MediaKind, OptimizationOptions, SecurityLimits, VideoPreset,
} from '../types.js';
import { isBlockedIp, isIpLiteral } from './ip.js';

export const DEFAULT_LIMITS: SecurityLimits = {
  maxImageBytes: 25 * 1024 * 1024,
  maxVideoBytes: 500 * 1024 * 1024,
  maxDimension: 8192,
  maxPixels: 8192 * 8192,
  maxAnimationFrames: 1000,
  maxVideoDurationSeconds: 600,
  fetchTimeoutMs: 10_000,
  fetchRetries: 3,
  maxRedirects: 3,
  allowedPorts: [80, 443],
  imageTimeoutMs: 60_000,
  videoTimeoutMs: 10 * 60_000,
};

export interface NormalizedOptions {
  mediaType: 'image' | 'video' | 'auto';
  image: { quality: number; format: ImageOutputFormat; lossless: boolean };
  video: { crf: number; preset: VideoPreset; audioBitrate: string; removeAudio: boolean };
}

const IMAGE_FORMATS: readonly ImageOutputFormat[] = ['webp', 'avif', 'jpeg', 'png', 'auto'];
const VIDEO_PRESETS: readonly VideoPreset[] = ['ultrafast', 'superfast', 'fast', 'medium'];

const BLOCKED_HOSTNAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /^metadata$/i];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new ValidationError(`Unknown option "${where}.${k}"`);
  }
}

function intInRange(v: unknown, min: number, max: number, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return v;
}

export class SecurityGuard {
  readonly limits: SecurityLimits;

  constructor(limits: Partial<SecurityLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  normalizeOptions(raw: unknown): NormalizedOptions {
    const input = raw ?? { mediaType: 'auto' };
    if (!isPlainObject(input)) throw new ValidationError('options must be an object');
    rejectUnknownKeys(input, ['mediaType', 'imageSettings', 'videoSettings'], 'options');

    const mediaType = input.mediaType ?? 'auto';
    if (mediaType !== 'image' && mediaType !== 'video' && mediaType !== 'auto') {
      throw new ValidationError('mediaType must be "image", "video" or "auto"');
    }

    const img = input.imageSettings ?? {};
    if (!isPlainObject(img)) throw new ValidationError('imageSettings must be an object');
    rejectUnknownKeys(img, ['quality', 'format', 'lossless'], 'imageSettings');
    const quality = img.quality === undefined ? 80 : intInRange(img.quality, 1, 100, 'imageSettings.quality');
    const format = (img.format ?? 'auto') as ImageOutputFormat;
    if (!IMAGE_FORMATS.includes(format)) throw new ValidationError(`imageSettings.format must be one of ${IMAGE_FORMATS.join(', ')}`);
    if (img.lossless !== undefined && typeof img.lossless !== 'boolean') throw new ValidationError('imageSettings.lossless must be a boolean');
    const lossless = img.lossless === true;
    if (lossless && format === 'jpeg') throw new ValidationError('JPEG cannot be lossless; use webp, avif or png');

    const vid = input.videoSettings ?? {};
    if (!isPlainObject(vid)) throw new ValidationError('videoSettings must be an object');
    rejectUnknownKeys(vid, ['crf', 'preset', 'audioBitrate', 'removeAudio'], 'videoSettings');
    const crf = vid.crf === undefined ? 28 : intInRange(vid.crf, 0, 51, 'videoSettings.crf');
    const preset = (vid.preset ?? 'fast') as VideoPreset;
    if (!VIDEO_PRESETS.includes(preset)) throw new ValidationError(`videoSettings.preset must be one of ${VIDEO_PRESETS.join(', ')}`);

    const audioBitrate = vid.audioBitrate ?? '96k';
    const m = typeof audioBitrate === 'string' ? /^(\d{2,3})k$/.exec(audioBitrate) : null;
    if (!m || Number(m[1]) < 16 || Number(m[1]) > 320) throw new ValidationError('videoSettings.audioBitrate must look like "64k" (16k-320k)');
    if (vid.removeAudio !== undefined && typeof vid.removeAudio !== 'boolean') throw new ValidationError('videoSettings.removeAudio must be a boolean');

    return {
      mediaType,
      image: { quality, format, lossless },
      video: { crf, preset, audioBitrate: audioBitrate as string, removeAudio: vid.removeAudio === true },
    };
  }

  maxBytesFor(kind: MediaKind | 'unknown'): number {
    if (kind === 'image') return this.limits.maxImageBytes;
    if (kind === 'video') return this.limits.maxVideoBytes;
    return Math.max(this.limits.maxImageBytes, this.limits.maxVideoBytes);
  }

  assertSize(bytes: number, kind: MediaKind | 'unknown'): void {
    if (!Number.isFinite(bytes) || bytes < 0) throw new ValidationError('Invalid input size');
    if (bytes === 0) throw new ValidationError('Input is empty');
    const max = this.maxBytesFor(kind);
    if (bytes > max) throw new PayloadTooLargeError(`Input exceeds the ${Math.floor(max / 1024 / 1024)} MiB limit`);
  }

  assertBase64Size(b64Length: number): void {
    this.assertSize(Math.floor((b64Length * 3) / 4), 'unknown');
  }

  assertDetected(detected: DetectedMedia, requested: NormalizedOptions['mediaType'], bytes?: number): void {
    if (requested !== 'auto' && requested !== detected.kind) {
      throw new UnsupportedMediaError(`Expected ${requested} but content is ${detected.kind}/${detected.format}`);
    }
    if (bytes !== undefined) this.assertSize(bytes, detected.kind);
    if (detected.width !== undefined && detected.height !== undefined) {
      this.assertDimensions(detected.width, detected.height);
    }
  }

  assertDimensions(width: number, height: number, frames = 1): void {
    const { maxDimension, maxPixels, maxAnimationFrames } = this.limits;
    if (width > maxDimension || height > maxDimension) {
      throw new DimensionLimitError(`Dimensions ${width}x${height} exceed the ${maxDimension}px limit`);
    }
    if (width * height > maxPixels) throw new DimensionLimitError('Pixel count exceeds the limit');
    if (frames > maxAnimationFrames) throw new DimensionLimitError(`Animation has more than ${maxAnimationFrames} frames`);
  }

  assertDuration(seconds: number | undefined): void {
    if (seconds !== undefined && seconds > this.limits.maxVideoDurationSeconds) {
      throw new DimensionLimitError(`Video longer than ${this.limits.maxVideoDurationSeconds}s`);
    }
  }

  validateUrl(raw: string): URL {
    if (typeof raw !== 'string' || raw.length > 2048) throw new ValidationError('url must be a string up to 2048 chars');
    let url: URL;
    try { url = new URL(raw); } catch { throw new ValidationError('url is not a valid absolute URL'); }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfBlockedError('Only http and https URLs are allowed');
    if (url.username || url.password) throw new SsrfBlockedError('URLs with credentials are not allowed');

    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!this.limits.allowedPorts.includes(port)) throw new SsrfBlockedError(`Port ${port} is not allowed`);

    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host) throw new SsrfBlockedError('URL has no host');
    if (BLOCKED_HOSTNAMES.some((re) => re.test(host))) throw new SsrfBlockedError();
    if (isIpLiteral(host) && isBlockedIp(host)) throw new SsrfBlockedError();
    return url;
  }
}
