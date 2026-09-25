import { BrowserPlatform } from './browser/BrowserPlatform.js';
import type { WasmFfmpegConfig } from './browser/WasmFfmpegVideoAdapter.js';
import { MediaOptimizer, type MediaOptimizerConfig } from './core/MediaOptimizer.js';
import { SecurityGuard } from './security/SecurityGuard.js';

export interface BrowserOptimizerConfig extends MediaOptimizerConfig {
  ffmpeg?: WasmFfmpegConfig;
}

export function createBrowserOptimizer(config: BrowserOptimizerConfig = {}): MediaOptimizer {
  const guard = new SecurityGuard({ maxVideoBytes: 200 * 1024 * 1024, ...config.limits });
  return new MediaOptimizer(new BrowserPlatform(guard, config.ffmpeg), {
    limits: guard.limits,
    concurrency: {
      maxImageJobs: config.concurrency?.maxImageJobs ?? 2,
      maxVideoJobs: 1,
      maxQueue: config.concurrency?.maxQueue ?? 10,
    },
  });
}

export { MediaOptimizer } from './core/MediaOptimizer.js';
export { SecurityGuard, DEFAULT_LIMITS } from './security/SecurityGuard.js';
export { detectMedia } from './security/magic.js';
export * from './errors.js';
export type * from './types.js';
