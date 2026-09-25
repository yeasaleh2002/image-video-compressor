/**
 * @file The runtime-agnostic orchestrator.
 *
 * Pipeline for every call:
 *
 *   options ──► normalizeOptions (reject unknown keys, clamp ranges)
 *   input   ──► platform.ingest   (size cap BEFORE buffering → magic numbers →
 *                                  header dimensions → mediaType cross-check)
 *           ──► limiter.run       (bounded queue, per-job deadline + abort)
 *           ──► adapter.optimize  (sharp / canvas / ffmpeg / ffmpeg.wasm,
 *                                  metadata stripped, dimensions preserved)
 *           ──► platform.emit     (same container shape as the input)
 *   finally ──► workspace.dispose (temp files removed on success AND failure)
 */
import type { EncodeResult, Platform } from '../adapters/types.js';
import { OptimizerError, ProcessingError, toErrorResponse } from '../errors.js';
import { SecurityGuard } from '../security/SecurityGuard.js';
import type {
  ConcurrencyConfig, DetailedOptimizationResponse, MediaInput, OptimizationErrorResponse,
  OptimizationOptions, OutputFor, SecurityLimits,
} from '../types.js';
import { ConcurrencyLimiter } from './limiter.js';
import { compressionRatio } from './util.js';

export interface MediaOptimizerConfig {
  limits?: Partial<SecurityLimits>;
  concurrency?: Partial<ConcurrencyConfig>;
}

export class MediaOptimizer {
  readonly guard: SecurityGuard;
  private readonly imageLimiter: ConcurrencyLimiter;
  private readonly videoLimiter: ConcurrencyLimiter;

  constructor(
    private readonly platform: Platform,
    config: MediaOptimizerConfig & { concurrency: ConcurrencyConfig },
  ) {
    this.guard = new SecurityGuard(config.limits);
    const c = config.concurrency;
    this.imageLimiter = new ConcurrencyLimiter(c.maxImageJobs, c.maxQueue);
    this.videoLimiter = new ConcurrencyLimiter(c.maxVideoJobs, c.maxQueue);
  }

  /** Queue depth, for health checks / autoscaling metrics. */
  get stats() {
    return { image: this.imageLimiter.stats, video: this.videoLimiter.stats };
  }

  /**
   * Optimizes one image or video.
   *
   * @throws {OptimizerError} subclasses on any validation, security or processing failure.
   *
   * @example
   * const res = await optimizer.optimize({ path: 'uploads/cat.jpg' }, {
   *   mediaType: 'auto', imageSettings: { format: 'auto', quality: 75 },
   * });
   * res.data; // → 'uploads/cat-optimized-1f2e3d4c.avif'
   */
  async optimize<I extends MediaInput>(
    input: I,
    options: OptimizationOptions = { mediaType: 'auto' },
  ): Promise<DetailedOptimizationResponse<OutputFor<I>>> {
    const opts = this.guard.normalizeOptions(options);
    const ws = await this.platform.createWorkspace();
    // Ingestion (downloads, file reads) gets its own deadline so a slow-loris
    // upstream can't hold a workspace open forever.
    const ingestAbort = new AbortController();
    const ingestTimer = setTimeout(
      () => ingestAbort.abort(new ProcessingError('Input ingestion timed out')),
      this.guard.limits.fetchTimeoutMs * (this.guard.limits.fetchRetries + 1) + 30_000,
    );

    try {
      const ingested = await this.platform.ingest(input, ws, opts.mediaType, ingestAbort.signal);
      clearTimeout(ingestTimer);
      const { detected, source, size } = ingested;
      this.guard.assertDetected(detected, opts.mediaType, size);

      let result: EncodeResult;
      if (detected.kind === 'image') {
        result = await this.imageLimiter.run(
          (signal) => this.platform.image.optimize(source, detected, opts.image, { signal, guard: this.guard, workspace: ws }),
          this.guard.limits.imageTimeoutMs,
        );
      } else {
        result = await this.videoLimiter.run(
          (signal) => this.platform.video.optimize(source, detected, opts.video, { signal, guard: this.guard, workspace: ws }),
          this.guard.limits.videoTimeoutMs,
        );
      }

      const data = (await this.platform.emit(input, result, ws)) as OutputFor<I>;
      const optimizedSize = result.output.type === 'bytes' ? result.output.bytes.byteLength : result.output.size;
      const ratio = compressionRatio(size, optimizedSize);
      const grew = optimizedSize >= size;

      return {
        success: true,
        originalSize: size,
        optimizedSize,
        compressionRatio: ratio,
        format: result.format,
        data,
        message: grew
          ? `Sanitized ${detected.kind}; output is not smaller than the input (${ratio}). Try a lower quality / higher CRF.`
          : `Optimized ${detected.kind} ${detected.format} → ${result.format}, saved ${ratio}`,
        details: {
          mediaType: detected.kind,
          inputFormat: detected.format,
          mimeType: result.mime,
          width: result.width,
          height: result.height,
          durationSeconds: result.durationSeconds,
          warnings: result.warnings,
        },
      };
    } catch (err) {
      if (err instanceof OptimizerError) throw err;
      // Unknown failures are wrapped so callers only ever see our taxonomy
      // (the original is kept as `cause` for server-side logging).
      throw new ProcessingError(undefined, { cause: err });
    } finally {
      clearTimeout(ingestTimer);
      await ws.dispose();
    }
  }

  /**
   * Like {@link optimize} but never throws: returns the success response or
   * the standard `{ success: false, error, code }` envelope.
   */
  async optimizeSafe<I extends MediaInput>(
    input: I,
    options?: OptimizationOptions,
  ): Promise<DetailedOptimizationResponse<OutputFor<I>> | OptimizationErrorResponse> {
    try {
      return await this.optimize(input, options);
    } catch (err) {
      return toErrorResponse(err);
    }
  }
}
