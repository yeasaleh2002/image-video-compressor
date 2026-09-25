export type ImageOutputFormat = 'webp' | 'avif' | 'jpeg' | 'png' | 'auto';
export type VideoPreset = 'ultrafast' | 'superfast' | 'fast' | 'medium';

export interface ImageSettings {
  quality?: number;
  format?: ImageOutputFormat;
  lossless?: boolean;
}

export interface VideoSettings {
  crf?: number;
  preset?: VideoPreset;
  audioBitrate?: string;
  removeAudio?: boolean;
}

export interface OptimizationOptions {
  mediaType: 'image' | 'video' | 'auto';
  imageSettings?: ImageSettings;
  videoSettings?: VideoSettings;
}

export interface OptimizationResponse<T> {
  success: boolean;
  originalSize: number;
  optimizedSize: number;
  compressionRatio: string;
  format: string;
  data: T;
  message: string;
}

export interface OptimizationErrorResponse {
  success: false;
  error: string;
  code: number;
}

export type MediaKind = 'image' | 'video';

export type DetectedFormat =
  | 'jpeg' | 'png' | 'gif' | 'webp' | 'avif' | 'tiff'
  | 'mp4' | 'mov' | 'webm' | 'mkv' | 'avi';

export interface DetectedMedia {
  kind: MediaKind;
  format: DetectedFormat;
  mime: string;
  width?: number;
  height?: number;
}

export interface OptimizationDetails {
  mediaType: MediaKind;
  inputFormat: DetectedFormat;
  mimeType: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  warnings: string[];
}

export interface DetailedOptimizationResponse<T> extends OptimizationResponse<T> {
  details: OptimizationDetails;
}

export type MediaInput =
  | Uint8Array
  | ArrayBuffer
  | Blob
  | `data:${string}`
  | { base64: string }
  | { url: string }
  | { path: string };

export type OutputFor<I> =
  I extends { path: string } ? string :
  I extends { url: string } ? `data:${string}` :
  I extends { base64: string } ? string :
  I extends `data:${string}` ? `data:${string}` :
  I extends Blob ? Blob :
  I extends ArrayBuffer ? ArrayBuffer :
  I extends Uint8Array ? Uint8Array :
  unknown;

export interface SecurityLimits {
  maxImageBytes: number;
  maxVideoBytes: number;
  maxDimension: number;
  maxPixels: number;
  maxAnimationFrames: number;
  maxVideoDurationSeconds: number;
  fetchTimeoutMs: number;
  fetchRetries: number;
  maxRedirects: number;
  allowedPorts: number[];
  imageTimeoutMs: number;
  videoTimeoutMs: number;
}

export interface ConcurrencyConfig {
  maxImageJobs: number;
  maxVideoJobs: number;
  maxQueue: number;
}
