import type { NormalizedOptions, SecurityGuard } from '../security/SecurityGuard.js';
import type { DetectedMedia, MediaInput } from '../types.js';

export type MediaSource =
  | { type: 'bytes'; bytes: Uint8Array }
  | { type: 'file'; path: string; size: number };

export interface EncodeResult {
  output: MediaSource;
  format: string;
  mime: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  warnings: string[];
}

export interface Workspace {
  tempPath(ext: string): string;
  dispose(): Promise<void>;
}

export interface JobContext {
  signal: AbortSignal;
  guard: SecurityGuard;
  workspace: Workspace;
}

export interface ImageAdapter {
  optimize(src: MediaSource, detected: DetectedMedia, opts: NormalizedOptions['image'], ctx: JobContext): Promise<EncodeResult>;
}

export interface VideoAdapter {
  optimize(src: MediaSource, detected: DetectedMedia, opts: NormalizedOptions['video'], ctx: JobContext): Promise<EncodeResult>;
}

export interface Ingested {
  source: MediaSource;
  size: number;
  detected: DetectedMedia;
}

export interface Platform {
  image: ImageAdapter;
  video: VideoAdapter;
  createWorkspace(): Promise<Workspace>;
  ingest(input: MediaInput, ws: Workspace, requested: NormalizedOptions['mediaType'], signal: AbortSignal): Promise<Ingested>;
  emit(input: MediaInput, result: EncodeResult, ws: Workspace): Promise<unknown>;
}
