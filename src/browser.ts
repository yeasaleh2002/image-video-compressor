/**
 * @file Browser entry point (selected automatically by bundlers via the
 * `"browser"` export condition, or import `image-video-compressor/browser`).
 */
import { BrowserPlatform } from './browser/BrowserPlatform.js';
import type { WasmFfmpegConfig } from './browser/WasmFfmpegVideoAdapter.js';
import { MediaOptimizer, type MediaOptimizerConfig } from './core/MediaOptimizer.js';
import { SecurityGuard } from './security/SecurityGuard.js';

export interface BrowserOptimizerConfig extends MediaOptimizerConfig {
  /** Self-hosted `@ffmpeg/core` asset URLs (recommended for CSP and offline use). */
  ffmpeg?: WasmFfmpegConfig;
}

/**
 * Creates a browser optimizer. Create it once (e.g. module scope or a React
 * context) so the ffmpeg.wasm worker is loaded once and reused.
 */
export function createBrowserOptimizer(config: BrowserOptimizerConfig = {}): MediaOptimizer {
  // Tab memory is limited and ffmpeg.wasm holds input + output in its heap (2 GiB max).
  const guard = new SecurityGuard({ maxVideoBytes: 200 * 1024 * 1024, ...config.limits });
  return new MediaOptimizer(new BrowserPlatform(guard, config.ffmpeg), {
    limits: guard.limits,
    concurrency: {
      maxImageJobs: config.concurrency?.maxImageJobs ?? 2,
      maxVideoJobs: 1, // single ffmpeg.wasm worker: one exec at a time
      maxQueue: config.concurrency?.maxQueue ?? 10,
    },
  });
}

export { MediaOptimizer } from './core/MediaOptimizer.js';
export { SecurityGuard, DEFAULT_LIMITS } from './security/SecurityGuard.js';
export { detectMedia } from './security/magic.js';
export * from './errors.js';
export type * from './types.js';
