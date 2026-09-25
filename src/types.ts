/**
 * @file Public type definitions shared by every runtime (Node, browser, middleware).
 *
 * The two headline interfaces — {@link OptimizationOptions} and
 * {@link OptimizationResponse} — are the exact contracts from the spec. Anything
 * beyond them is additive (extra optional fields / sibling types) so the
 * contract stays stable.
 */

/* ------------------------------------------------------------------------- */
/* Spec contracts                                                            */
/* ------------------------------------------------------------------------- */

export type ImageOutputFormat = 'webp' | 'avif' | 'jpeg' | 'png' | 'auto';
export type VideoPreset = 'ultrafast' | 'superfast' | 'fast' | 'medium';

/** Image-only knobs. Ignored when the detected media is a video. */
export interface ImageSettings {
  /** 1-100. Default 80. */
  quality?: number;
  /** Target format. `'auto'` encodes several candidates and keeps the smallest. */
  format?: ImageOutputFormat;
  /** Pixel-exact output (WebP/AVIF/PNG lossless). JPEG cannot be lossless. */
  lossless?: boolean;
}

/** Video-only knobs. Ignored when the detected media is an image. */
export interface VideoSettings {
  /** 0-51 (x264 scale). Default 28. Rescaled internally to 0-63 for VP9. */
  crf?: number;
  /** Encoder speed/efficiency trade-off. Default `'fast'`. */
  preset?: VideoPreset;
  /** e.g. `'64k'`. Must match /^\d{2,3}k$/ and lie in 16k-320k. Default `'96k'`. */
  audioBitrate?: string;
  /** Drop every audio stream. */
  removeAudio?: boolean;
}

export interface OptimizationOptions {
  /** `'auto'` detects the type from magic numbers (never from extensions). */
  mediaType: 'image' | 'video' | 'auto';
  imageSettings?: ImageSettings;
  videoSettings?: VideoSettings;
}

export interface OptimizationResponse<T> {
  success: boolean;
  /** Bytes. */
  originalSize: number;
  /** Bytes. */
  optimizedSize: number;
  /** Size reduction, e.g. `"75.4%"`. Negative when the output grew. */
  compressionRatio: string;
  /** Output format / container, e.g. `"webp"`, `"mp4"`. */
  format: string;
  /** Same *container* as the input: Buffer→Buffer, Blob→Blob, base64→base64, path→path, URL→data URL. */
  data: T;
  message: string;
}

/** Standard failure envelope (returned by middleware and `optimizeSafe`). */
export interface OptimizationErrorResponse {
  success: false;
  error: string;
  /** HTTP-compatible status code. */
  code: number;
}

/* ------------------------------------------------------------------------- */
/* Additive types                                                            */
/* ------------------------------------------------------------------------- */

export type MediaKind = 'image' | 'video';

/** Formats the magic-number sniffer is willing to accept. Everything else is rejected. */
export type DetectedFormat =
  | 'jpeg' | 'png' | 'gif' | 'webp' | 'avif' | 'tiff'
  | 'mp4' | 'mov' | 'webm' | 'mkv' | 'avi';

export interface DetectedMedia {
  kind: MediaKind;
  format: DetectedFormat;
  mime: string;
  /** Present when the header could be parsed cheaply (images only). */
  width?: number;
  height?: number;
}

/** Extra facts about the result. Lives beside, not inside, the spec interface. */
export interface OptimizationDetails {
  mediaType: MediaKind;
  inputFormat: DetectedFormat;
  mimeType: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  /** Set when an encoder constraint forced a change (e.g. odd dimensions → even for H.264). */
  warnings: string[];
}

export interface DetailedOptimizationResponse<T> extends OptimizationResponse<T> {
  details: OptimizationDetails;
}

/**
 * Accepted inputs. Strings are *never* guessed (a bare string could be a path,
 * a URL or base64 — guessing is how path-traversal bugs are born), so string
 * sources must be tagged. The one exception is a `data:` URL, which is
 * unambiguous.
 */
export type MediaInput =
  | Uint8Array // includes Node Buffer
  | ArrayBuffer
  | Blob
  | `data:${string}`
  | { base64: string }
  | { url: string }
  | { path: string };

/** Maps an input type to the type of `response.data`. */
export type OutputFor<I> =
  I extends { path: string } ? string :
  I extends { url: string } ? `data:${string}` :
  I extends { base64: string } ? string :
  I extends `data:${string}` ? `data:${string}` :
  I extends Blob ? Blob :
  I extends ArrayBuffer ? ArrayBuffer :
  I extends Uint8Array ? Uint8Array :
  unknown;

/** Hard security limits. Every field has a conservative default. */
export interface SecurityLimits {
  /** Max bytes accepted for any image input. Default 25 MiB. */
  maxImageBytes: number;
  /** Max bytes accepted for any video input. Default 500 MiB (Node) / 200 MiB (browser). */
  maxVideoBytes: number;
  /** Max width or height in pixels. Default 8192. */
  maxDimension: number;
  /** Max total pixels (w*h). Default 8192*8192. */
  maxPixels: number;
  /** Max frames for animated images. Default 1000. */
  maxAnimationFrames: number;
  /** Max video duration in seconds. Default 600. */
  maxVideoDurationSeconds: number;
  /** Per-attempt network timeout. Default 10 000 ms. */
  fetchTimeoutMs: number;
  /** Retry attempts for transient network failures. Default 3. */
  fetchRetries: number;
  /** Max redirects followed (each hop is re-validated). Default 3. */
  maxRedirects: number;
  /** Ports allowed in URLs. Default [80, 443]. */
  allowedPorts: number[];
  /** Hard ceiling for one image job. Default 60 s. */
  imageTimeoutMs: number;
  /** Hard ceiling for one video job. Default 10 min. */
  videoTimeoutMs: number;
}

export interface ConcurrencyConfig {
  /** Parallel image jobs. */
  maxImageJobs: number;
  /** Parallel video jobs (ffmpeg is CPU-bound — keep this small). */
  maxVideoJobs: number;
  /** Jobs allowed to wait in each queue before new ones are rejected with 503. */
  maxQueue: number;
}
