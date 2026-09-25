/**
 * @file Adapter contracts. `MediaOptimizer` (the core) only talks to these
 * interfaces; each runtime supplies its own implementations:
 *
 * | Concern  | Node                        | Browser                              |
 * |----------|-----------------------------|--------------------------------------|
 * | Images   | `SharpImageAdapter`         | `CanvasImageAdapter`                 |
 * | Video    | `FluentFfmpegVideoAdapter`  | `WasmFfmpegVideoAdapter`             |
 * | I/O      | `NodePlatform` (fs, http)   | `BrowserPlatform` (fetch, Blob)      |
 */
import type { NormalizedOptions, SecurityGuard } from '../security/SecurityGuard.js';
import type { DetectedMedia, MediaInput } from '../types.js';

/**
 * Where media bytes currently live. Images are always `bytes` (they are small
 * and capped). Videos in Node are `file` so they are never fully buffered.
 */
export type MediaSource =
  | { type: 'bytes'; bytes: Uint8Array }
  | { type: 'file'; path: string; size: number };

export interface EncodeResult {
  output: MediaSource;
  /** Short format name, e.g. `webp`, `mp4`. */
  format: string;
  mime: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  warnings: string[];
}

/** Per-job scratch space. Node: a private `mkdtemp` directory. Browser: no-op. */
export interface Workspace {
  /** Collision-free path for a new temp file (Node only). */
  tempPath(ext: string): string;
  /** Removes everything the job created. Safe to call more than once; never throws. */
  dispose(): Promise<void>;
}

export interface JobContext {
  /** Fires on timeout. Adapters MUST abort work (kill processes) when it fires. */
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

/** Result of ingesting + validating untrusted input. */
export interface Ingested {
  source: MediaSource;
  size: number;
  detected: DetectedMedia;
}

/**
 * Everything runtime-specific. The core is written purely against this.
 */
export interface Platform {
  image: ImageAdapter;
  video: VideoAdapter;
  createWorkspace(): Promise<Workspace>;
  /** Loads, size-checks and magic-number-sniffs the input without trusting any declared type. */
  ingest(input: MediaInput, ws: Workspace, requested: NormalizedOptions['mediaType'], signal: AbortSignal): Promise<Ingested>;
  /** Produces `data` in the same container shape the caller passed in. */
  emit(input: MediaInput, result: EncodeResult, ws: Workspace): Promise<unknown>;
}
