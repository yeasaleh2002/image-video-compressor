/**
 * @file Node.js entry point (`import … from 'image-video-compressor'` in Node).
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import sharp from 'sharp';
import { MediaOptimizer, type MediaOptimizerConfig } from './core/MediaOptimizer.js';
import { NodePlatform, type NodePlatformConfig } from './node/NodePlatform.js';
import { SecurityGuard } from './security/SecurityGuard.js';
import type { ConcurrencyConfig } from './types.js';

export interface NodeOptimizerConfig extends MediaOptimizerConfig, Omit<NodePlatformConfig, 'maxVideoJobs'> {}

/** Finds bundled binaries from the optional `ffmpeg-static` / `ffprobe-static` packages. */
function bundledBinaries(): { ffmpegPath?: string; ffprobePath?: string } {
  const require = createRequire(import.meta.url);
  const out: { ffmpegPath?: string; ffprobePath?: string } = {};
  try { out.ffmpegPath = (require('ffmpeg-static') as string | null) ?? undefined; } catch { /* use $PATH */ }
  try { out.ffprobePath = (require('ffprobe-static') as { path?: string }).path; } catch { /* use $PATH */ }
  return out;
}

/**
 * Creates a Node optimizer. Create **one per process** and share it: the
 * concurrency limits are per instance.
 *
 * @example
 * const optimizer = createNodeOptimizer({ allowedRoots: ['./uploads'] });
 * const res = await optimizer.optimize({ path: 'photo.jpg' }, { mediaType: 'auto' });
 */
export function createNodeOptimizer(config: NodeOptimizerConfig = {}): MediaOptimizer {
  const cpus = os.availableParallelism();
  const concurrency: ConcurrencyConfig = {
    maxImageJobs: config.concurrency?.maxImageJobs ?? Math.max(1, Math.min(4, cpus)),
    maxVideoJobs: config.concurrency?.maxVideoJobs ?? Math.max(1, Math.floor(cpus / 4)),
    maxQueue: config.concurrency?.maxQueue ?? 50,
  };

  // libvips: no operation cache (it's a memory leak under varied input) and
  // split the thread pool between concurrent image jobs.
  sharp.cache(false);
  sharp.concurrency(Math.max(1, Math.floor(cpus / concurrency.maxImageJobs)));

  const guard = new SecurityGuard(config.limits);
  const bins = bundledBinaries();
  const platform = new NodePlatform(guard, {
    ...config,
    ffmpegPath: config.ffmpegPath ?? bins.ffmpegPath,
    ffprobePath: config.ffprobePath ?? bins.ffprobePath,
    maxVideoJobs: concurrency.maxVideoJobs,
  });
  return new MediaOptimizer(platform, { limits: guard.limits, concurrency });
}

export { MediaOptimizer } from './core/MediaOptimizer.js';
export { SecurityGuard, DEFAULT_LIMITS } from './security/SecurityGuard.js';
export { detectMedia } from './security/magic.js';
export { isBlockedIp } from './security/ip.js';
export * from './errors.js';
export type * from './types.js';
